import { Injectable, Logger } from "@nestjs/common";
import type { ChildProcess } from "node:child_process";
import { generateId } from "@agework/shared";
import type {
  AcquireInstanceResult,
  WorkerExecutionStartInput,
} from "@agework/shared/protocol";
import { RuntimeService } from "../../runtime/runtime.service";
import { WorkerRegistryRepository } from "../registry/worker-registry.repository";
import { swallow } from "../../common/swallow";
import { safeLogJson } from "../../common/logging";
import { resolveApiBasePath } from "../../common/path.util";
import { EnvKey } from "../../config/registry/env-key";

type LocalOwnerState = {
  runtimeInstanceId: string;
  channel: ChildProcess;
};

/**
 * local worker 访问宿主 API 的 base URL。跟 sandbox 侧 `resolveDockerApiBase()`
 * 同构,只是 host 换成 loopback——local worker 和 server 在同一台机器/同一网络
 * 命名空间,不需要 `host.docker.internal` 这层容器网络转发。
 */
function resolveLocalApiBase(
  env: Partial<
    Pick<NodeJS.ProcessEnv, "PORT" | "AGEWORK_CONTEXT">
  > = process.env
): string {
  const port = env[EnvKey.PORT] ?? "3000";
  return `http://127.0.0.1:${port}${resolveApiBasePath(env[EnvKey.CONTEXT])}`;
}

/**
 * local 实例编排:owner 长期复用一个常驻 worker 进程,`worker-manager` 负责把
 * 进程 fork 起来——跟 sandbox 走同一套 WorkerRegistry 记录路径,也跟 sandbox
 * 走同一条 HTTP 长轮询通道收发命令/事件(command.controller / worker-run.controller),
 * 物理载体只是 fork 出的进程而不是容器。本轮不做 idle 回收(见计划文档 Architecture
 * 一节),只在进程 exit 或显式 owner 删除时释放。`ChildProcess` 句柄(`state.channel`)
 * 仍然持有,但只用于进程生命周期信号(exit)和终止(kill),不再承载业务收发。
 *
 * 只注入 RuntimeService(下层)、WorkerRegistryRepository(同模块兄弟 provider),
 * 不注入 WorkerManagerService 本身——避免重蹈 Phase 2 Task 7 那次循环依赖的覆辙。
 */
@Injectable()
export class LocalInstanceExecutor {
  private readonly logger = new Logger(LocalInstanceExecutor.name);
  private readonly ownerStates = new Map<string, LocalOwnerState>();

  constructor(
    private readonly runtimeService: RuntimeService,
    private readonly registry: WorkerRegistryRepository
  ) {}

  async acquireInstanceForRun(
    input: WorkerExecutionStartInput
  ): Promise<AcquireInstanceResult> {
    const ownerId = input.runtimeTarget.ownerId;
    const workspaceId = input.runConfig.workspaceId;
    const existing = this.ownerStates.get(ownerId);
    if (existing) {
      return {
        outcome: "ready",
        runtimeInstanceId: existing.runtimeInstanceId,
      };
    }

    // insertStarting 用占位 id 写行(真实 pid:token 要等 launchLocal 返回才知道)。
    // 如果进程恰好在这个窗口崩溃,启动扫尾(RuntimeInstanceLifecycleService)只会把
    // 这行从 starting 转 error,不会杀真正的孤儿进程——扫尾的杀进程逻辑只处理
    // running 状态的行,而这里存的还是占位 id,不是可用的 pid。要在这个窗口内也能
    // 定位并杀掉孤儿进程,需要先落地设计文档 3.5 节"instanceId 由 Run 预先生成",
    // 这轮没做,留作已知的窄窗口缺口(概率极低,fork() 本身是同步调用)。
    const insertResult = await this.registry.insertStarting(
      {
        runtimeType: "local",
        isolationScope: "workspace",
        workspaceId,
        ownerId,
      },
      generateId(),
      "http"
    );
    if (!insertResult.ok) {
      // local worker 进程随 server 进程 fork 出来,server 一重启内存状态就丢了。
      // 已有行不管是 starting 还是 running,都不能安全复用,统一报错。
      return {
        outcome: "error",
        error: `owner ${ownerId} already has an active local instance record (status=${insertResult.existing.status}); this process cannot reattach to it`,
      };
    }

    let launched: {
      runtimeInstanceId: string;
      channel: LocalOwnerState["channel"];
    };
    try {
      launched = this.runtimeService.launchLocal({
        runId: input.runConfig.runId,
        env: {
          AGEWORK_WORKER_ROLE: "worker",
          AGEWORK_WORKER_API_BASE: resolveLocalApiBase(),
          AGEWORK_WORKER_OWNER_ID: ownerId,
          AGEWORK_WORKER_RUNTIME_TYPE: "local",
          AGEWORK_WORKER_ISOLATION_SCOPE: "workspace",
          ...(input.runConfig.workerLogFilePath
            ? { AGEWORK_WORKER_LOG_FILE: input.runConfig.workerLogFilePath }
            : {}),
        },
      });
    } catch (err) {
      await this.registry
        .markErrorByOwner(
          "local",
          "workspace",
          ownerId,
          err instanceof Error ? err.message : String(err)
        )
        .catch(swallow(this.logger, `mark launch error for owner ${ownerId}`));
      return {
        outcome: "error",
        error: `launch local worker failed: ${String(err)}`,
      };
    }

    const { runtimeInstanceId, channel } = launched;
    const state: LocalOwnerState = {
      runtimeInstanceId,
      channel,
    };
    this.ownerStates.set(ownerId, state);
    this.attachChannelListeners(ownerId, channel);

    await this.registry
      .upsertRunning(
        {
          runtimeType: "local",
          isolationScope: "workspace",
          workspaceId,
          ownerId,
        },
        runtimeInstanceId,
        "http"
      )
      .catch(swallow(this.logger, `record local runtime for owner ${ownerId}`));

    this.logger.log(
      `local worker started ${safeLogJson({ ownerId, pid: channel.pid })}`
    );
    return { outcome: "ready", runtimeInstanceId };
  }

  /** local 本轮不做 idle 回收,保留方法只为跟 sandbox 侧的调用形状对齐。 */
  releaseInstanceForRun(_runId: string): void {
    // no-op
  }

  shutdownRuntimeInstanceByOwnerId(ownerId: string): void {
    const state = this.ownerStates.get(ownerId);
    if (!state) return;
    try {
      if (!state.channel.killed) {
        state.channel.kill("SIGTERM");
      }
    } catch (err) {
      this.logger.warn(
        `terminate local worker failed ${safeLogJson({ ownerId, ...swallowFields(err) })}`
      );
    }
    this.registry
      .markStoppedByOwner("local", "workspace", ownerId)
      .catch(
        swallow(this.logger, `mark local runtime stopped for owner ${ownerId}`)
      );
    this.ownerStates.delete(ownerId);
  }

  recoverOrphan(runtimeInstanceId: string): Promise<void> {
    return this.runtimeService.recoverOrphanLocal(runtimeInstanceId);
  }

  private attachChannelListeners(ownerId: string, channel: ChildProcess): void {
    channel.on("exit", (code) => {
      this.logger.warn(`local worker exited ${safeLogJson({ ownerId, code })}`);
      this.registry
        .markStoppedByOwner("local", "workspace", ownerId)
        .catch(
          swallow(
            this.logger,
            `mark local runtime stopped for owner ${ownerId}`
          )
        );
      this.ownerStates.delete(ownerId);
    });
  }
}

function swallowFields(err: unknown): { error: string } {
  return { error: err instanceof Error ? err.message : String(err) };
}
