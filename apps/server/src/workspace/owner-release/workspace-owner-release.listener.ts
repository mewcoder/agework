import { Inject, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import {
  workspaceOwnerKey,
  type RuntimeHostDiagnostics,
  type RuntimeHostOperations,
} from "@agework/shared/protocol";
import {
  WORKSPACE_DELETED_EVENT,
  WorkspaceDeletedEvent,
} from "../workspace.events";
import {
  RUNTIME_HOST_CONNECTED_EVENT,
  RuntimeHostConnectedEvent,
} from "../../runtime-host/runtime-host.events";
import {
  RUNTIME_HOST_DIAGNOSTICS,
  RUNTIME_HOST_OPERATIONS,
} from "../../runtime-host/runtime-host.types";
import { WorkspaceRepository } from "../workspace.repository";

/**
 * workspace-scope owner 生命周期 → Host worker 释放(辅助逻辑跟数据走,
 * workspace owner 的存活判断归本模块)。
 *
 * - workspace 删除 → 定向 releaseOwner(workspace:X),Host 在事件里带来。
 * - Host 重连注册成功 → 对账兜底:现场快照里 workspace 已软删的补发定向释放
 *   (删除发生时目标 Host 离线,或 server 在删除与释放之间崩溃)。
 *
 * 全部 best-effort:失败只告警,等下次事件/重连再补。
 */
@Injectable()
export class WorkspaceOwnerReleaseListener {
  private readonly logger = new Logger(WorkspaceOwnerReleaseListener.name);

  constructor(
    @Inject(RUNTIME_HOST_OPERATIONS)
    private readonly hostOperations: RuntimeHostOperations,
    @Inject(RUNTIME_HOST_DIAGNOSTICS)
    private readonly hostDiagnostics: RuntimeHostDiagnostics,
    private readonly workspaceRepository: WorkspaceRepository
  ) {}

  @OnEvent(WORKSPACE_DELETED_EVENT)
  async onWorkspaceDeleted({
    workspaceId,
    runtimeHostId,
  }: WorkspaceDeletedEvent): Promise<void> {
    try {
      await this.hostOperations.releaseOwner({
        runtimeHostId,
        owner: workspaceOwnerKey(workspaceId),
      });
    } catch (err) {
      this.logger.warn(
        `releaseOwner(workspace:${workspaceId}) failed on host ${runtimeHostId}: ${
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
      const workspaceIds = [
        ...new Set(
          (await this.hostDiagnostics.listWorkers())
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
        await this.workspaceRepository.listActiveIds(workspaceIds)
      );
      for (const workspaceId of workspaceIds) {
        if (activeIds.has(workspaceId)) continue;
        this.logger.log(
          `reconcile: releasing workers of deleted workspace ${workspaceId} on host ${runtimeHostId}`
        );
        try {
          await this.hostOperations.releaseOwner({
            runtimeHostId,
            owner: workspaceOwnerKey(workspaceId),
          });
        } catch (err) {
          this.logger.warn(
            `releaseOwner(workspace:${workspaceId}) failed on host ${runtimeHostId}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
    } catch (err) {
      // best-effort:失败等下次重连再对账
      this.logger.warn(
        `workspace owner reconcile failed for ${runtimeHostId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
}
