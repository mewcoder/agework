import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type {
  AcquireInstanceResult,
  WorkerExecutionStartInput,
} from "@agework/shared/protocol";
import type {
  RuntimeInstanceRef,
  RuntimeLaunchContext,
  RuntimeType,
} from "@agework/providers";
import { RuntimeService } from "../../runtime/runtime.service";
import { WorkerRegistryRepository } from "../registry/worker-registry.repository";
import { WorkerHandshakeStore } from "../connection/worker-handshake.store";
import { WorkerCommandDispatcher } from "../connection/command-dispatcher";
import { ConfigService } from "../../config/config.service";
import { withTimeout } from "../../common/with-timeout";
import { swallow } from "../../common/swallow";
import { errorLogFields, safeLogJson } from "../../common/logging";

type OwnerInstance =
  | { status: "pending"; promise: Promise<AcquireInstanceResult> }
  | {
      status: "ready";
      runtimeInstanceId: string;
      isolationScope: string;
      runtimeType: string;
    };

/** worker 实例编排(泛型,不认识 runtimeType):两个旧 executor 复制的启动握手
 *  序列的唯一副本。无回收(引用计数/idle/settle 全砍)。 */
@Injectable()
export class WorkerProvisioner {
  private readonly logger = new Logger(WorkerProvisioner.name);
  private readonly owners = new Map<string, OwnerInstance>();

  constructor(
    private readonly runtimeService: RuntimeService,
    private readonly registry: WorkerRegistryRepository,
    private readonly handshakeStore: WorkerHandshakeStore,
    private readonly commandDispatcher: WorkerCommandDispatcher,
    private readonly configService: ConfigService
  ) {}

  acquireInstanceForRun(
    input: WorkerExecutionStartInput
  ): Promise<AcquireInstanceResult> {
    const ownerId = input.runtimeTarget.ownerId;
    const existing = this.owners.get(ownerId);
    if (existing?.status === "ready") {
      return Promise.resolve({
        outcome: "ready",
        runtimeInstanceId: existing.runtimeInstanceId,
      });
    }
    if (existing?.status === "pending") return existing.promise;

    const promise = this.launch(input);
    this.owners.set(ownerId, { status: "pending", promise });
    return promise;
  }

  private async launch(
    input: WorkerExecutionStartInput
  ): Promise<AcquireInstanceResult> {
    const { runtimeTarget, runConfig } = input;
    const ownerId = runtimeTarget.ownerId;
    const { runtimeType, isolationScope } = this.identity(input);
    const startToken = randomUUID();
    const targetRuntimeId = input.targetRuntimeId;

    try {
      const insert = await this.registry.insertStarting(
        {
          runtimeType,
          isolationScope,
          workspaceId: runConfig.workspaceId,
          ownerId,
        },
        randomUUID(),
        "http",
        startToken,
        targetRuntimeId
      );
      if (!insert.ok) {
        if (insert.existing.status === "running") {
          this.owners.set(ownerId, {
            status: "ready",
            runtimeInstanceId: insert.existing.runtimeInstanceId,
            isolationScope,
            runtimeType,
          });
          return {
            outcome: "ready",
            runtimeInstanceId: insert.existing.runtimeInstanceId,
          };
        }
        this.owners.delete(ownerId);
        return {
          outcome: "error",
          error: `owner ${ownerId} has a concurrent launch already starting`,
        };
      }

      const binding = await this.registry.findBindingWithResource(
        runConfig.workspaceId
      );
      const expectedRuntimeInstanceId =
        binding && binding.worker.runtimeType === runtimeType
          ? binding.worker.instanceId
          : null;

      const ctx: RuntimeLaunchContext = {
        runtimeType,
        ownerId,
        workspaceId: runConfig.workspaceId,
        runId: runConfig.runId,
        placement: runtimeTarget,
        workerEnv: this.buildWorkerEnv(
          input,
          startToken,
          runtimeType,
          isolationScope
        ),
        expectedRuntimeInstanceId,
      };

      const onWorkerExit = () => {
        this.owners.delete(ownerId);
        void Promise.resolve(
          this.registry.markStoppedByOwner(runtimeType, isolationScope, ownerId)
        ).catch(
          swallow(this.logger, `mark stopped on exit for owner ${ownerId}`)
        );
      };

      const { runtimeInstanceId } = await withTimeout(
        (async () => {
          const launched = await this.runtimeService
            .runtimeFor(targetRuntimeId)
            .start(ctx, onWorkerExit);
          await this.handshakeStore.waitForRegister(ownerId, startToken);
          return launched;
        })(),
        this.configService.getLaunchTimeoutSeconds() * 1000,
        `worker launch timed out for owner ${ownerId}`
      );

      await this.registry
        .upsertRunning(
          {
            runtimeType,
            isolationScope,
            workspaceId: runConfig.workspaceId,
            ownerId,
          },
          runtimeInstanceId,
          "http",
          targetRuntimeId
        )
        .catch(swallow(this.logger, `upsert running for owner ${ownerId}`));

      this.owners.set(ownerId, {
        status: "ready",
        runtimeInstanceId,
        isolationScope,
        runtimeType,
      });
      return { outcome: "ready", runtimeInstanceId };
    } catch (err) {
      this.handshakeStore.cancel(
        ownerId,
        `worker launch failed for owner ${ownerId}`
      );
      await this.registry
        .markErrorByOwner(runtimeType, isolationScope, ownerId)
        .catch(swallow(this.logger, `mark launch error for owner ${ownerId}`));
      this.owners.delete(ownerId);
      this.logger.warn(
        `worker launch failed ${safeLogJson({ ownerId, runtimeType, ...errorLogFields(err) })}`
      );
      return {
        outcome: "error",
        error: `worker launch failed: ${String(err)}`,
      };
    }
  }

