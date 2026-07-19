import type {
  RuntimeInstanceRef,
  RuntimeProvider,
} from "@agework/runtime-sdk";
import type { WorkerScope } from "@agework/shared/protocol";

export type ReleaseCleanupContext =
  | { target: { type: "workspace"; workspaceId: string } }
  | {
      target: { type: "user"; userId: string };
      userLifecycleVersion: number;
    };

export type CleanupMetadata = {
  scope: WorkerScope;
  subjectId: string;
  userId: string;
  userLifecycleVersion: number;
  workspaceIds: string[];
};

export type CleanupRecord = CleanupMetadata & {
  ref: RuntimeInstanceRef;
  /** 缺省表示 Runtime 内部 orphan cleanup，不是业务撤权 claim。 */
  release?: ReleaseCleanupContext;
};

type PendingCleanup = CleanupRecord & {
  cleanup: () => Promise<void> | void;
  inFlight?: Promise<void>;
};

function cleanupKey(ref: RuntimeInstanceRef): string {
  return JSON.stringify([ref.runtimeType, ref.runtimeInstanceId]);
}

/**
 * Provider 资源清理账本。
 *
 * 资源引用会在调用 provider 前写入；同一实例的并发清理由同一个 Promise
 * 串行化。失败保留记录供 lifecycle reconciliation 重放，成功后才清账。
 */
export class CleanupLedger {
  private readonly pending = new Map<string, PendingCleanup>();

  run(
    ref: RuntimeInstanceRef,
    metadata: CleanupMetadata,
    provider: RuntimeProvider,
    mode: "release" | "destroy",
    release?: ReleaseCleanupContext
  ): Promise<void> {
    const key = cleanupKey(ref);
    let record = this.pending.get(key);
    if (!record) {
      record = {
        ref,
        ...metadata,
        release,
        cleanup: () => provider[mode](ref),
      };
      // write-ahead：从这里开始，其它 release 一定能看到该实例。
      this.pending.set(key, record);
    }
    // cleanup-only 若后来被真实 lifecycle release 命中，应保留该原始业务 target。
    record.release ??= release;
    return this.execute(key, record);
  }

  async retry(
    predicate: (record: CleanupRecord) => boolean,
    release?: ReleaseCleanupContext
  ): Promise<void> {
    const matching = [...this.pending.entries()].filter(([, record]) =>
      predicate(record)
    );
    for (const [key, record] of matching) {
      record.release ??= release;
      await this.execute(key, record);
    }
  }

  /**
   * Runtime 内部 orphan cleanup 重试。逐条 all-settled：失败记录继续留账，
   * 同一轮其它实例仍可推进；execute 自身继续提供实例级 singleflight。
   */
  async retryCleanupOnly(): Promise<void> {
    const matching = [...this.pending.entries()].filter(
      ([, record]) => !record.release
    );
    await Promise.allSettled(
      matching.map(([key, record]) => this.execute(key, record))
    );
  }

  list(): CleanupRecord[] {
    return [...this.pending.values()].map(({ inFlight: _, cleanup: __, ...record }) =>
      record
    );
  }

  private execute(key: string, record: PendingCleanup): Promise<void> {
    if (record.inFlight) return record.inFlight;

    // then() 同时捕获 async rejection 与 provider 的同步 throw。
    const inFlight = Promise.resolve()
      .then(record.cleanup)
      .then(
        () => {
          if (this.pending.get(key) === record) {
            this.pending.delete(key);
          }
        },
        (error) => {
          if (record.inFlight === inFlight) {
            record.inFlight = undefined;
          }
          throw error;
        }
      );
    record.inFlight = inFlight;
    return inFlight;
  }
}
