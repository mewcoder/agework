import { Injectable, Logger } from "@nestjs/common";
import { RunRepository } from "../run.repository";
import { RuntimeProviderRegistry } from "../../runtime/providers/provider-registry";
import { ConversationService } from "../../conversations/conversation.service";
import { PrismaService } from "../../prisma/prisma.service";
import { swallow } from "../../common/swallow";
import {
  runtimeInstanceMetadataJson,
  stoppedInstanceMetadata,
} from "../../runtime/instances/runtime-instance-metadata";

/**
 * 服务重启后恢复孤儿 run：找到所有仍处于 active 状态的 run，
 * 让对应 provider 清理底层进程/容器，并将 run/thread 状态标记为 error。
 */
@Injectable()
export class RunRecoveryUseCase {
  private readonly logger = new Logger(RunRecoveryUseCase.name);

  constructor(
    private readonly runService: RunRepository,
    private readonly conversationService: ConversationService,
    private readonly runtimeProviderRegistry: RuntimeProviderRegistry,
    private readonly prisma: PrismaService
  ) {}

  async recoverOrphanRuns(): Promise<void> {
    try {
      const activeRuns = await this.runService.findAllActive();
      if (activeRuns.length === 0) {
        this.logger.log("No orphan runs found.");
      } else {
        this.logger.warn(
          `Found ${activeRuns.length} orphan run(s) — marking as error`
        );

        for (const run of activeRuns) {
          if (run.runtimeInstanceId) {
            const provider = this.runtimeProviderRegistry.resolve(
              run.runtimeType
            );

            // User-scope runtimes are shared across workspaces — destroying the
            // container/sandbox because one run is orphaned would kill the others.
            // Only call recoverOrphan when the runtime is NOT user-scoped.
            const shouldRecoverOrphan =
              await this.shouldRecoverOrphanRuntime(run.runtimeInstanceId, run.runtimeType);
            if (shouldRecoverOrphan) {
              await provider
                .recoverOrphan(run.runtimeInstanceId)
                .catch(swallow(this.logger, `recover orphan run ${run.id}`));
            } else {
              this.logger.log(
                `Skipping recoverOrphan for user-scope runtime resource ${run.runtimeInstanceId} (run ${run.id})`
              );
            }
          }

          await this.runService.markError(run.id, "服务重启导致运行中断");
          await this.conversationService
            .setActiveRunStatus(run.conversationId, "error")
            .catch(
              swallow(
                this.logger,
                `set conversation active run status to error for run ${run.id}`
              )
            );

          this.logger.log(`Marked orphan run ${run.id} as error`);
        }
      }
    } catch (err) {
      this.logger.error(
        `Failed to recover orphan runs: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    await this.recoverOrphanContainers();
    await this.cleanupStaleRuntimeInstances();
  }

  /**
   * Determine whether we should call provider.recoverOrphan() for a given run.
   * Returns false when the run's runtimeInstanceId belongs to a user-isolated
   * RuntimeTarget — destroying a shared user runtime would be destructive.
   * Returns true when no RuntimeTarget exists (legacy data) or when the
   * resource is not user-isolated.
   */
  private async shouldRecoverOrphanRuntime(
    runtimeInstanceId: string,
    runtimeType: string
  ): Promise<boolean> {
    try {
      const resource = await this.prisma.runtimeInstance.findUnique({
        where: {
          runtimeType_runtimeInstanceId: {
            runtimeType,
            runtimeInstanceId,
          },
        },
      });
      if (resource?.isolationScope === "user") {
        return false;
      }
    } catch {
      // If lookup fails, err on the side of caution: skip recovery
      return false;
    }
    return true;
  }

  /**
   * 服务重启后，所有内存中的 scope 状态都已丢失：将所有仍标记为 running 的
   * RuntimeTarget 视为孤儿，停止其底层容器/沙箱。user-scope 的资源在所属用户
   * 仍然存在时保留，用户已删除的则一并清理。清理后将状态标记为 stopped。
   */
  private async recoverOrphanContainers(): Promise<void> {
    try {
      const runningResources = await this.prisma.runtimeInstance.findMany({
        where: { status: "running" },
      });

      if (runningResources.length === 0) {
        this.logger.log("No orphan runtime resources found.");
        return;
      }

      this.logger.warn(
        `Found ${runningResources.length} orphan runtime resource(s) — stopping them`
      );

      for (const resource of runningResources) {
        if (resource.isolationScope === "user") {
          const owner = await this.prisma.user.findFirst({
            where: { id: resource.ownerId, deletedAt: null },
          });
          if (owner) {
            this.logger.log(
              `Skipping recoverOrphan for user-scope runtime resource ${resource.runtimeInstanceId} (user ${resource.ownerId} still exists)`
            );
            continue;
          }
          this.logger.log(
            `User ${resource.ownerId} no longer exists — cleaning up orphan user-scope resource ${resource.runtimeInstanceId}`
          );
        }

        const provider = this.runtimeProviderRegistry.resolve(
          resource.runtimeType
        );
        await provider
          .recoverOrphan(resource.runtimeInstanceId)
          .catch(
            swallow(
              this.logger,
              `recover orphan runtime resource ${resource.runtimeInstanceId}`
            )
          );
        await this.prisma.runtimeInstance.update({
          where: { id: resource.id },
          data: {
            status: "stopped",
            metadata: runtimeInstanceMetadataJson(
              stoppedInstanceMetadata({
                runtimeType: resource.runtimeType,
                isolationScope: resource.isolationScope,
                ownerId: resource.ownerId,
                reason: "orphan_recovered",
              })
            ),
          },
        });
      }
    } catch (err) {
      this.logger.warn(
        `Failed to recover orphan containers: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * 清理已明确标记为 stale 的 RuntimeTarget。
   * 不能只因为服务重启后内存为空就清理 running resource；运行环境可能仍在外部存活，
   * 应由 provider 下次启动时通过 runtimeInstanceId 验证。
   */
  private async cleanupStaleRuntimeInstances(): Promise<void> {
    try {
      const resourceResult = await this.prisma.runtimeInstance.deleteMany({
        where: { status: "stale" },
      });
      if (resourceResult.count > 0) {
        this.logger.log(`Deleted ${resourceResult.count} stale runtime resource(s)`);
      }
    } catch (err) {
      this.logger.warn(
        `Failed to cleanup stale runtime resources: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
