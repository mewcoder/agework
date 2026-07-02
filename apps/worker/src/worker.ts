import type {
  CommandPayload,
  RunChannelMessage,
  RunConfig,
  RunStatusPayload,
  AGUIEvent,
  CommandResultPayload,
  RuntimeChannel,
} from "@agework/shared/protocol";
import { WorkerCommands } from "./commands.js";
import { HttpTransport } from "./transport/http.js";
import { IpcKeepAliveTransport } from "./transport/ipc-keep-alive.js";
import { IpcTransport } from "./transport/ipc.js";
import { RunnerManager } from "./runner-manager.js";
import {
  errorDetails,
  setWorkerLogContext,
  setWorkerLogFilePath,
  workerLog,
} from "./logging/worker-log.js";
import { TraceLogWriter } from "./logging/trace.js";
import { createAgentDriver, toAgentRunInput } from "./agent/index.js";

const COMMAND_LONG_POLL_MS = 25_000;
const COMMAND_EMPTY_RETRY_DELAY_MS = 1_000;
const SHUTDOWN_GRACE_MS = 8_000;

export async function runWorker(keepAlive: boolean) {
  if (keepAlive) {
    return runKeepAliveWorker();
  }
  return runOneShotWorker();
}

async function runOneShotWorker() {
  const transport = createInitialRunChannel();
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
  workerLog("one-shot worker config loaded");
  const trace = new TraceLogWriter(config.agentEventTrace);

  const driver = createAgentDriver(
    config,
    trace.sink(),
    (_threadId, payload) => {
      void emitStatus(transport, runId, payload);
    }
  );

  await emitStatus(transport, runId, { status: "running" });

  const processedCommands = new Set<string>();
  let stopRequested = false;
  let forcedExitRequested = false;
  let finalizePromise: Promise<void> | undefined;

  transport.subscribeCommands((message: RunChannelMessage<CommandPayload>) => {
    const command = message.payload;
    if (processedCommands.has(command.commandId)) return;
    processedCommands.add(command.commandId);
    workerLog("one-shot worker received command", {
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
        void Promise.resolve(driver.resolveControl(command))
          .then((resolved) => {
            if (resolved) {
              emitCommandTrace(transport, runId, "handled", command);
              emitCommandResult(transport, runId, command, "ok");
            } else {
              const error = "no pending control matched";
              emitCommandTrace(transport, runId, "failed", command, error);
              emitCommandResult(transport, runId, command, "error", error);
            }
          })
          .catch((err) => {
            const error = String(err);
            emitCommandTrace(transport, runId, "failed", command, error);
            emitCommandResult(transport, runId, command, "error", error);
          });
        break;
      case "user_message":
        // Keep-alive workers handle reusable multi-run command routing.
        break;
    }
  });

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
      workerLog(
        "one-shot worker interrupt grace period exceeded",
        {
          runId,
          reason,
        },
        "error"
      );
      process.exit(code);
    }, SHUTDOWN_GRACE_MS);
    forceExitTimer.unref();

    try {
      await driver.interrupt();
    } catch (err) {
      workerLog(
        "one-shot worker interrupt before exit failed",
        {
          runId,
          reason,
          ...errorDetails(err),
        },
        "error"
      );
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
    // Final status must be reported; otherwise the API run can remain running
    // until timeout. Exit non-zero so LocalRuntimeProvider can mark it failed.
    let statusReported = false;
    try {
      await emitStatus(transport, runId, {
        status,
        ...(error ? { error } : {}),
      });
      statusReported = true;
    } catch (err) {
      workerLog(
        "finalize failed to report final status",
        {
          runId,
          source: "worker",
          eventType: "status.terminal_failed",
          ...errorDetails(err),
        },
        "error"
      );
    }
    await transport.close().catch((err) => {
      workerLog(
        "finalize failed to close transport",
        errorDetails(err),
        "warn"
      );
    });
    process.exit(statusReported ? 0 : 1);
  }
}

async function runKeepAliveWorker() {
  const client = resolveKeepAliveClient();
  const commands = new WorkerCommands(client, {
    waitMs: COMMAND_LONG_POLL_MS,
    emptyRetryDelayMs: COMMAND_EMPTY_RETRY_DELAY_MS,
  });
  const runnerManager = new RunnerManager(client, commands);
  workerLog("keep-alive worker started", {
    ownerId: process.env.AGEWORK_WORKER_OWNER_ID,
    runtimeChannel: process.env.AGEWORK_WORKER_CHANNEL,
  });

  let shutdownPromise: Promise<void> | undefined;

  const requestShutdown = (signal: NodeJS.Signals) => {
    shutdownPromise ??= shutdown(signal).catch((err) => {
      workerLog(
        "keep-alive worker shutdown failed",
        {
          signal,
          ...errorDetails(err),
        },
        "error"
      );
      process.exit(1);
    });
  };
  process.once("SIGTERM", requestShutdown);
  process.once("SIGINT", requestShutdown);

  await commands.run((command) => runnerManager.handle(command));

  async function shutdown(signal: NodeJS.Signals) {
    commands.stop();

    const forceExitTimer = setTimeout(() => {
      workerLog(
        "keep-alive worker shutdown grace period exceeded",
        {
          signal,
          activeRunCount: runnerManager.size(),
        },
        "error"
      );
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    forceExitTimer.unref();

    await runnerManager.shutdown(signal);

    clearTimeout(forceExitTimer);
    process.exit(0);
  }
}

function createInitialRunChannel(): RuntimeChannel {
  if (!process.send) {
    workerLog(
      "one-shot worker requires an initial run channel",
      undefined,
      "error"
    );
    process.exit(1);
  }
  return new IpcTransport();
}

function resolveKeepAliveClient(): HttpTransport | IpcKeepAliveTransport {
  const channel = process.env.AGEWORK_WORKER_CHANNEL;
  if (channel === "ipc") {
    return new IpcKeepAliveTransport();
  }
  return new HttpTransport();
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
