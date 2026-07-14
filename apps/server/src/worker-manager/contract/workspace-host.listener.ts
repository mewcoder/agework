import { Inject, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import {
  workspaceOwnerKey,
  userOwnerKey,
  type OwnerKey,
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
 * workspace 删除时不知道用了 user 还是 workspace 隔离粒度，两个 OwnerKey 都试——
 * 命中的会停 worker，不命中的 no-op（listByOwner 返回空）。
 */
@Injectable()
export class WorkspaceHostListener {
  private readonly logger = new Logger(WorkspaceHostListener.name);

  constructor(
    @Inject(RUNTIME_HOST_CONTRACT)
    private readonly hostContract: RuntimeHostContract,
  ) {}

  @OnEvent(WORKSPACE_DELETED_EVENT)
  async onWorkspaceDeleted({
    workspaceId,
    userId,
  }: WorkspaceDeletedEvent): Promise<void> {
    const owners: OwnerKey[] = [
      workspaceOwnerKey(workspaceId),
      userOwnerKey(userId),
    ];
    for (const owner of owners) {
      try {
        await this.hostContract.releaseOwner(owner);
      } catch (err) {
        this.logger.warn(
          `releaseOwner(${owner}) failed for workspace ${workspaceId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }
}
