/**
 * WorkspaceFileCommandHandler:RunnerManager 的兄弟角色。
 *
 * 不进 RunnerManager,常驻 worker 直接处理文件命令。
 * fire-and-forget 分发:处理函数内部抛错不会变成 unhandled rejection。
 * AbortSignal 超时(8s,比 server 侧 10s 短)。
 * try/catch 到底,任何失败都转成走结果通道回传 error。
 */

import type {
  WorkspaceFileCommandPayload,
  WorkspaceFileCommandResult,
} from "@agework/shared/protocol";
import { browse } from "./workspace-file-browser";
import type { WorkerHttpTransport } from "../transport/worker-http";
import { errorDetails, workerLog } from "../logging/worker-log";

export class WorkspaceFileCommandHandler {
  private readonly rootPath: string;

  constructor(private readonly transport: WorkerHttpTransport) {
    this.rootPath =
      process.env.AGEWORK_WORKER_WORKSPACE_PATH ?? process.cwd();
  }

  /**
   * 处理一条文件命令,经独立结果端点回传结果。
   * 全程 try/catch,不会裸抛——任何失败都转成 error result 回传。
   */
  async handle(command: WorkspaceFileCommandPayload): Promise<void> {
    const { commandId, type } = command;
    workerLog("workspace file command received", {
      commandId,
      type,
      path: command.path,
    });

    let result: WorkspaceFileCommandResult;
    try {
      const browseResult = await browse(this.rootPath, command);
      if (browseResult.ok) {
        result = browseResult.result;
      } else {
        result = browseResult.error;
      }
    } catch (err) {
      // browse() 内部已有 try/catch,这里兜底防止极端情况下的裸抛
      result = {
        type,
        commandId,
        error: `文件浏览意外失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // 经独立结果端点回传,不经 command.result/RunEvent
    try {
      await this.transport.postFileCommandResult(result);
    } catch (err) {
      workerLog(
        "workspace file command result post failed",
        {
          commandId,
          type,
          ...errorDetails(err),
        },
        "error"
      );
    }
  }
}
