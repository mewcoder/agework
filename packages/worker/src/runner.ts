import type {
  CommandPayload,
  RunChannelMessage,
  RunConfig,
  RunStatusPayload,
  AGUIEvent,
  CommandResultPayload,
  RunChannel,
} from "@agework/shared/protocol";
import type { TerminalRunStatus } from "@agework/shared";
import { RunnerIpcTransport } from "./transport/runner-ipc.js";
import {
  errorDetails,
  setWorkerLogContext,
  setWorkerLogFilePath,
  workerLog,
} from "./logging/worker-log.js";
import { TraceLogWriter } from "./logging/trace.js";
import { createAgentDriver, toAgentRunInput } from "./agent/index.js";

const SHUTDOWN_GRACE_MS = 8_000;

export async function runRunner() {
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
  workerLog("runner config loaded");
  const trace = new TraceLogWriter(config.agentEventTrace);

  const driver = createAgentDriver(
    config,
    trace.sink(),
    (_threadId, payload) => {
      void emitStatus(transport, payload);
    }
  );

  await emitStatus(transport, { status: "running" });

  const processedCommands = new Set<string>();
  let stopRequested = false;
  let forcedExitRequested = false;
  let finalizePromise: Promise<void> | undefined;

  transport.subscribeCommands((message: RunChannelMessage<CommandPayload>) => {
    const command = message.payload;
    if (processedCommands.has(command.commandId)) return;
    processedCommands.add(command.commandId);
    workerLog("runner received command", {
      runId,
      commandId: command.commandId,
      source: "command",
      eventType: command.type,
    });
    emitCommandTrace(transport, "received", command);

    switch (command.type) {
      case "cancel":
        stopRequested = true;
        void driver.cancel(conversationId).catch((err) => {
          const error = String(err);
          emitCommandTrace(transport, "failed", command, error);
        });
        emitCommandTrace(transport, "handled", command);
        emitCommandResult(transport, command, "ok");
        break;
      case "interrupt":
        void driver.interrupt().catch((err) => {
          const error = String(err);
          emitCommandTrace(transport, "failed", command, error);
        });
        emitCommandTrace(transport, "handled", command);
        emitCommandResult(transport, command, "ok");
        break;
      case "approval_resolved":
        void Promise.resolve(driver.resolveControl(command))
          .then((resolved) => {
            if (resolved) {
              emitCommandTrace(transport, "handled", command);
              emitCommandResult(transport, command, "ok");
            } else {
              const error = "no pending control matched";
              emitCommandTrace(transport, "failed", command, error);
              emitCommandResult(transport, command, "error", error);
            }
          })
          .catch((err) => {
            const error = String(err);
            emitCommandTrace(transport, "failed", command, error);
            emitCommandResult(transport, command, "error", error);
          });
        break;
      case "user_message":
        // Multi-run command routing is the resident worker's job, not the runner's.
        break;
    }
  });

  driver.run(toAgentRunInput(config.input, conversationId)).subscribe({
    next: (event: unknown) => {
      trace.writeAgui(event);
      transport
        .emit({ type: "agui.event", payload: event as AGUIEvent })
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
        "runner interrupt grace period exceeded",
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
        "runner interrupt before exit failed",
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

  async function finalize(status: TerminalRunStatus, error?: string) {
    if (forcedExitRequested) return;
    finalizePromise ??= doFinalize(status, error);
    return finalizePromise;
  }

  async function doFinalize(status: TerminalRunStatus, error?: string) {
    // Final status must be reported; otherwise the API run can remain running
    // until timeout. Exit non-zero so NativeRuntimeProvider can mark it failed.
    let statusReported = false;
    try {
      await emitStatus(transport, {
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

function createInitialRunChannel(): RunChannel {
  if (!process.send) {
    workerLog(
      "runner requires an initial run channel",
      undefined,
      "error"
    );
    process.exit(1);
  }
  return new RunnerIpcTransport();
}

function emitStatus(transport: RunChannel, payload: RunStatusPayload) {
  return transport.emit({ type: "run.status", payload });
}

function emitCommandTrace(
  transport: RunChannel,
  phase: "received" | "handled" | "failed",
  command: CommandPayload,
  error?: string
) {
  transport
    .emit({
      type: "command.trace",
      payload: {
        phase,
        commandId: command.commandId,
        commandType: command.type,
        ...(error ? { error } : {}),
      },
    })
    .catch(() => {});
}

function emitCommandResult(
  transport: RunChannel,
  command: CommandPayload,
  status: CommandResultPayload["status"],
  error?: string
) {
  transport
    .emit({
      type: "command.result",
      payload: {
        commandId: command.commandId,
        commandType: command.type,
        status,
        ...(error ? { error } : {}),
      },
    })
    .catch(() => {});
}
