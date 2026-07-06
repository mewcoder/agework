import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import {
  WORKER_LOST_EVENT,
  WorkerLostEvent,
} from "../../worker-manager/worker-manager.events";
import { WorkerEventService } from "./worker-event.service";

/**
 * 监听 worker-manager 心跳超时 fence 时发出的 WorkerLostEvent,把对应 run 强制
 * 推进终态。best-effort:失败仅记录日志,不影响 fence 来源操作本身。
 */
@Injectable()
export class WorkerLostListener {
  private readonly logger = new Logger(WorkerLostListener.name);

  constructor(private readonly workerEvents: WorkerEventService) {}

  @OnEvent(WORKER_LOST_EVENT)
  async onWorkerLost({ runId, reason }: WorkerLostEvent): Promise<void> {
    try {
      await this.workerEvents.notifyWorkerLost(runId, reason);
    } catch (err) {
      this.logger.warn(
        `notifyWorkerLost failed for run ${runId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
