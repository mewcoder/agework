import { Inject, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import {
  userOwnerKey,
  workspaceOwnerKey,
  type OwnerKey,
  type RuntimeHostDiagnostics,
  type RuntimeHostOperations,
  type WorkerSnapshot,
} from "@agework/shared/protocol";
import {
  WORKSPACE_DELETED_EVENT,
  WorkspaceDeletedEvent,
} from "../../workspace/workspace.events";
import { WorkspaceService } from "../../workspace/workspace.service";
import {
  USER_DELETED_EVENT,
  USER_DISABLED_EVENT,
  UserDeletedEvent,
  UserDisabledEvent,
} from "../../user/user.events";
import { UserService } from "../../user/user.service";
import {
  RUNTIME_HOST_CONNECTED_EVENT,
  RuntimeHostConnectedEvent,
} from "../../runtime/runtime.events";
import {
  RUNTIME_HOST_DIAGNOSTICS,
  RUNTIME_HOST_OPERATIONS,
} from "../runtime-host.types";

/**
 * owner 生命周期 → Host worker 释放的协调点(设计文档 §3.5 场景 4)。
 *
 * - workspace 删除 → 定向 releaseOwner(workspace:X),Host 在事件里带来。
 * - user 禁用/删除 → 现场查该用户 user-scope worker 所在的 Host,逐台定向释放
 *   (user worker 可能分布在多台 Host,事件不带 host,按现场快照定位)。
 * - Host 重连注册成功 → 对账兜底:补发丢失的 releaseOwner(删除/禁用发生时
 *   目标 Host 离线,或 server 在删除与释放之间崩溃)。一次现场快照同时对账
 *   两类 owner:workspace 已软删的、user 已禁用/软删的。
 *
 * 全部 best-effort:失败只告警,等下次事件/重连再补。
 */
@Injectable()
export class OwnerHostListener {
  private readonly logger = new Logger(OwnerHostListener.name);

  constructor(
    @Inject(RUNTIME_HOST_OPERATIONS)
    private readonly hostOperations: RuntimeHostOperations,
    @Inject(RUNTIME_HOST_DIAGNOSTICS)
    private readonly hostDiagnostics: RuntimeHostDiagnostics,
    private readonly workspaceService: WorkspaceService,
    private readonly userService: UserService
  ) {}

  @OnEvent(WORKSPACE_DELETED_EVENT)
  async onWorkspaceDeleted({
    workspaceId,
    runtimeHostId,
  }: WorkspaceDeletedEvent): Promise<void> {
    const owner = workspaceOwnerKey(workspaceId);
    try {
      await this.hostOperations.releaseOwner({ runtimeHostId, owner });
    } catch (err) {
      this.logger.warn(
        `releaseOwner(${owner}) failed for workspace ${workspaceId} on host ${runtimeHostId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  @OnEvent([USER_DISABLED_EVENT, USER_DELETED_EVENT])
  async onUserDeactivated({
    userId,
  }: UserDisabledEvent | UserDeletedEvent): Promise<void> {
    try {
      const workers = await this.hostDiagnostics.listWorkers();
      const hostIds = new Set(
        workers
          .filter(
            (worker) => worker.scope === "user" && worker.ownerId === userId
          )
          .map((worker) => worker.runtimeHostId)
      );
      for (const runtimeHostId of hostIds) {
        await this.releaseOwnerOn(runtimeHostId, userOwnerKey(userId));
      }
    } catch (err) {
      this.logger.warn(
        `release user-scope workers failed for user ${userId}: ${
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
      const workers = (await this.hostDiagnostics.listWorkers()).filter(
        (worker) => worker.runtimeHostId === runtimeHostId
      );
      await this.reconcileWorkspaceOwners(runtimeHostId, workers);
      await this.reconcileUserOwners(runtimeHostId, workers);
    } catch (err) {
      // best-effort:失败等下次重连再对账
      this.logger.warn(
        `host reconcile failed for ${runtimeHostId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  /** workspace-scope worker 对账:workspace 已软删的补发定向释放。 */
  private async reconcileWorkspaceOwners(
    runtimeHostId: string,
    workers: WorkerSnapshot[]
  ): Promise<void> {
    const workspaceIds = distinctOwnerIds(workers, "workspace");
    if (workspaceIds.length === 0) return;
    const activeIds = new Set(
      await this.workspaceService.listActiveIds(workspaceIds)
    );
    for (const workspaceId of workspaceIds) {
      if (activeIds.has(workspaceId)) continue;
      this.logger.log(
        `reconcile: releasing workers of deleted workspace ${workspaceId} on host ${runtimeHostId}`
      );
      await this.releaseOwnerOn(runtimeHostId, workspaceOwnerKey(workspaceId));
    }
  }

  /** user-scope worker 对账:用户已禁用/软删的补发定向释放。 */
  private async reconcileUserOwners(
    runtimeHostId: string,
    workers: WorkerSnapshot[]
  ): Promise<void> {
    const userIds = distinctOwnerIds(workers, "user");
    if (userIds.length === 0) return;
    const activeIds = new Set(await this.userService.listActiveIds(userIds));
    for (const userId of userIds) {
      if (activeIds.has(userId)) continue;
      this.logger.log(
        `reconcile: releasing workers of deactivated user ${userId} on host ${runtimeHostId}`
      );
      await this.releaseOwnerOn(runtimeHostId, userOwnerKey(userId));
    }
  }

  private async releaseOwnerOn(
    runtimeHostId: string,
    owner: OwnerKey
  ): Promise<void> {
    try {
      await this.hostOperations.releaseOwner({ runtimeHostId, owner });
    } catch (err) {
      this.logger.warn(
        `releaseOwner(${owner}) failed on host ${runtimeHostId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
}

function distinctOwnerIds(
  workers: WorkerSnapshot[],
  scope: "workspace" | "user"
): string[] {
  return [
    ...new Set(
      workers
        .filter((worker) => worker.scope === scope)
        .map((worker) => worker.ownerId)
    ),
  ];
}
