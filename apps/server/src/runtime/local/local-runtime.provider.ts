import { Injectable, Logger } from "@nestjs/common";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { safeLogJson } from "../../common/logging";
import { resolveApiBasePath } from "../../common/path.util";
import { EnvKey } from "../../config/registry/env-key";
import type {
  LocalInstanceHandle,
  LocalLaunchInput,
  RuntimeProvider,
  RuntimeLaunchContext,
  RuntimeEnvHandle,
  RuntimeInstanceRef,
} from "../runtime.types";

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

// Worker entry point (TS source, executed via tsx), resolved via the
// `@agework/worker` workspace package so it works regardless of dev/dist
// layout or process cwd.
const WORKER_MAIN = require.resolve("@agework/worker");

// Run the worker through the tsx CLI rather than `node --import tsx/esm`:
// on Node 22.12+ the latter throws ERR_REQUIRE_CYCLE_MODULE for any TS entry
// file that has imports (https://github.com/privatenumber/tsx, tsx 4.22.4).
const TSX_CLI = require.resolve("tsx/cli");

/**
 * local 放置机制的 Provider:fork 一个 worker 子进程,IPC 通信。只负责物理
 * 拉起/终止进程,不参与后续通信内容——channel 随 launch() 返回值交给调用方
 * (目前是 run 模块的 RunDriver)自行收发,这条边界在设计文档 1.1 节
 * "local 场景的 channel 交接"里有说明。
 */
@Injectable()
export class LocalRuntimeProvider implements RuntimeProvider {
  readonly type = "local";
  readonly placementKind = "process" as const;
  private readonly logger = new Logger(LocalRuntimeProvider.name);
  private readonly channels = new Map<string, ChildProcess>();

  /** RuntimeProvider 接口方法:local 没有环境准备阶段,直接返回空 handle。 */
  prepareEnvironment(_ctx: RuntimeLaunchContext): Promise<RuntimeEnvHandle> {
    return Promise.resolve({});
  }

  /** RuntimeProvider 接口方法:复用 launch(),并接管进程句柄供 teardown/exit 监听用。 */
  launchWorker(
    ctx: RuntimeLaunchContext,
    _env: RuntimeEnvHandle
  ): Promise<{ runtimeInstanceId: string }> {
    const { runtimeInstanceId, channel } = this.launch({
      runId: ctx.runId,
      env: { ...ctx.workerEnv, AGEWORK_WORKER_API_BASE: resolveLocalApiBase() },
    });
    this.channels.set(ctx.ownerId, channel);
    channel.on("exit", () => {
      if (this.channels.get(ctx.ownerId) !== channel) return; // stale process, superseded
      this.channels.delete(ctx.ownerId);
      ctx.onWorkerExit?.();
    });
    return Promise.resolve({ runtimeInstanceId });
  }

  /** RuntimeProvider 接口方法:SIGTERM owner 持有的进程句柄。 */
  teardown(ref: RuntimeInstanceRef): void {
    const channel = this.channels.get(ref.ownerId);
    if (channel && !channel.killed) {
      try {
        channel.kill("SIGTERM");
      } catch (err) {
        this.logger.warn(
          `terminate local worker failed ${safeLogJson({ ownerId: ref.ownerId, error: err instanceof Error ? err.message : String(err) })}`
        );
      }
    }
    this.channels.delete(ref.ownerId);
  }

  /** fork 一个本地 worker 子进程,返回逻辑实例标识与 IPC channel。 */
  launch(input: LocalLaunchInput): LocalInstanceHandle {
    const startToken = randomUUID();
    const child = fork(TSX_CLI, [WORKER_MAIN], {
      env: {
        ...process.env,
        ...input.env,
        AGEWORK_WORKER_RUN_START_TOKEN: startToken,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    this.logger.log(
      `local worker forked ${safeLogJson({ runId: input.runId, pid: child.pid })}`
    );
    return {
      runtimeInstanceId: `${child.pid}:${startToken}`,
      channel: child,
    };
  }

  /** RuntimeProvider 接口方法:按 ref.runtimeInstanceId 回收孤儿进程。 */
  recoverOrphan(ref: RuntimeInstanceRef): Promise<void> {
    return this.recoverOrphanByInstanceId(ref.runtimeInstanceId);
  }

  /** runtimeInstanceId 格式为 `pid:startToken`;向 pid 发送 SIGTERM,进程已退出(ESRCH)时忽略。 */
  private recoverOrphanByInstanceId(runtimeInstanceId: string): Promise<void> {
    const [pidStr] = runtimeInstanceId.split(":");
    const pid = Number(pidStr);
    if (!Number.isInteger(pid)) return Promise.resolve();
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // ESRCH: process already gone
    }
    return Promise.resolve();
  }
}
