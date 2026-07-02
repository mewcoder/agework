import type {
  CommandPayload,
  RunChannelMessage,
  RunConfig,
  UpstreamMessage,
  CommandResultPayload,
} from "@agework/shared/protocol";
import {
  commandResultMessageToRpcResponse,
  isRunConfigRpcNotification,
  isWorkerCommandRpcRequest,
  rpcNotificationToRunConfigMessage,
  rpcRequestToCommandMessage,
  upstreamMessageToRpcNotification,
} from "@agework/shared/protocol/rpc";
import type { CommandClient } from "../commands.js";
import type { RunnerManagerClient } from "../runner-manager.js";
import { errorDetails, workerLog } from "../logging/worker-log.js";

type PendingPoll = {
  resolve: (commands: RunChannelMessage<CommandPayload>[]) => void;
  timer?: ReturnType<typeof setTimeout>;
};

type PendingConfigFetch = {
  resolve: (config: RunConfig) => void;
};

/**
 * Keep-alive worker 的 IPC 版通信客户端。跟 HttpTransport 实现完全相同的
 * CommandClient/RunnerManagerClient 接口,背后走 process.send/process.on("message")
 * 而不是 HTTP 长轮询——RunnerManager/WorkerCommands 因此不需要认识这个类的存在。
 *
 * 命令用一个内存队列缓冲(process 推送式到达,pollCommands 拉取式消费,两者速率不
 * 匹配时靠这个队列做适配层);run config 按 runId 单独等待,因为同一个 keep-alive
 * 进程生命周期内会依次服务多个 run,每个 run 各自 fetch 一次。
 */
export class IpcKeepAliveTransport
  implements CommandClient, RunnerManagerClient
{
  private readonly commandBuffer: RunChannelMessage<CommandPayload>[] = [];
  private readonly pollWaiters = new Set<PendingPoll>();
  private readonly configWaiters = new Map<string, PendingConfigFetch>();

  constructor() {
    if (!process.send) {
      throw new Error(
        "IpcKeepAliveTransport requires process to be forked with IPC"
      );
    }
    process.on("message", (msg: unknown) => this.handleMessage(msg));
  }

  pollCommands(waitMs = 0): Promise<RunChannelMessage<CommandPayload>[]> {
    if (this.commandBuffer.length > 0) {
      return Promise.resolve(this.drainCommandBuffer());
    }
    if (waitMs <= 0) {
      return Promise.resolve([]);
    }
    return new Promise((resolve) => {
      const waiter: PendingPoll = { resolve };
      waiter.timer = setTimeout(() => {
        this.pollWaiters.delete(waiter);
        resolve([]);
      }, waitMs);
      this.pollWaiters.add(waiter);
    });
  }

  fetchRunConfig(runId: string): Promise<RunConfig> {
    return new Promise((resolve) => {
      this.configWaiters.set(runId, { resolve });
    });
  }

  async emit(runId: string, msg: UpstreamMessage): Promise<void> {
    const wireMessage =
      msg.type === "command.result"
        ? commandResultMessageToRpcResponse(
            msg as RunChannelMessage<CommandResultPayload>
          )
        : upstreamMessageToRpcNotification(msg);
    return new Promise<void>((resolve, reject) => {
      process.send!(wireMessage, (err: Error | null) => {
        if (err) {
          workerLog(
            "ipc keep-alive emit failed",
            { runId, type: msg.type, ...errorDetails(err) },
            "error"
          );
          reject(err);
        } else resolve();
      });
    });
  }

  cleanup(runId: string): void {
    this.configWaiters.delete(runId);
  }

  private handleMessage(msg: unknown): void {
    if (isRunConfigRpcNotification(msg)) {
      const message = rpcNotificationToRunConfigMessage(msg);
      const waiter = this.configWaiters.get(message.runId);
      if (waiter) {
        this.configWaiters.delete(message.runId);
        waiter.resolve(message.payload);
      }
      return;
    }
    if (isWorkerCommandRpcRequest(msg)) {
      const command = rpcRequestToCommandMessage(msg);
      this.commandBuffer.push(command);
      this.resolvePollWaiters();
    }
  }

  private drainCommandBuffer(): RunChannelMessage<CommandPayload>[] {
    const drained = this.commandBuffer.splice(0, this.commandBuffer.length);
    return drained;
  }

  private resolvePollWaiters(): void {
    if (this.commandBuffer.length === 0) return;
    for (const waiter of [...this.pollWaiters]) {
      this.pollWaiters.delete(waiter);
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(this.drainCommandBuffer());
      if (this.commandBuffer.length === 0) break;
    }
  }
}
