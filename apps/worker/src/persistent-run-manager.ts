import type {
  AgentTraceEvent,
  AgentTraceSink,
  AgentType,
  AGUIEvent,
  CommandPayload,
  RunConfig,
  RunStatusPayload,
  UpstreamMessage,
} from "@agework/shared/protocol";
import { AgentEventTraceRegistry } from "./agent-event-trace.js";
import { createAdapterAgentDriver } from "./adapter-agent-driver.js";
import { toAgentRunInput, type AgentDriver } from "./agent-driver.js";
import { PersistentCommandReporter } from "./persistent-command-reporter.js";
import { RunRouter } from "./run-router.js";
import {
  errorDetails,
  registerWorkerRunLog,
  unregisterWorkerRunLog,
  workerLog,
} from "./worker-log.js";

type UserMessageCommand = Extract<CommandPayload, { type: "user_message" }>;
type CancelCommand = Extract<CommandPayload, { type: "cancel" }>;
type InterruptCommand = Extract<CommandPayload, { type: "interrupt" }>;
type ApprovalResolvedCommand = Extract<
  CommandPayload,
  { type: "approval_resolved" }
>;

export type RunManagerClient = {
  fetchRunConfig(runId: string): Promise<RunConfig>;
  emit(runId: string, msg: UpstreamMessage): Promise<void>;
  cleanup(runId: string): void;
};

export class PersistentRunManager {
  private readonly commandReporter: PersistentCommandReporter;
  private readonly drivers = new Map<AgentType, AgentDriver>();
  private readonly conversationIdToRun = new Map<string, string>();
  private readonly runToConversationId = new Map<string, string>();
  private readonly traces = new AgentEventTraceRegistry();
  private readonly mux: RunRouter;

  constructor(private readonly client: RunManagerClient) {
    this.commandReporter = new PersistentCommandReporter(client);
    this.traces.setEmitter((runId, msg) => {
      this.client.emit(runId, msg).catch((err) => {
        workerLog("emit trace failed", { runId, ...errorDetails(err) }, "error");
      });
    });
    this.mux = new RunRouter(
      (runId, event) => this.emitAguiEvent(runId, event),
      (runId, payload) => this.reportTerminalStatus(runId, payload)
    );
  }

  async handle(command: CommandPayload): Promise<void> {
    switch (command.type) {
      case "user_message":
        await this.handleUserMessage(command);
        break;
      case "cancel":
        this.handleCancel(command);
        break;
      case "interrupt":
        this.handleInterrupt(command);
        break;
      case "approval_resolved":
        this.handleApprovalResolved(command);
        break;
    }
  }

  activeRuns(): Array<{
    runId: string;
    agentType: AgentType;
    aguiThreadId: string;
  }> {
    return this.mux.activeRuns();
  }

  size(): number {
    return this.mux.size();
  }

  async shutdown(signal: NodeJS.Signals): Promise<void> {
    const activeRuns = this.activeRuns();
    workerLog("persistent worker received shutdown signal", {
      signal,
      activeRuns: activeRuns.map((run) => ({
        runId: run.runId,
        agentType: run.agentType,
        aguiThreadId: run.aguiThreadId,
      })),
    }, activeRuns.length > 0 ? "warn" : "info");

    await this.mux.shutdownAll({
      status: "error",
      error: `worker received ${signal}`,
    });
  }

