import type {
  RunChannel,
  RunConfig,
  UpstreamMessage,
  UpstreamMessageInput,
  CommandPayload,
  CommandResultPayload,
  RunChannelMessage,
  Unsubscribe,
} from "@agework/shared/protocol";
import {
  commandResultMessageToRpcResponse,
  isRunConfigRpcNotification,
  isWorkerCommandRpcRequest,
  rpcNotificationToRunConfigMessage,
  rpcRequestToCommandMessage,
  upstreamMessageToRpcNotification,
} from "@agework/shared/protocol/rpc";
import { errorDetails, workerLog } from "../logging/worker-log.js";

const CONFIG_TIMEOUT_MS = 10_000;

/**
 * RunChannel 的本地子进程实现。
 * 通过 Node.js IPC channel（process.send / process.on("message")）
 * 与父进程（常驻 worker）通信。
 */
export class RunnerIpcTransport implements RunChannel {
  private seq = 0;
  private readonly runId: string;

  constructor() {
    if (!process.send) {
      throw new Error("RunnerIpcTransport requires process to be forked with IPC");
    }
    this.runId = process.env.AGEWORK_WORKER_RUN_ID ?? "";
  }

  fetchRunConfig(): Promise<RunConfig> {
    return new Promise<RunConfig>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Timed out waiting for run.config"));
        process.exit(1);
      }, CONFIG_TIMEOUT_MS);

      const handler = (msg: unknown) => {
        const config = runConfigFromIpcMessage(msg);
        if (config) {
          clearTimeout(timer);
          process.removeListener("message", handler);
          resolve(config);
        }
      };
      process.on("message", handler);
    });
  }

  async emit(msg: UpstreamMessageInput): Promise<void> {
    const message = {
      ...msg,
      runId: this.runId,
      seq: ++this.seq,
      ts: new Date().toISOString(),
    } as UpstreamMessage;
    const wireMessage = encodeUpstreamMessageForIpc(message);
    return new Promise<void>((resolve, reject) => {
      process.send!(wireMessage, (err: Error | null) => {
        if (err) {
          // IPC channel 没有重试机制，发送失败即事件丢失，必须 error 级可见。
          workerLog("ipc emit failed", {
            runId: this.runId,
            seq: message.seq,
            type: message.type,
            source: "worker",
            eventType: "emit.failed",
            ...errorDetails(err),
          }, "error");
          reject(err);
        } else resolve();
      });
    });
  }

  subscribeCommands(
    cb: (command: RunChannelMessage<CommandPayload>) => void
  ): Unsubscribe {
    const handler = (msg: unknown) => {
      const command = commandFromIpcMessage(msg);
      if (command) {
        cb(command);
      }
    };
    process.on("message", handler);
    return () => {
      process.removeListener("message", handler);
    };
  }

  async close(): Promise<void> {
    if (process.connected) {
      process.disconnect();
    }
  }
}

function runConfigFromIpcMessage(msg: unknown): RunConfig | undefined {
  if (isRunConfigRpcNotification(msg)) {
    return rpcNotificationToRunConfigMessage(msg).payload;
  }
  return undefined;
}

function commandFromIpcMessage(
  msg: unknown
): RunChannelMessage<CommandPayload> | undefined {
  if (isWorkerCommandRpcRequest(msg)) {
    return rpcRequestToCommandMessage(msg);
  }
  return undefined;
}

function encodeUpstreamMessageForIpc(msg: UpstreamMessage) {
  if (msg.type === "command.result") {
    return commandResultMessageToRpcResponse(
      msg as RunChannelMessage<CommandResultPayload>
    );
  }
  return upstreamMessageToRpcNotification(msg);
}
