import { Injectable, Logger } from "@nestjs/common";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { safeLogJson } from "../../common/logging";
import type { LocalInstanceHandle, LocalLaunchInput } from "../runtime.types";

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
 * (目前是 run 模块的 WorkerRunExecutor)自行收发,这条边界在设计文档 1.1 节
 * "local 场景的 channel 交接"里有说明。
 */
@Injectable()
export class LocalRuntimeProvider {
  private readonly logger = new Logger(LocalRuntimeProvider.name);

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

  /** runtimeInstanceId 格式为 `pid:startToken`;向 pid 发送 SIGTERM,进程已退出(ESRCH)时忽略。 */
  recoverOrphan(runtimeInstanceId: string): Promise<void> {
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
