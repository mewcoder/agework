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

const CONFIG_TIMEOUT_MS = 10_000;

type PendingPoll = {
  resolve: (commands: RunChannelMessage<CommandPayload>[]) => void;
  timer?: ReturnType<typeof setTimeout>;
};

type PendingConfigFetch = {
  resolve: (config: RunConfig) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * 常驻 worker 的 IPC 版通信客户端。跟 WorkerHttpTransport 实现完全相同的
 * CommandClient/RunnerManagerClient 接口,背后走 process.send/process.on("message")
 * 而不是 HTTP 长轮询——RunnerManager/WorkerCommands 因此不需要认识这个类的存在。
 *
 * 命令用一个内存队列缓冲(process 推送式到达,pollCommands 拉取式消费,两者速率不
 * 匹配时靠这个队列做适配层);run config 按 runId 单独等待,因为同一个常驻
 * 进程生命周期内会依次服务多个 run,每个 run 各自 fetch 一次。
 */
export class WorkerIpcTransport
  implements CommandClient, RunnerManagerClient
{
  private readonly commandBuffer: RunChannelMessage<CommandPayload>[] = [];
  private readonly pollWaiters = new Set<PendingPoll>();
  private readonly configWaiters = new Map<string, PendingConfigFetch>();
  /**
   * run.config 是父进程主动推送(openSession 先于 sendCommand 发出),不是像命令那样
   * 等 fetchRunConfig 来拉取。两者到达/消费的先后顺序不保证一致——config 消息可能在
   * fetchRunConfig 第一次被调用之前就到达,这种情况下必须先缓存,否则会被 handleMessage
   * 直接丢弃,导致 fetchRunConfig 的 waiter 永远等不到已经错过的消息(深层后果:
   * RunnerManager.handle 顺序 await,一个 run 的 fetchRunConfig 卡死会拖死同一个
   * worker 进程后续所有 run 的处理)。
   */
  private readonly configBuffer = new Map<string, RunConfig>();

  constructor() {
    if (!process.send) {
      throw new Error(
        "WorkerIpcTransport requires process to be forked with IPC"
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
    const buffered = this.configBuffer.get(runId);
    if (buffered) {
      this.configBuffer.delete(runId);
      return Promise.resolve(buffered);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.configWaiters.delete(runId);
        reject(new Error(`Timed out waiting for run.config for run ${runId}`));
      }, CONFIG_TIMEOUT_MS);
      this.configWaiters.set(runId, { resolve, reject, timer });
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
            "worker ipc emit failed",
            { runId, type: msg.type, ...errorDetails(err) },
            "error"
          );
          reject(err);
        } else resolve();
      });
    });
  }

  cleanup(runId: string): void {
    const waiter = this.configWaiters.get(runId);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.configWaiters.delete(runId);
    }
    this.configBuffer.delete(runId);
  }

  private handleMessage(msg: unknown): void {
    if (isRunConfigRpcNotification(msg)) {
      const message = rpcNotificationToRunConfigMessage(msg);
      const waiter = this.configWaiters.get(message.runId);
      if (waiter) {
        clearTimeout(waiter.timer);
        this.configWaiters.delete(message.runId);
        waiter.resolve(message.payload);
      } else {
        this.configBuffer.set(message.runId, message.payload);
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
