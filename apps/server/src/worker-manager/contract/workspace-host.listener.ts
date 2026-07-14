import { Inject, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import {
  workspaceOwnerKey,
  type RuntimeHostContract,
} from "@agework/shared/protocol";
import {
  WORKSPACE_DELETED_EVENT,
  WorkspaceDeletedEvent,
} from "../../workspace/workspace.events";
import { RUNTIME_HOST_CONTRACT } from "../worker-manager.types";

/**
 * 监听 workspace 删除事件，调 RuntimeHostContract.releaseOwner 清理 worker。
 *
 * 设计文档 §3.5 场景 4：删 workspace → soft-delete → emit deleted event
 * → run 停该 workspace 的活跃 run → Host.releaseOwner(owner) 清 worker。
 *
 * workspace 删除只释放 workspace owner。user owner 的 worker 可能仍被该用户的其它
 * workspace 共享，只有用户注销/禁用时才允许释放。
 */
@Injectable()
export class WorkspaceHostListener {
  private readonly logger = new Logger(WorkspaceHostListener.name);

  constructor(
    @Inject(RUNTIME_HOST_CONTRACT)
    private readonly hostContract: RuntimeHostContract
  ) {}

  @OnEvent(WORKSPACE_DELETED_EVENT)
  async onWorkspaceDeleted({
    workspaceId,
  }: WorkspaceDeletedEvent): Promise<void> {
    const owner = workspaceOwnerKey(workspaceId);
    try {
      await this.hostContract.releaseOwner(owner);
    } catch (err) {
      this.logger.warn(
        `releaseOwner(${owner}) failed for workspace ${workspaceId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
}
