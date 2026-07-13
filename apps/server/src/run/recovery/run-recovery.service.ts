import { Inject, Injectable, Logger } from "@nestjs/common";
import type { RuntimeHostContract } from "@agework/shared/protocol";
import { RunRepository } from "../run.repository";
import { RUNTIME_HOST_CONTRACT } from "../../worker-manager/worker-manager.types";
import { ConversationService } from "../../conversation/conversation.service";
import { swallow } from "../../common/swallow";

/**
 * 服务重启后恢复中断 run:找到所有仍处于 active 状态的 run,经执行面契约向它
 * 绑定的载体(如果还找得到)发一条 cancel 命令让 Worker 自己收尾,不碰载体本身
 * 的生死——这个 run 中断不代表载体有问题,可能还在正常服务其它 run。载体已经
 * 不在了,这条命令发出去没人收,无副作用。随后统一把 run/thread 状态标记为 error。
 */
@Injectable()
export class RunRecoveryService {
  private readonly logger = new Logger(RunRecoveryService.name);

  constructor(
    private readonly runRepository: RunRepository,
    private readonly conversationService: ConversationService,
    @Inject(RUNTIME_HOST_CONTRACT)
    private readonly runtimeHost: RuntimeHostContract
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
          await this.conversationService
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
    // native 跳过等判断收在契约实现内(native worker 随 server 重启必死,发了也没人收)。
    await this.runtimeHost.sendRecoveryCancel({
      runId: run.id,
      conversationId: run.conversationId,
      ref: {
        runtimeType: run.runtimeType,
        runtimeInstanceId: run.runtimeInstanceId,
      },
    });
  }
}
