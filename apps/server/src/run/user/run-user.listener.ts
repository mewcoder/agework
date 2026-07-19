import { Inject, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import {
  USER_DELETED_EVENT,
  USER_DISABLED_EVENT,
  UserDeletedEvent,
  UserDisabledEvent,
} from "../../user/user.events";
import {
  RUNTIME_HOST_RESOURCE_RECONCILIATION,
  type RuntimeHostResourceReconciliationPort,
} from "../../runtime-host/runtime-host.types";
import { RunService } from "../run.service";

/**
 * user 禁用/删除的执行面收尾编排(SPEC §8.2)。
 *
 * 两步有序:**先** cancel 该 user 名下所有活跃 run(两类 scope 都覆盖),
 * **再** 对相关 Host 调用 releaseResources(user target) 释放执行资源。
 * 顺序保证 run 以 cancelled 而非 worker-lost error 收场。
 *
 * user target 释放覆盖该用户的 user-scope 与所有 workspace-scope worker。
 * 事件携带的 sessionVersion 用于 Runtime generation fencing:re-enable 后
 * 迟到的旧 disable release 不得命中新 generation 的资源。
 *
 * **必须覆盖所有在线 Host**:in-flight submit 可能已读取旧 sessionVersion
 * 但尚未提交到 Runtime,此时 Runtime 无 claim。若只对有 claim 的 Host 下发
 * fence,旧 submit 仍会被接受。因此对所有在线 Host 下发 releaseResources,
 * 确保每台 Runtime 都安装 fence。
 *
 * 两步各自 best-effort:失败仅记录日志;释放遗漏由 user 模块的重连对账兜底。
 */
@Injectable()
export class RunUserListener {
  private readonly logger = new Logger(RunUserListener.name);

  constructor(
    private readonly runService: RunService,
    @Inject(RUNTIME_HOST_RESOURCE_RECONCILIATION)
    private readonly hostResources: RuntimeHostResourceReconciliationPort
  ) {}

  @OnEvent([USER_DISABLED_EVENT, USER_DELETED_EVENT])
  async onUserDeactivated({
    userId,
    sessionVersion,
  }: UserDisabledEvent | UserDeletedEvent): Promise<void> {
    // Step 1: cancel 该用户名下所有活跃 run(先于释放,保证 cancelled 语义)
    try {
      await this.runService.stopForUser(userId);
    } catch (err) {
      this.logger.warn(
        `stopForUser failed for user ${userId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }

    // Step 2: 对所有在线 Host 下发 releaseResources(user target)
    // 必须覆盖所有在线 Host,因为 in-flight submit 可能尚未在 Runtime 形成 claim
    try {
      const hostIds = this.hostResources.listConnectedHostIds();
      for (const runtimeHostId of hostIds) {
        await this.releaseUserResources(
          runtimeHostId,
          userId,
          sessionVersion
        );
      }
    } catch (err) {
      this.logger.warn(
        `release user resources failed for user ${userId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  private async releaseUserResources(
    runtimeHostId: string,
    userId: string,
    userLifecycleVersion: number
  ): Promise<void> {
    try {
      await this.hostResources.releaseResources({
        runtimeHostId,
        target: { type: "user", userId, userLifecycleVersion },
      });
    } catch (err) {
      this.logger.warn(
        `releaseResources(user:${userId},v${userLifecycleVersion}) failed on host ${runtimeHostId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
}
