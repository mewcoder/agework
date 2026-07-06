import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { WorkerLifecycleHandler } from "./lifecycle.handler";
import {
  WORKSPACE_DELETED_EVENT,
  WorkspaceDeletedEvent,
} from "../../workspace/workspace.events";
import {
  USER_DELETED_EVENT,
  USER_DISABLED_EVENT,
  UserDeletedEvent,
  UserDisabledEvent,
} from "../../user/user.events";

/**
 * 监听底层领域的删除事件,清理对应的 runtime 资源。
 * best-effort:失败仅记录日志,不影响来源操作(idle 超时与 GC 仍是兜底)。
 */
@Injectable()
export class WorkerLifecycleListener {
  private readonly logger = new Logger(WorkerLifecycleListener.name);

  constructor(private readonly lifecycle: WorkerLifecycleHandler) {}

  @OnEvent(WORKSPACE_DELETED_EVENT)
  async onWorkspaceDeleted({
    workspaceId,
  }: WorkspaceDeletedEvent): Promise<void> {
    try {
      await this.lifecycle.shutdownForWorkspace(workspaceId);
    } catch (err) {
      this.logger.warn(
        `shutdownForWorkspace failed for ${workspaceId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  @OnEvent([USER_DELETED_EVENT, USER_DISABLED_EVENT])
  async onUserResourcesReleased({
    userId,
  }: UserDeletedEvent | UserDisabledEvent): Promise<void> {
    try {
      await this.lifecycle.shutdownForUser(userId);
    } catch (err) {
      this.logger.warn(
        `shutdownForUser failed for ${userId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