  private async handleUserMessage(command: UserMessageCommand): Promise<void> {
    workerLog("processing user_message command", {
      runId: command.runId,
      commandId: command.commandId,
    });
    this.commandReporter.received(command.runId, command);

    let config: RunConfig;
    try {
      config = await this.client.fetchRunConfig(command.runId);
    } catch (err) {
      workerLog("failed to fetch run config", {
        runId: command.runId,
        ...errorDetails(err),
      }, "error");
      this.commandReporter.failed(command.runId, command, String(err));
      this.client
        .emit(command.runId, {
          runId: command.runId,
          seq: 0,
          type: "run.status",
          payload: {
            status: "error",
            error: `Failed to fetch run config: ${String(err)}`,
          },
          ts: new Date().toISOString(),
        })
        .catch((emitErr) => {
          workerLog(
            "emit run config failure status failed",
            { runId: command.runId, ...errorDetails(emitErr) },
            "error"
          );
        });
      return;
    }

    registerWorkerRunLog({
      runId: config.runId,
      conversationId: config.conversationId,
      filePath: config.workerLogFilePath,
    });
    workerLog("persistent run config loaded", {
      runId: config.runId,
      conversationId: config.conversationId,
      workspaceId: config.workspaceId,
      agentType: config.agentProviderConfig.agentType,
      runtimePath: config.runtimePath,
      agentProviderSource: config.agentProviderConfig.source,
    });
    this.traces.create(config.agentEventTrace);

    const agentType = config.agentProviderConfig.agentType as AgentType;
    this.ensureDriver(agentType, config, command.runId);
    this.conversationIdToRun.set(config.conversationId, command.runId);
    this.runToConversationId.set(command.runId, config.conversationId);

    workerLog("starting multiplexed run", {
      runId: command.runId,
      conversationId: config.conversationId,
    });
    this.mux.startRun(
      command.runId,
      agentType,
      toAgentRunInput(config.input, config.conversationId)
    );
    this.commandReporter.handled(command.runId, command);
  }

  private ensureDriver(
    agentType: AgentType,
    config: RunConfig,
    commandRunId: string
  ): void {
    if (this.drivers.has(agentType)) return;

    workerLog("creating agent driver", {
      runId: commandRunId,
      agentType: config.agentProviderConfig.agentType,
      agentProviderSource: config.agentProviderConfig.source,
      runtimePath: config.runtimePath,
    });
    const driver = createAdapterAgentDriver(
      config,
      createRegistryTraceSink(this.traces),
      (aguiThreadId, payload) => {
        this.emitDriverStatus(aguiThreadId, payload);
      }
    );
    this.drivers.set(agentType, driver);
    this.mux.setDriver(agentType, driver);
  }

  private handleCancel(command: CancelCommand): void {
    workerLog("processing cancel command", {
      runId: command.runId,
      conversationId: command.conversationId,
    });
    this.commandReporter.received(command.runId, command);

    const hasActiveRun = this.mux.has(command.runId);
    if (hasActiveRun) {
      this.commandReporter.handled(command.runId, command);
    } else {
      this.commandReporter.failed(
        command.runId,
        command,
        "no active run matched"
      );
      workerLog("cancel command did not match an active run", {
        runId: command.runId,
        conversationId: command.conversationId,
      }, "warn");
      return;
    }

    void this.mux
      .cancelRun(command.runId, command.conversationId)
      .then((cancelled) => {
        if (!cancelled) {
          workerLog("cancel command did not match an active run", {
            runId: command.runId,
            conversationId: command.conversationId,
          }, "warn");
        }
      })
      .catch((err) => {
        this.commandReporter.trace(command.runId, "failed", command, String(err));
        workerLog("cancel command failed", {
          runId: command.runId,
          conversationId: command.conversationId,
          ...errorDetails(err),
        }, "error");
      });
  }

  private handleInterrupt(command: InterruptCommand): void {
    const runId = command.runId;
    workerLog("processing interrupt command", {
      runId,
      commandId: command.commandId,
    });

    if (!runId) {
      workerLog("interrupt command missing runId", {
        commandId: command.commandId,
      }, "warn");
      return;
    }

    this.commandReporter.received(runId, command);
    const hasActiveRun = this.mux.has(runId);
    if (hasActiveRun) {
      this.commandReporter.handled(runId, command);
    } else {
      this.commandReporter.failed(runId, command, "no active run matched");
      workerLog("interrupt command did not match an active run", {
        runId,
        commandId: command.commandId,
      }, "warn");
      return;
    }

    void this.mux
      .interruptRun(runId)
      .then((interrupted) => {
        if (!interrupted) {
          workerLog("interrupt command did not match an active run", {
            runId,
            commandId: command.commandId,
          }, "warn");
        }
      })
      .catch((err) => {
        this.commandReporter.trace(runId, "failed", command, String(err));
        workerLog("interrupt command failed", {
          runId,
          commandId: command.commandId,
          ...errorDetails(err),
        }, "error");
      });
  }

