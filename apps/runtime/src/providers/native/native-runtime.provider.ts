import { Logger } from "@nestjs/common";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { safeLogJson } from "../common/util";
import type {
  RuntimeProvider,
  RuntimeLaunchContext,
  RuntimeInstanceRef,
  RuntimeStartOptions,
} from "@agework/runtime-sdk";
import type { RuntimeHostProviderConfig } from "../types";

/** Node ErrnoException 形状检查(避免引用内部类型)。 */
function isErrnoException(
  err: unknown
): err is { code: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as { code?: unknown }).code === "string"
  );
}

/**
 * native 运行形态的 Provider:fork 一个 worker 子进程,IPC channel 只在内部用于
 * 接收进程 exit 信号与 SIGTERM 终止,业务收发走 HTTP。native 无独立运行实例,
 * `stop` 与 `destroy` 都是杀进程——`stop` 杀内存中跟踪的 channel,`destroy`
 * 在无内存态时(如 server 重启后清孤儿)按 `runtimeInstanceId` 里的 pid 杀。
 *
 * fork 的目标是 agework-runtime 产物 bundle(纯 JS,ESM),用 `node` 直跑并注入
 * `AGEWORK_WORKER_ROLE=worker` 让同一产物以 worker 角色启动。入口路径由 server
 * 经 config 传入,provider 因此不依赖 Runtime 内部 Worker 实现或 tsx。
 */
export class NativeRuntimeProvider implements RuntimeProvider {
  readonly type = "native";
  private readonly logger = new Logger(NativeRuntimeProvider.name);
  private readonly channels = new Map<string, ChildProcess>();

  constructor(private readonly config: RuntimeHostProviderConfig) {}

  /** fork 一个本地 worker 子进程,接管进程句柄供 stop/exit 用,返回逻辑实例标识。
   *  onExit 是调用方本地专属的退出钩子(不进 ctx,见 RuntimeProvider.start 文档)。 */
  start(
    ctx: RuntimeLaunchContext,
    onExit?: () => void,
    onProvisioned?: (runtimeInstanceId: string) => void,
    options?: RuntimeStartOptions
  ): Promise<{ runtimeInstanceId: string }> {
    options?.signal?.throwIfAborted();
    const startToken = randomUUID();
    const child = fork(this.config.native.runtimeEntryPath, [], {
      env: {
        ...process.env,
        ...ctx.workerEnv,
        AGEWORK_WORKER_ROLE: "worker",
        AGEWORK_WORKER_API_BASE: this.config.workerApiBaseUrl,
        AGEWORK_WORKER_RUN_START_TOKEN: startToken,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const runtimeInstanceId = `${child.pid}:${startToken}`;
    onProvisioned?.(runtimeInstanceId);
    this.logger.log(
      `native worker forked ${safeLogJson({ runId: ctx.runId, pid: child.pid })}`
    );

    this.channels.set(ctx.workerId, child);
    child.on("exit", () => {
      if (this.channels.get(ctx.workerId) !== child) return; // stale process, superseded
      this.channels.delete(ctx.workerId);
      onExit?.();
    });
    return Promise.resolve({ runtimeInstanceId });
  }

  /** worker 仍在:SIGTERM worker 持有的进程句柄。 */
  release(ref: RuntimeInstanceRef): void {
    this.stop(ref);
  }

  stop(ref: RuntimeInstanceRef): void {
    this.terminateChannel(ref.workerId);
  }

  /**
   * worker 永久消失:有内存 channel 杀 channel,否则按 pid 杀(重启后清孤儿)。
   * 非 ESRCH 错误传播给调用方,避免假成功 ACK(SPEC §5.2)。
   */
  destroy(ref: RuntimeInstanceRef): void {
    if (this.channels.has(ref.workerId)) {
      this.terminateChannel(ref.workerId);
      return;
    }
    this.killByInstanceId(ref.runtimeInstanceId);
  }

  private terminateChannel(workerId: string): void {
    const channel = this.channels.get(workerId);
    if (channel && !channel.killed) {
      try {
        channel.kill("SIGTERM");
      } catch (err) {
        if (isErrnoException(err) && err.code === "ESRCH") {
          this.channels.delete(workerId);
          return;
        }
        this.logger.warn(
          `terminate native worker failed ${safeLogJson({ workerId, error: err instanceof Error ? err.message : String(err) })}`
        );
        // 非 ESRCH 不能假装资源已清理，也不能先丢 tracked channel。
        throw err;
      }
    }
    this.channels.delete(workerId);
  }

  /**
   * runtimeInstanceId 格式为 `pid:startToken`;向 pid 发送 SIGTERM。
   * ESRCH(进程已退出)是预期状态,静默忽略;其它错误(EPERM 等)传播给调用方,
   * 避免假成功 ACK(SPEC §5.2)。
   */
  private killByInstanceId(runtimeInstanceId: string): void {
    const [pidStr] = runtimeInstanceId.split(":");
    const pid = Number(pidStr);
    if (!Number.isInteger(pid)) return;
    try {
      process.kill(pid, "SIGTERM");
    } catch (err) {
      // ESRCH: No such process —— 进程已退出,预期状态,静默
      if (isErrnoException(err) && err.code === "ESRCH") return;
      throw err;
    }
  }
}
