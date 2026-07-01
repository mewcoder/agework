import { Injectable, Logger } from "@nestjs/common";
import { RunRepository } from "../run.repository";
import { RuntimeService } from "../../runtime/runtime.service";
import { ExecutionService } from "../execution/execution.service";
import { ConversationService } from "../../conversation/conversation.service";
import { swallow } from "../../common/swallow";

/**
 * 服务重启后恢复中断 run：找到所有仍处于 active 状态的 run，
 * 让对应 run executor 清理底层进程/容器，并将 run/thread 状态标记为 error。
 * 运行环境资源（孤儿容器 / stale 资源）的恢复属于 runtime 领域，委托给 RuntimeService。
 */
@Injectable()
export class RunRecoveryService {
  private readonly logger = new Logger(RunRecoveryService.name);

  constructor(
    private readonly runRepository: RunRepository,
    private readonly conversations: ConversationService,
    private readonly executionService: ExecutionService,
    private readonly runtimeService: RuntimeService
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
                .cleanupInterruptedExecution(
                  run.runtimeType,
                  run.runtimeInstanceId
                )
                .catch(
                  swallow(this.logger, `cleanup interrupted run ${run.id}`)
                );
            } else {
              this.logger.log(
                `Skipping interrupted execution cleanup for user-scope runtime resource ${run.runtimeInstanceId} (run ${run.id})`
              );
            }
          }

          await this.runRepository.markError(run.id, "服务重启导致运行中断");
          await this.conversations
            .setRunStatus(run.conversationId, "error")
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
  }

  /**
   * Decide whether run-level interrupted execution cleanup is allowed.
   * User-isolated runtime resources can be shared across workspaces, so destroying
   * one because a single run was interrupted would be destructive. 查询失败时
   * 保守处理（视为 user 级），跳过清理。
   */
  private async shouldCleanupInterruptedRuntimeResource(
    runtimeInstanceId: string,
    runtimeType: string
  ): Promise<boolean> {
    const userScoped = await this.runtimeService
      .isRuntimeInstanceUserScoped(runtimeType, runtimeInstanceId)
      .catch(() => true);
    return !userScoped;
  }
}