  private handleApprovalResolved(command: ApprovalResolvedCommand): void {
    workerLog("processing approval_resolved command", {
      conversationId: command.conversationId,
      answerKeys: Object.keys(command.answers ?? {}),
    });

    const resolvedRunId = this.conversationIdToRun.get(command.conversationId);
    if (resolvedRunId) {
      this.commandReporter.received(resolvedRunId, command);
      void this.mux
        .resolveControl(resolvedRunId, command)
        .then((resolved) => {
          if (resolved) {
            this.commandReporter.handled(resolvedRunId, command);
          } else {
            this.commandReporter.failed(
              resolvedRunId,
              command,
              "no pending control matched"
            );
          }
        })
        .catch((err) => {
          this.commandReporter.failed(resolvedRunId, command, String(err));
          workerLog("approval_resolved command failed", {
            conversationId: command.conversationId,
            ...errorDetails(err),
          }, "error");
        });
      return;
    }

    void this.resolveControlAcrossDrivers(command)
      .then((resolved) => {
        if (!resolved) {
          workerLog("approval_resolved command had no run mapping", {
            conversationId: command.conversationId,
          }, "warn");
        }
      })
      .catch((err) => {
        workerLog("approval_resolved fallback failed", {
          conversationId: command.conversationId,
          ...errorDetails(err),
        }, "error");
      });
  }

  private emitAguiEvent(runId: string, event: unknown): void {
    this.traces.get(runId)?.writeAgui(event);
    this.client
      .emit(runId, {
        runId,
        seq: 0,
        type: "agui.event",
        payload: event as AGUIEvent,
        ts: "",
      })
      .catch((err) => {
        workerLog("emit agui event failed", {
          runId,
          ...errorDetails(err),
        }, "error");
      });
  }

  private emitDriverStatus(
    aguiThreadId: string,
    payload: RunStatusPayload
  ): void {
    // AG-UI 边界：driver 回调的 threadId 值即 AgeWork conversationId
    const runId = this.conversationIdToRun.get(aguiThreadId);
    if (runId) {
      this.client
        .emit(runId, {
          runId,
          seq: 0,
          type: "run.status",
          payload,
          ts: "",
        })
        .catch((err) => {
          workerLog(
            "emit driver status failed",
            { runId, ...errorDetails(err) },
            "error"
          );
        });
    } else {
      workerLog(
        "driver status callback had no run mapping",
        {
          aguiThreadId,
          status: payload.status,
        },
        "warn"
      );
    }
  }

  private reportTerminalStatus(
    runId: string,
    payload: RunStatusPayload
  ): Promise<void> {
    workerLog("multiplexed run completed", {
      runId,
      status: payload.status,
      ...("error" in payload ? { error: payload.error } : {}),
    }, payload.status === "error" ? "error" : "info");

    return this.client
      .emit(runId, {
        runId,
        seq: 0,
        type: "run.status",
        payload,
        ts: "",
      })
      .catch((err) => {
        workerLog("failed to emit terminal run status", {
          runId,
          status: payload.status,
          source: "worker",
          eventType: "status.terminal_failed",
          ...errorDetails(err),
        }, "error");
      })
      .finally(() => {
        const conversationId = this.runToConversationId.get(runId);
        if (conversationId) {
          this.runToConversationId.delete(runId);
          this.conversationIdToRun.delete(conversationId);
        }
        this.traces.delete(runId);
        unregisterWorkerRunLog(runId);
        this.client.cleanup(runId);
      });
  }

  private async resolveControlAcrossDrivers(
    command: CommandPayload
  ): Promise<boolean> {
    for (const driver of this.drivers.values()) {
      if (await driver.resolveControl(command)) return true;
    }
    return false;
  }
}

function createRegistryTraceSink(
  traces: AgentEventTraceRegistry
): AgentTraceSink {
  return (event: AgentTraceEvent) => {
    const runId = traceEventRunId(event);
    if (!runId) return;
    traces.get(runId)?.writeSdkRaw(event);
  };
}

function traceEventRunId(event: AgentTraceEvent): string | undefined {
  if (event.runId) return event.runId;
  const payload = event.payload;
  if (payload && typeof payload === "object" && "runId" in payload) {
    const runId = (payload as { runId?: unknown }).runId;
    if (typeof runId === "string") return runId;
  }
  return undefined;
}
