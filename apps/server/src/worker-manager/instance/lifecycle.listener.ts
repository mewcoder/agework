import { Inject, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import type { OwnerKey, RuntimeHostContract } from "@agework/shared/protocol";
import { RUNTIME_HOST_CONTRACT } from "../worker-manager.types";
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
 * 监听底层领域的删除事件,经执行面契约释放对应 owner 的 worker。
 * Phase 2:releaseOwner 广播到进程内 Host + 所有隧道在线 Host(managed 容器型
 * + registered),持有该 owner 的 Host 停 worker,其余空操作。
 * 注:workspace 删除只释放 workspace-scope owner;该用户的 user-scope worker
 * 服务其它 workspace,留给 fence/TTL(完整 releaseWorkspace 收尾链路是 Phase 3 事项)。
 * best-effort:失败仅记录日志,不影响来源操作。
 */
@Injectable()
export class WorkerLifecycleListener {
  private readonly logger = new Logger(WorkerLifecycleListener.name);

  constructor(
    @Inject(RUNTIME_HOST_CONTRACT)
    private readonly runtimeHost: RuntimeHostContract
  ) {}

  @OnEvent(WORKSPACE_DELETED_EVENT)
  async onWorkspaceDeleted({
    workspaceId,
  }: WorkspaceDeletedEvent): Promise<void> {
    try {
      await this.runtimeHost.releaseOwner(`workspace:${workspaceId}` as OwnerKey);
    } catch (err) {
      this.logger.warn(
        `releaseOwner failed for workspace ${workspaceId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  @OnEvent([USER_DELETED_EVENT, USER_DISABLED_EVENT])
  async onUserResourcesReleased({
    userId,
  }: UserDeletedEvent | UserDisabledEvent): Promise<void> {
    try {
      await this.runtimeHost.releaseOwner(`user:${userId}` as OwnerKey);
    } catch (err) {
      this.logger.warn(
        `releaseOwner failed for user ${userId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
