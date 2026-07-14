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
import { WorkspaceService } from "../../workspace/workspace.service";
import {
  RUNTIME_HOST_CONNECTED_EVENT,
  RuntimeHostConnectedEvent,
} from "../../runtime/runtime.events";
import { RUNTIME_HOST_CONTRACT } from "../runtime-host.types";

/**
 * 监听 workspace 删除事件，调 RuntimeHostContract.releaseOwner 清理 worker。
 *
 * 设计文档 §3.5 场景 4：删 workspace → soft-delete → emit deleted event
 * → run 停该 workspace 的活跃 run → Host.releaseOwner(owner) 清 worker。
 *
 * workspace 删除只释放 workspace owner。user owner 的 worker 可能仍被该用户的其它
 * workspace 共享，只有用户注销/禁用时才允许释放。
 *
 * 删除时目标 registered Host 离线的话 releaseOwner 会丢(只告警,无重试队列);
 * 由 Host 重连注册成功后的对账兜底:该 Host 上 workspace-scope 的 worker,其
 * workspace 已软删的,补发定向 releaseOwner。
 */
@Injectable()
export class WorkspaceHostListener {
  private readonly logger = new Logger(WorkspaceHostListener.name);

  constructor(
    @Inject(RUNTIME_HOST_CONTRACT)
    private readonly hostContract: RuntimeHostContract,
    private readonly workspaceService: WorkspaceService
  ) {}

  @OnEvent(WORKSPACE_DELETED_EVENT)
  async onWorkspaceDeleted({
    workspaceId,
    runtimeHostId,
  }: WorkspaceDeletedEvent): Promise<void> {
    const owner = workspaceOwnerKey(workspaceId);
    try {
      await this.hostContract.releaseOwner({ runtimeHostId, owner });
    } catch (err) {
      this.logger.warn(
        `releaseOwner(${owner}) failed for workspace ${workspaceId} on host ${runtimeHostId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  @OnEvent(RUNTIME_HOST_CONNECTED_EVENT)
  async onRuntimeHostConnected({
    runtimeHostId,
  }: RuntimeHostConnectedEvent): Promise<void> {
    try {
      const workers = await this.hostContract.listWorkers();
      const workspaceIds = [
        ...new Set(
          workers
            .filter(
              (worker) =>
                worker.runtimeHostId === runtimeHostId &&
                worker.scope === "workspace"
            )
            .map((worker) => worker.ownerId)
        ),
      ];
      if (workspaceIds.length === 0) return;
      const activeIds = new Set(
        await this.workspaceService.listActiveIds(workspaceIds)
      );
      for (const workspaceId of workspaceIds) {
        if (activeIds.has(workspaceId)) continue;
        this.logger.log(
          `reconcile: releasing workers of deleted workspace ${workspaceId} on host ${runtimeHostId}`
        );
        await this.hostContract.releaseOwner({
          runtimeHostId,
          owner: workspaceOwnerKey(workspaceId),
        });
      }
    } catch (err) {
      // best-effort:失败等下次重连再对账
      this.logger.warn(
        `host reconcile failed for ${runtimeHostId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
}
