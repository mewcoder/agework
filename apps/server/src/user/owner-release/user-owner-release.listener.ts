import { Inject, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import {
  userOwnerKey,
  type RuntimeHostDiagnostics,
  type RuntimeHostOperations,
  type WorkerSnapshot,
} from "@agework/shared/protocol";
import {
  USER_DELETED_EVENT,
  USER_DISABLED_EVENT,
  UserDeletedEvent,
  UserDisabledEvent,
} from "../user.events";
import {
  RUNTIME_HOST_CONNECTED_EVENT,
  RuntimeHostConnectedEvent,
} from "../../runtime-host/runtime-host.events";
import {
  RUNTIME_HOST_DIAGNOSTICS,
  RUNTIME_HOST_OPERATIONS,
} from "../../runtime-host/runtime-host.types";
import { UserRepository } from "../user.repository";

/**
 * user-scope owner 生命周期 → Host worker 释放(辅助逻辑跟数据走,
 * user owner 的存活判断归本模块)。
 *
 * - user 禁用/删除 → 现场查该用户 user-scope worker 所在的 Host,逐台定向释放
 *   (user worker 可能分布在多台 Host,事件不带 host,按现场快照定位)。
 * - Host 重连注册成功 → 对账兜底:现场快照里用户已禁用/软删的补发定向释放。
 *
 * 全部 best-effort:失败只告警,等下次事件/重连再补。
 */
@Injectable()
export class UserOwnerReleaseListener {
  private readonly logger = new Logger(UserOwnerReleaseListener.name);

  constructor(
    @Inject(RUNTIME_HOST_OPERATIONS)
    private readonly hostOperations: RuntimeHostOperations,
    @Inject(RUNTIME_HOST_DIAGNOSTICS)
    private readonly hostDiagnostics: RuntimeHostDiagnostics,
    private readonly userRepository: UserRepository
  ) {}

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
        await this.releaseOwnerOn(runtimeHostId, userId);
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
      const userIds = distinctUserOwnerIds(workers);
      if (userIds.length === 0) return;
      const activeIds = new Set(
        await this.userRepository.listActiveIds(userIds)
      );
      for (const userId of userIds) {
        if (activeIds.has(userId)) continue;
        this.logger.log(
          `reconcile: releasing workers of deactivated user ${userId} on host ${runtimeHostId}`
        );
        await this.releaseOwnerOn(runtimeHostId, userId);
      }
    } catch (err) {
      // best-effort:失败等下次重连再对账
      this.logger.warn(
        `user owner reconcile failed for ${runtimeHostId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  private async releaseOwnerOn(
    runtimeHostId: string,
    userId: string
  ): Promise<void> {
    try {
      await this.hostOperations.releaseOwner({
        runtimeHostId,
        owner: userOwnerKey(userId),
      });
    } catch (err) {
      this.logger.warn(
        `releaseOwner(user:${userId}) failed on host ${runtimeHostId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
}

function distinctUserOwnerIds(workers: WorkerSnapshot[]): string[] {
  return [
    ...new Set(
      workers
        .filter((worker) => worker.scope === "user")
        .map((worker) => worker.ownerId)
    ),
  ];
}
