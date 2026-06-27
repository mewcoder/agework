import type {
  CommandPayload,
  RunChannelMessage,
  RunConfig,
  RunStatusPayload,
  AGUIEvent,
  CommandResultPayload,
  RuntimeChannel,
} from "@agework/shared/protocol";
import { CommandLoop } from "./command-loop.js";
import { IpcChannel } from "./ipc-channel.js";
import { PersistentHttpClient } from "./persistent-http-client.js";
import { PersistentRunManager } from "./persistent-run-manager.js";
import {
  errorDetails,
  setWorkerLogContext,
  setWorkerLogFilePath,
  workerLog,
} from "./worker-log.js";
import { AgentEventTraceWriter } from "./agent-event-trace.js";
import { createAdapterAgentDriver } from "./adapter-agent-driver.js";
import { toAgentRunInput } from "./agent-driver.js";

const COMMAND_LONG_POLL_MS = 25_000;
const COMMAND_EMPTY_RETRY_DELAY_MS = 1_000;
const SHUTDOWN_GRACE_MS = 8_000;

function createChannel(): RuntimeChannel {
  // 单 run worker 只用 IPC（local provider fork）。沙箱/持久容器走 runPersistent。
  if (!process.send) {
    workerLog("IPC transport requires process to be forked with IPC channel", undefined, "error");
    process.exit(1);
  }
  return new IpcChannel();
}

async function main() {
  if (
    process.env.AGEWORK_WORKER_CHANNEL === "http" &&
    process.env.AGEWORK_WORKER_OWNER_ID
  ) {
    return runPersistent();
  }
  return runSingle();
}

async function runSingle() {
  const transport = createChannel();
  const config: RunConfig = await transport.fetchRunConfig();
  setWorkerLogFilePath(config.workerLogFilePath);
  const { runId, conversationId } = config;
  setWorkerLogContext({
    runId,
    conversationId,
    workspaceId: config.workspaceId,
    agentType: config.agentProviderConfig.agentType,
    runtimePath: config.runtimePath,
    agentProviderSource: config.agentProviderConfig.source,
  });
  workerLog("single run config loaded");
  const trace = new AgentEventTraceWriter(config.agentEventTrace, (msg) => {
    void transport.emit(msg);
  });

  // Construct driver based on config.agentProviderConfig.agentType.
  const driver = createAdapterAgentDriver(
    config,
    trace.sink(),
    (_threadId, payload) => {
      void emitStatus(transport, runId, payload);
    }
  );

  // Emit "running" status
  await emitStatus(transport, runId, { status: "running" });

  // Command dedup
  const processedCommands = new Set<string>();
  let stopRequested = false;
  let forcedExitRequested = false;
  let finalizePromise: Promise<void> | undefined;

  // Subscribe to command messages
  transport.subscribeCommands((message: RunChannelMessage<CommandPayload>) => {
    const command = message.payload;
    if (processedCommands.has(command.commandId)) return;
    processedCommands.add(command.commandId);
    workerLog("single worker received command", {
      runId,
      commandId: command.commandId,
      source: "command",
      eventType: command.type,
    });
    emitCommandTrace(transport, runId, "received", command);

    switch (command.type) {
      case "cancel":
        stopRequested = true;
        void driver.cancel(conversationId).catch((err) => {
          const error = String(err);
          emitCommandTrace(transport, runId, "failed", command, error);
        });
        emitCommandTrace(transport, runId, "handled", command);
        emitCommandResult(transport, runId, command, "ok");
        break;
      case "interrupt":
        void driver.interrupt().catch((err) => {
          const error = String(err);
          emitCommandTrace(transport, runId, "failed", command, error);
        });
        emitCommandTrace(transport, runId, "handled", command);
        emitCommandResult(transport, runId, command, "ok");
        break;
      case "approval_resolved":
        void Promise.resolve(driver.resolveControl(command)).then((resolved) => {
          if (resolved) {
            emitCommandTrace(transport, runId, "handled", command);
            emitCommandResult(transport, runId, command, "ok");
          } else {
            const error = "no pending control matched";
            emitCommandTrace(transport, runId, "failed", command, error);
            emitCommandResult(transport, runId, command, "error", error);
          }
        }).catch((err) => {
          const error = String(err);
          emitCommandTrace(transport, runId, "failed", command, error);
          emitCommandResult(transport, runId, command, "error", error);
        });
        break;
      case "user_message":
        // 仅 persistent 模式处理；single 模式每个 run 独立 worker，无复用
        break;
    }
  });

  // Run the driver
  driver.run(toAgentRunInput(config.input, conversationId)).subscribe({
    next: (event: unknown) => {
      trace.writeAgui(event);
      transport
        .emit({
          runId,
          seq: 0,
          type: "agui.event",
          payload: event as AGUIEvent,
          ts: "",
        })
        .catch(() => {});
    },
    complete: () => {
      void finalize(stopRequested ? "cancelled" : "finished");
    },
    error: (err: Error) => {
      if (stopRequested) {
        void finalize("cancelled");
      } else {
        void finalize("error", err.message);
      }
    },
  });

  // Parent disconnect → self-terminate (IPC only)
  if (process.connected) {
    process.on("disconnect", () => {
      void forceExitAfterInterrupt("parent disconnect", 1);
    });
  }

  async function forceExitAfterInterrupt(reason: string, code: number) {
    if (forcedExitRequested) return;
    if (finalizePromise) return;
    forcedExitRequested = true;

    const forceExitTimer = setTimeout(() => {
      workerLog("single worker interrupt grace period exceeded", {
        runId,
        reason,
      }, "error");
      process.exit(code);
    }, SHUTDOWN_GRACE_MS);
    forceExitTimer.unref();

    try {
      await driver.interrupt();
    } catch (err) {
      workerLog("single worker interrupt before exit failed", {
        runId,
        reason,
        ...errorDetails(err),
      }, "error");
    } finally {
      clearTimeout(forceExitTimer);
      process.exit(code);
    }
  }

  async function finalize(
    status: "finished" | "error" | "cancelled",
    error?: string
  ) {
    if (forcedExitRequested) return;
    finalizePromise ??= doFinalize(status, error);
    return finalizePromise;
  }

  async function doFinalize(
    status: "finished" | "error" | "cancelled",
    error?: string
  ) {
    // 终态上报必须成功：失败时 API 侧 Run 会卡在 running 直到 run 超时。
    // 此时以非零退出，让 LocalRuntimeProvider 的 exit handler（code !== 0）
    // 立即触发 publishWorkerErrorStatus 将 Run 标记为 error。
    let statusReported = false;
    try {
      await emitStatus(transport, runId, {
        status,
        ...(error ? { error } : {}),
      });
      statusReported = true;
    } catch (err) {
      workerLog("finalize failed to report final status", {
        runId,
        source: "worker",
        eventType: "status.terminal_failed",
        ...errorDetails(err),
      }, "error");
    }
    // transport.close() 失败不影响已上报的终态，单独吞掉
    await transport.close().catch((err) => {
      workerLog("finalize failed to close transport", errorDetails(err), "warn");
    });
    process.exit(statusReported ? 0 : 1);
  }
}

