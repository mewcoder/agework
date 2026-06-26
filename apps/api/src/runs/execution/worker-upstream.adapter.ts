import { Injectable, Logger } from "@nestjs/common";
import type { RunStatus } from "@agework/shared";
import type { Envelope, RunStatusPayload } from "@agework/shared/protocol";
import type { WorkerUpstreamReceiver } from "../../worker-host/worker-upstream.registry";
import { RunEnvelopeProcessor } from "./run-envelope.processor";
import { RunActiveStore } from "./run-active.store";
import { RunDriver } from "./run-driver";
import { safeLogJson, summarizeEnvelopePayload } from "../../common/logging";

const TERMINAL_RUN_STATUSES: RunStatus[] = ["finished", "error", "cancelled"];

/**
 * run 侧实现 worker-host 的 WorkerUpstreamReceiver port：消费 worker 上行 envelope，
 * 入库（RunEnvelopeProcessor）、喂 run 级心跳 watchdog、终态后清理 provider 状态。
 */
@Injectable()
export class WorkerUpstreamAdapter implements WorkerUpstreamReceiver {
  private readonly logger = new Logger(WorkerUpstreamAdapter.name);

  constructor(
    private readonly runEventProcessor: RunEnvelopeProcessor,
    private readonly runRegistry: RunActiveStore,
    private readonly runDriver: RunDriver
  ) {}

  async ingestEvent(runId: string, envelope: Envelope): Promise<void> {
    this.logger.debug(
      `worker event received ${safeLogJson({
        runId,
        envelopeRunId: envelope.runId,
        seq: envelope.seq,
        type: envelope.type,
        payload: summarizeEnvelopePayload(envelope.payload),
      })}`
    );
    // 发布前先取出 handle：RunEnvelopeProcessor 在终态时会 unregister，之后就拿不到 runtimeType 了
    const handle = this.runRegistry.get(runId);

    // RunEnvelopeProcessor 内部做 seq 去重
    await this.runEventProcessor.publish(envelope).catch((err) => {
      this.logger.warn(
        `RunEnvelopeProcessor.publish failed for runId=${runId}: ${String(err)}`
      );
    });

    // worker 心跳上报：喂给对应 provider 的心跳 watchdog（HTTP transport 场景下
    // 这是唯一的喂狗入口，IPC transport 由 child.on("message") 直接喂狗）。
    if (envelope.type === "heartbeat" && handle) {
      this.runDriver.heartbeat(handle.runtimeHandle);
    }

    // worker 上报终态后清理 provider 内部状态（心跳定时器等），
    // 避免心跳超时分支在 run 已结束后仍触发并覆盖终态。
    if (envelope.type === "run.status") {
      const { status } = envelope.payload as RunStatusPayload;
      if (TERMINAL_RUN_STATUSES.includes(status) && handle) {
        this.runDriver.cleanup(handle.runtimeHandle);
      }
    }
  }
}
