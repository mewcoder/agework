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
import { errorLogFields } from "../../common/logging";

type OwnerInstance =
  | { status: "pending"; promise: Promise<AcquireInstanceResult> }
  | {
      status: "ready";
      workerId: string;
      runtimeInstanceId: string;
      isolationScope: string;
      runtimeType: string;
    };

/** owners Map 的复合 key: (ownerId, runtimeId, isolationScope)。
 * 推翻 wm-0003 的裸 ownerId key——同一 owner 跨 runtime/scope 可并行多个 worker。
 * 用 NUL 作分隔符(三个值都是 id/枚举,永不含 NUL),避免拼接歧义。 */
function ownerKey(
  ownerId: string,
  runtimeId: string,
  isolationScope: string
): string {
  return `${ownerId}\u0000${runtimeId}\u0000${isolationScope}`;
}

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
    const targetRuntimeId = input.targetRuntimeId;
    const { isolationScope } = this.identity(input);
    const key = ownerKey(ownerId, targetRuntimeId, isolationScope);
    const existing = this.owners.get(key);
    if (existing?.status === "ready") {
      return Promise.resolve({
        outcome: "ready",
        workerId: existing.workerId,
        runtimeInstanceId: existing.runtimeInstanceId,
      });
    }
    if (existing?.status === "pending") return existing.promise;

    const promise = this.launch(input);
    this.owners.set(key, { status: "pending", promise });
    return promise;
  }

  private async launch(
    input: WorkerExecutionStartInput
  ): Promise<AcquireInstanceResult> {
    const { runtimeTarget, runConfig } = input;
    const ownerId = runtimeTarget.ownerId;
    const { runtimeType, isolationScope } = this.identity(input);
    const startToken = randomUUID();
    const workerId = randomUUID();
    const targetRuntimeId = input.targetRuntimeId;
    const key = ownerKey(ownerId, targetRuntimeId, isolationScope);

    try {
      const insert = await this.registry.insertStarting(
        {
          runtimeType,
          isolationScope,
          workspaceId: runConfig.workspaceId,
          ownerId,
        },
        workerId,
        "", // instanceId placeholder, will be updated after provider.start()
        "http",
        startToken,
        targetRuntimeId
      );
      if (!insert.ok) {
        if (insert.existing.status === "running") {
          this.owners.set(key, {
            status: "ready",
            workerId: insert.existing.workerId,
            runtimeInstanceId: insert.existing.runtimeInstanceId,
            isolationScope,
            runtimeType,
          });
          return {
            outcome: "ready",
            workerId: insert.existing.workerId,
            runtimeInstanceId: insert.existing.runtimeInstanceId,
          };
        }
        this.owners.delete(key);
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
          workerId,
          runtimeType,
          isolationScope
        ),
        expectedRuntimeInstanceId,
      };

      const onWorkerExit = () => {
        this.owners.delete(key);
        void Promise.resolve(
          this.registry.markStoppedByOwner(runtimeType, isolationScope, ownerId)
        ).catch(
          swallow(this.logger, `mark stopped on exit for worker ${workerId}`)
        );
      };

      const { runtimeInstanceId } = await withTimeout(
        (async () => {
          const launched = await this.runtimeService
            .runtimeFor(targetRuntimeId)
            .start(ctx, onWorkerExit);
          await this.handshakeStore.waitForRegister(workerId, startToken);
          return launched;
        })(),
        this.configService.getLaunchTimeoutSeconds() * 1000,
        `worker launch timed out for worker ${workerId}`
      );

      await this.registry
        .upsertRunning(
          {
            runtimeType,
            isolationScope,
            workspaceId: runConfig.workspaceId,
            ownerId,
          },
          workerId,
          runtimeInstanceId,
          "http",
          targetRuntimeId
        )
        .catch(swallow(this.logger, `upsert running for owner ${ownerId}`));

      this.owners.set(key, {
        status: "ready",
        workerId,
        runtimeInstanceId,
        isolationScope,
        runtimeType,
      });
      return { outcome: "ready", workerId, runtimeInstanceId };
    } catch (err) {
      this.handshakeStore.cancel(
        workerId,
        `worker launch failed for worker ${workerId}`
      );
      await this.registry
        .markErrorByOwner(runtimeType, isolationScope, ownerId)
        .catch(swallow(this.logger, `mark launch error for worker ${workerId}`));
      this.owners.delete(key);
      this.logger.warn("worker launch failed", {
        workerId,
        runtimeType,
        ...errorLogFields(err),
      });
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
    if (ref.targetRuntimeId) {
      this.owners.delete(
        ownerKey(ref.ownerId, ref.targetRuntimeId, ref.isolationScope)
      );
    }
    this.commandDispatcher.cleanupByWorkerId(ref.workerId);
    // Promise.resolve().then(...) 而不是 Promise.resolve(runtimeAction(ref)):
    // runtimeAction 内部(requireTargetRuntimeId)可能同步 throw,同步 throw 发生在
    // Promise.resolve(...) 求值参数阶段,不会被后面的 .catch() 接住,会导致 finalize
    // 直接 reject、跳过下面必须执行的 markStoppedByOwner 清理。放进 .then() 回调里
    // 执行,同步 throw 才会正确变成 rejected promise、被 .catch() 吞掉。
    await Promise.resolve()
      .then(() => runtimeAction(ref))
      .catch(swallow(this.logger, `provider teardown for worker ${ref.workerId}`));
    await this.registry
      .markStoppedByOwner(ref.runtimeType, ref.isolationScope, ref.ownerId)
      .catch(swallow(this.logger, `mark stopped for worker ${ref.workerId}`));
  }

  private identity(input: WorkerExecutionStartInput): {
    runtimeType: RuntimeType;
    isolationScope: string;
  } {
    const target = input.runtimeTarget;
    const isolationScope =
      target.runtimeType !== "native"
        ? target.sandbox.isolationScope
        : "workspace";
    return { runtimeType: target.runtimeType, isolationScope };
  }

  private buildWorkerEnv(
    input: WorkerExecutionStartInput,
    startToken: string,
    workerId: string,
    runtimeType: string,
    isolationScope: string
  ): Record<string, string> {
    const { runConfig } = input;
    const env: Record<string, string> = {
      AGEWORK_WORKER_ROLE: "worker",
      AGEWORK_WORKER_OWNER_ID: input.runtimeTarget.ownerId,
      AGEWORK_WORKER_ID: workerId,
      AGEWORK_WORKER_START_TOKEN: startToken,
      AGEWORK_WORKER_RUNTIME_TYPE: runtimeType,
      AGEWORK_WORKER_ISOLATION_SCOPE: isolationScope,
    };
    if (runConfig.workerLogFilePath) {
      env.AGEWORK_WORKER_LOG_FILE = runConfig.workerLogFilePath;
    }
    // 文件预览:worker 需要知道自身工作区根目录来解析相对路径。
    // runtimePath 是执行环境内的路径(local=hostPath, container=mountTarget)。
    env.AGEWORK_WORKER_WORKSPACE_PATH = input.runtimeTarget.runtimePath;
    // local runtime 从 envConfig 提取的 CLI 路径传播到 worker env。
    // worker 侧 resolveCliPaths 读 env 优先，见 ADR-0004。
    if (runConfig.claudeExecutablePath) {
      env.AGEWORK_CLAUDE_CLI_PATH = runConfig.claudeExecutablePath;
    }
    if (runConfig.codexExecutablePath) {
      env.AGEWORK_CODEX_CLI_PATH = runConfig.codexExecutablePath;
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
