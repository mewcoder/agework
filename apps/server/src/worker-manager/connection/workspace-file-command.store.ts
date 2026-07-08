import { Injectable, Logger } from "@nestjs/common";
import type { WorkspaceFileCommandResult } from "@agework/shared/protocol";

type PendingResult = {
  resolve: (result: WorkspaceFileCommandResult) => void;
  reject: (reason: Error) => void;
};

/**
 * 文件命令结果的 pending 收敛 store——结构照抄 `WorkerHandshakeStore`。
 *
 * server 下发文件命令后,在 `waitForResult(commandId)` 挂一个 pending Promise,
 * worker 处理完经独立结果端点(`POST /worker/owners/:ownerId/file-command-results`)
 * 回传结果,`resolveResult(result)` 按 `commandId` 匹配并 resolve。
 *
 * 不自带超时——由调用方(workspace service)套 `withTimeout` 并在超时/出错分支
 * 显式调用 `cancel(commandId, reason)` 清理 pending 条目,否则 worker 迟迟不回
 * 或永久失联时会在 Store 里留下再也不会被消费的 pending Promise(见 ADR-0004)。
 */
@Injectable()
export class WorkspaceFileCommandStore {
  private readonly logger = new Logger(WorkspaceFileCommandStore.name);
  private readonly pending = new Map<string, PendingResult>();

  /** 挂一个 pending Promise 等待匹配 commandId 的结果。 */
  waitForResult(commandId: string): Promise<WorkspaceFileCommandResult> {
    return new Promise<WorkspaceFileCommandResult>((resolve, reject) => {
      this.pending.set(commandId, { resolve, reject });
    });
  }

  /** worker 结果端点调用:按 commandId 匹配并 resolve 对应的 pending Promise。 */
  resolveResult(result: WorkspaceFileCommandResult): boolean {
    const entry = this.pending.get(result.commandId);
    if (!entry) {
      this.logger.warn(
        `no pending file command result for commandId ${result.commandId} (late or duplicate?)`
      );
      return false;
    }
    this.pending.delete(result.commandId);
    entry.resolve(result);
    return true;
  }

  /** 超时/出错分支清理 pending 条目,防止悬空 Promise。 */
  cancel(commandId: string, reason: string): void {
    const entry = this.pending.get(commandId);
    if (!entry) return;
    this.pending.delete(commandId);
    entry.reject(new Error(reason));
  }

  /** 进程退出时拒绝所有 pending,避免悬挂。 */
  rejectAll(reason: string): void {
    for (const [commandId, entry] of this.pending) {
      this.pending.delete(commandId);
      entry.reject(new Error(reason));
    }
  }
}
