import { Inject, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { parseOwnerKey, workspaceOwnerKey } from "@agework/shared/protocol";
import {
  RUNTIME_HOST_CONNECTED_EVENT,
  RuntimeHostConnectedEvent,
} from "../../runtime-host/runtime-host.events";
import {
  RUNTIME_HOST_OWNER_RECONCILIATION,
  type RuntimeHostOwnerReconciliation,
} from "../../runtime-host/runtime-host.types";
import { WorkspaceRepository } from "../workspace.repository";

/**
 * workspace-scope owner 存活对账 → Host worker 释放(辅助逻辑跟数据走,
 * workspace owner 的存活判断归本模块)。
 *
 * 删除时的即时释放不在这里:那是 run 模块 RunWorkspaceListener 的两步编排
 * (先停 run 再释放,保证取消语义)。本 listener 只做重连对账兜底:
 * Host 重连注册成功后,现场快照里 workspace 已软删的补发定向释放
 * (删除发生时目标 Host 离线,或 server 在删除与释放之间崩溃)。
 *
 * best-effort:失败只告警,等下次重连再补。
 */
@Injectable()
export class WorkspaceOwnerReleaseListener {
  private readonly logger = new Logger(WorkspaceOwnerReleaseListener.name);

  constructor(
    @Inject(RUNTIME_HOST_OWNER_RECONCILIATION)
    private readonly hostOwners: RuntimeHostOwnerReconciliation,
    private readonly workspaceRepository: WorkspaceRepository
  ) {}

  @OnEvent(RUNTIME_HOST_CONNECTED_EVENT)
  async onRuntimeHostConnected({
    runtimeHostId,
  }: RuntimeHostConnectedEvent): Promise<void> {
    try {
      const workspaceIds = [
        ...new Set(
          (await this.hostOwners.listOwners(runtimeHostId))
            .map(({ owner }) => parseOwnerKey(owner))
            .filter(({ scope }) => scope === "workspace")
            .map(({ id }) => id)
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
          await this.hostOwners.releaseOwner({
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
