import type {
  RuntimeChannel,
  RunConfig,
  UpstreamMessage,
  CommandPayload,
  Envelope,
  Unsubscribe,
} from "@agework/shared/protocol";
import { errorDetails, workerLog } from "./worker-log.js";

const CONFIG_TIMEOUT_MS = 10_000;

/**
 * RuntimeChannel 的本地子进程实现。
 * 通过 Node.js IPC channel（process.send / process.on("message")）
 * 与父进程（API）通信。
 */
export class IpcChannel implements RuntimeChannel {
  private seq = 0;
  private readonly runId: string;

  constructor() {
    if (!process.send) {
      throw new Error("IpcChannel requires process to be forked with IPC");
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
        if (isEnvelope(msg) && msg.type === "run.config") {
          clearTimeout(timer);
          process.removeListener("message", handler);
          resolve(msg.payload as RunConfig);
        }
      };
      process.on("message", handler);
    });
  }

  async emit(msg: UpstreamMessage): Promise<void> {
    const envelope = {
      ...msg,
      runId: this.runId,
      seq: ++this.seq,
      ts: new Date().toISOString(),
    };
    return new Promise<void>((resolve, reject) => {
      process.send!(envelope, (err: Error | null) => {
        if (err) {
          // IPC channel 没有重试机制，发送失败即事件丢失，必须 error 级可见。
          workerLog("ipc emit failed", {
            runId: this.runId,
            seq: envelope.seq,
            type: envelope.type,
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
    cb: (command: Envelope<CommandPayload>) => void
  ): Unsubscribe {
    const handler = (msg: unknown) => {
      if (isEnvelope(msg) && msg.type === "command") {
        cb(msg as Envelope<CommandPayload>);
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

function isEnvelope(msg: unknown): msg is Envelope {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "type" in msg &&
    typeof (msg as Record<string, unknown>).type === "string"
  );
}