  /** owner 仍在(fence 判死 / admin 手动停):停 worker,保留载体。 */
  stop(ref: RuntimeInstanceRef): Promise<void> {
    return this.finalize(ref, (r) =>
      this.runtimeService.runtimeFor(requireTargetRuntimeId(r)).stop(r)
    );
  }

  /** owner 永久消失(删 workspace / user):删除载体。 */
  destroy(ref: RuntimeInstanceRef): Promise<void> {
    return this.finalize(ref, (r) =>
      this.runtimeService.runtimeFor(requireTargetRuntimeId(r)).destroy(r)
    );
  }

  /** 收尾公共编排:清内存态 + command dispatcher + provider 物理动作 + registry
   *  markStopped。ref 由调用方从 DB 行派生(重启后无内存态也能收尾)。 */
  private async finalize(
    ref: RuntimeInstanceRef,
    runtimeAction: (ref: RuntimeInstanceRef) => Promise<void> | void
  ): Promise<void> {
    this.owners.delete(ref.ownerId);
    this.commandDispatcher.cleanupByOwnerId(ref.ownerId);
    // Promise.resolve().then(...) 而不是 Promise.resolve(runtimeAction(ref)):
    // runtimeAction 内部(requireTargetRuntimeId)可能同步 throw,同步 throw 发生在
    // Promise.resolve(...) 求值参数阶段,不会被后面的 .catch() 接住,会导致 finalize
    // 直接 reject、跳过下面必须执行的 markStoppedByOwner 清理。放进 .then() 回调里
    // 执行,同步 throw 才会正确变成 rejected promise、被 .catch() 吞掉。
    await Promise.resolve()
      .then(() => runtimeAction(ref))
      .catch(swallow(this.logger, `provider teardown for owner ${ref.ownerId}`));
    await this.registry
      .markStoppedByOwner(ref.runtimeType, ref.isolationScope, ref.ownerId)
      .catch(swallow(this.logger, `mark stopped for owner ${ref.ownerId}`));
  }

  private identity(input: WorkerExecutionStartInput): {
    runtimeType: RuntimeType;
    isolationScope: string;
  } {
    const target = input.runtimeTarget;
    const isolationScope =
      target.runtimeType !== "local"
        ? target.sandbox.isolationScope
        : "workspace";
    return { runtimeType: target.runtimeType, isolationScope };
  }

  private buildWorkerEnv(
    input: WorkerExecutionStartInput,
    startToken: string,
    runtimeType: string,
    isolationScope: string
  ): Record<string, string> {
    const { runConfig } = input;
    const env: Record<string, string> = {
      AGEWORK_WORKER_ROLE: "worker",
      AGEWORK_WORKER_OWNER_ID: input.runtimeTarget.ownerId,
      AGEWORK_WORKER_START_TOKEN: startToken,
      AGEWORK_WORKER_RUNTIME_TYPE: runtimeType,
      AGEWORK_WORKER_ISOLATION_SCOPE: isolationScope,
    };
    if (runConfig.workerLogFilePath) {
      env.AGEWORK_WORKER_LOG_FILE = runConfig.workerLogFilePath;
    }
    return env;
  }
}

/**
 * `RuntimeInstanceRef.targetRuntimeId` 是可选的(该 ref 类型也被不认识 server
 * Runtime 概念的远程 manager 复用),但 server 侧构造的每一个 ref 都来自 Worker.runtimeId
 * 必填列,恒有值——这里收窄给 `RuntimeService.runtimeFor()` 用。
 */
function requireTargetRuntimeId(ref: RuntimeInstanceRef): string {
  if (!ref.targetRuntimeId) {
    throw new Error(
      `missing targetRuntimeId for owner ${ref.ownerId} (server-constructed ref should always have one)`
    );
  }
  return ref.targetRuntimeId;
}
