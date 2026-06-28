import { Injectable } from "@nestjs/common";
import type { RunChannelMessage } from "@agework/shared/protocol";

/**
 * worker 上行事件的接收端：worker 经 HTTP `POST /worker/runs/:id/events`
 * 上报的 message（run.status / agui.event / sdk.raw）需要喂给拥有 run
 * 生命周期的一方（run 层）。由 run 在启动时注册实现，从而保持 worker-host → run 零依赖。
 */
export interface WorkerUpstreamReceiver {
  sendEvent(runId: string, message: RunChannelMessage): Promise<void>;
}

/**
 * worker-host 持有的上行事件转发注册表。WorkerRunController 经此把 worker 上报
 * 转发给 run 层，具体接收方由 run 在 onModuleInit 时通过 setReceiver 注入。
 */
@Injectable()
export class WorkerUpstreamRegistry {
  private receiver?: WorkerUpstreamReceiver;

  setReceiver(receiver: WorkerUpstreamReceiver): void {
    this.receiver = receiver;
  }

  sendEvent(runId: string, message: RunChannelMessage): Promise<void> {
    return this.receiver
      ? this.receiver.sendEvent(runId, message)
      : Promise.resolve();
  }
}
