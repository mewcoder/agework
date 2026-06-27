import { Injectable, Logger } from "@nestjs/common";
import { RunRepository } from "../run.repository";
import { RuntimeProviderRegistry } from "../../runtime/providers/provider-registry";
import { ExecutionService } from "../execution/execution.service";
import { RunConversationEffects } from "../conversation/run-conversation.effects";
import { PrismaService } from "../../prisma/prisma.service";
import { swallow } from "../../common/swallow";
import {
  runtimeInstanceMetadataJson,
  stoppedInstanceMetadata,
} from "../../runtime/instances/runtime-instance-metadata";

/**
 * 服务重启后恢复中断 run：找到所有仍处于 active 状态的 run，
 * 让对应 run executor 清理底层进程/容器，并将 run/thread 状态标记为 error。
 */
@Injectable()
export class RunRecoveryService {
  private readonly logger = new Logger(RunRecoveryService.name);

  constructor(
    private readonly runRepository: RunRepository,
    private readonly runConversation: RunConversationEffects,
    private readonly executionService: ExecutionService,
    private readonly runtimeProviderRegistry: RuntimeProviderRegistry,
    private readonly prisma: PrismaService
  ) {}

  async recoverInterruptedRuns(): Promise<void> {
    try {
      const activeRuns = await this.runRepository.findAllActive();
      if (activeRuns.length === 0) {
        this.logger.log("No interrupted active runs found.");
      } else {
        this.logger.warn(
          `Found ${activeRuns.length} interrupted active run(s) — marking as error`
        );

        for (const run of activeRuns) {
          if (run.runtimeInstanceId) {
            // User-scope runtimes are shared across workspaces — destroying the
            // container/sandbox because one run was interrupted would kill the others.
            // Only cleanup interrupted execution when the runtime is NOT user-scoped.
            const shouldCleanupInterruptedRuntime =
              await this.shouldCleanupInterruptedRuntimeResource(
                run.runtimeInstanceId,
                run.runtimeType
            );
            if (shouldCleanupInterruptedRuntime) {
              await this.executionService
                .cleanupInterruptedExecution(run.runtimeType, run.runtimeInstanceId)
                .catch(swallow(this.logger, `cleanup interrupted run ${run.id}`));
            } else {
              this.logger.log(
                `Skipping interrupted execution cleanup for user-scope runtime resource ${run.runtimeInstanceId} (run ${run.id})`
              );
            }
          }

          await this.runRepository.markError(run.id, "服务重启导致运行中断");
          await this.runConversation
            .markError(run.conversationId)
            .catch(
              swallow(
                this.logger,
                `set conversation active run status to error for run ${run.id}`
              )
            );

          this.logger.log(`Marked interrupted run ${run.id} as error`);
        }
      }
    } catch (err) {
      this.logger.error(
        `Failed to cleanup interrupted runs: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    await this.recoverOrphanContainers();
    await this.cleanupStaleRuntimeInstances();
  }

  /**
   * Decide whether run-level interrupted execution cleanup is allowed.
   * User-isolated RuntimeTarget resources can be shared across workspaces, so
   * destroying one because a single run was interrupted would be destructive.
   */
  private async shouldCleanupInterruptedRuntimeResource(
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
              `cleanup interrupted runtime resource ${resource.runtimeInstanceId}`
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