async function runPersistent() {
  const client = new PersistentHttpClient();
  const runManager = new PersistentRunManager(client);
  const commandLoop = new CommandLoop(
    client,
    (command) => runManager.handle(command),
    {
      waitMs: COMMAND_LONG_POLL_MS,
      emptyRetryDelayMs: COMMAND_EMPTY_RETRY_DELAY_MS,
    }
  );
  workerLog("persistent worker started", {
    ownerId: process.env.AGEWORK_WORKER_OWNER_ID,
    runtimeChannel: process.env.AGEWORK_WORKER_CHANNEL,
  });

  let shutdownPromise: Promise<void> | undefined;

  const requestShutdown = (signal: NodeJS.Signals) => {
    shutdownPromise ??= shutdown(signal).catch((err) => {
      workerLog("persistent worker shutdown failed", {
        signal,
        ...errorDetails(err),
      }, "error");
      process.exit(1);
    });
  };
  process.once("SIGTERM", requestShutdown);
  process.once("SIGINT", requestShutdown);

  await commandLoop.run();

  async function shutdown(signal: NodeJS.Signals) {
    commandLoop.stop();

    const forceExitTimer = setTimeout(() => {
      workerLog("persistent worker shutdown grace period exceeded", {
        signal,
        activeRunCount: runManager.size(),
      }, "error");
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    forceExitTimer.unref();

    await runManager.shutdown(signal);

    clearTimeout(forceExitTimer);
    process.exit(0);
  }
}

function emitStatus(
  transport: RuntimeChannel,
  runId: string,
  payload: RunStatusPayload
) {
  return transport.emit({
    runId,
    seq: 0,
    type: "run.status",
    payload,
    ts: "",
  });
}

/** 上报命令处理 trace（received/handled/failed），与 API 侧 command.sent 通过 commandId 回连。 */
function emitCommandTrace(
  transport: RuntimeChannel,
  runId: string,
  phase: "received" | "handled" | "failed",
  command: CommandPayload,
  error?: string
) {
  transport
    .emit({
      runId,
      seq: 0,
      type: "command.trace",
      payload: {
        phase,
        commandId: command.commandId,
        commandType: command.type,
        ...(error ? { error } : {}),
      },
      ts: "",
    })
    .catch(() => {});
}

function emitCommandResult(
  transport: RuntimeChannel,
  runId: string,
  command: CommandPayload,
  status: CommandResultPayload["status"],
  error?: string
) {
  transport
    .emit({
      runId,
      seq: 0,
      type: "command.result",
      payload: {
        commandId: command.commandId,
        commandType: command.type,
        status,
        ...(error ? { error } : {}),
      },
      ts: "",
    })
    .catch(() => {});
}

main().catch((err) => {
  workerLog("worker fatal error", errorDetails(err), "error");
  process.exit(1);
});
