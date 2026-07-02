import { Injectable } from "@nestjs/common";
import type { RunChannelMessage } from "@agework/shared/protocol";
import type { WorkerUpstreamPort } from "../worker-host.types";

/**
 * worker-host 持有的上行事件转发注册表。WorkerRunController 经此把 worker 上报
 * 转发给 run 层，具体接收方由 run startup provider 通过 setUpstreamPort 注入。
 */
@Injectable()
export class WorkerUpstreamRegistry {
  private receiver?: WorkerUpstreamPort;

  setUpstreamPort(receiver: WorkerUpstreamPort): void {
    this.receiver = receiver;
  }

  sendEvent(runId: string, message: RunChannelMessage): Promise<void> {
    return this.receiver
      ? this.receiver.sendEvent(runId, message)
      : Promise.resolve();
  }
}
