import { Logger } from "@nestjs/common";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { safeLogJson } from "../common/util";
import type {
  LocalProviderConfig,
  RuntimeProvider,
  RuntimeLaunchContext,
  RuntimeInstanceRef,
} from "../types";

/**
 * local 运行形态的 Provider:fork 一个 worker 子进程,IPC channel 只在内部用于
 * 接收进程 exit 信号与 SIGTERM 终止,业务收发走 HTTP。local 无独立载体,
 * `stop` 与 `destroy` 都是杀进程——`stop` 杀内存中跟踪的 channel,`destroy`
 * 在无内存态时(如 server 重启后清孤儿)按 `runtimeInstanceId` 里的 pid 杀。
 *
 * worker 入口路径与 tsx CLI 路径由 server 解析后经 config 传入,包因此不依赖
 * `@agework/worker`。
 */
export class LocalRuntimeProvider implements RuntimeProvider {
  readonly type = "local";
  private readonly logger = new Logger(LocalRuntimeProvider.name);
  private readonly channels = new Map<string, ChildProcess>();

  constructor(private readonly config: LocalProviderConfig) {}

  /** fork 一个本地 worker 子进程,接管进程句柄供 stop/exit 用,返回逻辑实例标识。 */
  start(ctx: RuntimeLaunchContext): Promise<{ runtimeInstanceId: string }> {
    const startToken = randomUUID();
    const child = fork(this.config.tsxCliPath, [this.config.workerEntryPath], {
      env: {
        ...process.env,
        ...ctx.workerEnv,
        AGEWORK_WORKER_API_BASE: this.config.apiBaseUrl,
        AGEWORK_WORKER_RUN_START_TOKEN: startToken,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const runtimeInstanceId = `${child.pid}:${startToken}`;
    this.logger.log(
      `local worker forked ${safeLogJson({ runId: ctx.runId, pid: child.pid })}`
    );

    this.channels.set(ctx.ownerId, child);
    child.on("exit", () => {
      if (this.channels.get(ctx.ownerId) !== child) return; // stale process, superseded
      this.channels.delete(ctx.ownerId);
      ctx.onWorkerExit?.();
    });
    return Promise.resolve({ runtimeInstanceId });
  }

  /** owner 仍在:SIGTERM owner 持有的进程句柄。 */
  stop(ref: RuntimeInstanceRef): void {
    this.terminateChannel(ref.ownerId);
  }

  /** owner 永久消失:有内存 channel 杀 channel,否则按 pid 杀(重启后清孤儿)。 */
  destroy(ref: RuntimeInstanceRef): void {
    if (this.channels.has(ref.ownerId)) {
      this.terminateChannel(ref.ownerId);
      return;
    }
    this.killByInstanceId(ref.runtimeInstanceId);
  }

  private terminateChannel(ownerId: string): void {
    const channel = this.channels.get(ownerId);
    if (channel && !channel.killed) {
      try {
        channel.kill("SIGTERM");
      } catch (err) {
        this.logger.warn(
          `terminate local worker failed ${safeLogJson({ ownerId, error: err instanceof Error ? err.message : String(err) })}`
        );
      }
    }
    this.channels.delete(ownerId);
  }

  /** runtimeInstanceId 格式为 `pid:startToken`;向 pid 发送 SIGTERM,进程已退出(ESRCH)时忽略。 */
  private killByInstanceId(runtimeInstanceId: string): void {
    const [pidStr] = runtimeInstanceId.split(":");
    const pid = Number(pidStr);
    if (!Number.isInteger(pid)) return;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // ESRCH: process already gone
    }
  }
}
