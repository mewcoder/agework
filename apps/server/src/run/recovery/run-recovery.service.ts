import { Injectable, Inject, Logger } from "@nestjs/common";
import { generateId } from "@agework/shared";
import { RunRepository } from "../run.repository";
import { WorkerManagerService } from "../../worker-manager/worker-manager.service";
import {
  CONVERSATION_EFFECTS_PORT,
  type ConversationEffectsPort,
} from "../run.types";
import { swallow } from "../../common/swallow";

/**
 * 服务重启后恢复中断 run:找到所有仍处于 active 状态的 run,向它绑定的
 * runtime 实例(如果 WorkerRegistry 里还找得到)发一条 cancel 命令让 Worker
 * 自己收尾,不碰实例本身的生死——这个 run 中断不代表实例本身有问题,可能还在
 * 正常服务其它 run(仍待讨论第 12 条)。实例已经不在了,这条命令发出去没人
 * 收,无副作用。随后统一把 run/thread 状态标记为 error。
 */
@Injectable()
export class RunRecoveryService {
  private readonly logger = new Logger(RunRecoveryService.name);

  constructor(
    private readonly runRepository: RunRepository,
    @Inject(CONVERSATION_EFFECTS_PORT)
    private readonly conversationEffects: ConversationEffectsPort,
    private readonly workerManager: WorkerManagerService
  ) {}

  async failInterruptedRuns(): Promise<void> {
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
            await this.sendCancelToBoundInstance(run).catch(
              swallow(this.logger, `send cancel for interrupted run ${run.id}`)
            );
          }

          await this.runRepository.markError(run.id, "服务重启导致运行中断");
          await this.conversationEffects
            .setConversationRunState(run.conversationId, { runStatus: "error" })
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

  private async sendCancelToBoundInstance(run: {
    id: string;
    conversationId: string;
    runtimeType: string;
    runtimeInstanceId: string | null;
  }): Promise<void> {
    if (!run.runtimeInstanceId) return;
    // local worker 是 fork 的子进程,API 重启时必随父进程一起死;WorkerInstanceLifecycleHandler
    // 在 bootstrap 已经杀掉孤儿并标 stopped,这里再发 cancel 纯属打空气,直接跳过。只有 sandbox
    // 容器可能还活着,才有必要发 cancel 让仍在 poll 的 worker 自己收尾。
    if (run.runtimeType === "local") return;
    const resource = await this.workerManager.findRuntimeByRuntimeId(
      run.runtimeType,
      run.runtimeInstanceId
    );
    if (!resource) return;

    this.workerManager.sendCommand(resource.ownerId, run.id, {
      type: "cancel",
      commandId: generateId(),
      runId: run.id,
      conversationId: run.conversationId,
    });
  }
}
