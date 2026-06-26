import {
  ClaudeAgentAdapter,
  CodexAgentAdapter,
  resolveQuestion,
  cancelQuestion,
} from "@agework/adapters";
import type {
  AgentType,
  AgentTraceEvent,
  AgentTraceSink,
  CommandPayload,
  Envelope,
  RunConfig,
  RunStatusPayload,
  AGUIEvent,
  RuntimeChannel,
} from "@agework/shared/protocol";
import { IpcChannel } from "./ipc-channel.js";
import { PersistentHttpClient } from "./persistent-http-client.js";
import { RunRouter } from "./run-router.js";
import {
  errorDetails,
  registerWorkerRunLog,
  setWorkerLogContext,
  setWorkerLogFilePath,
  unregisterWorkerRunLog,
  workerLog,
} from "./worker-log.js";
import {
  AgentEventTraceRegistry,
  AgentEventTraceWriter,
} from "./agent-event-trace.js";
import { resolveAgentCliPaths } from "./agent-cli-paths.js";

const HEARTBEAT_INTERVAL_MS = 5_000;
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

  // Construct adapter based on config.agentProviderConfig.agentType
  const adapter = createAdapter(config, trace.sink(), (_threadId, payload) => {
    void emitStatus(transport, runId, payload);
  });

  // Emit "running" status
  await emitStatus(transport, runId, { status: "running" });

  // Heartbeat timer
  const heartbeatTimer = setInterval(() => {
    transport
      .emit({
        runId,
        seq: 0,
        type: "heartbeat",
        payload: { at: new Date().toISOString() },
        ts: "",
      })
      .catch(() => {});
  }, HEARTBEAT_INTERVAL_MS);

  // Command dedup
  const processedCommands = new Set<string>();
  let stopRequested = false;
  let forcedExitRequested = false;
  let finalizePromise: Promise<void> | undefined;

  // Subscribe to command messages
  transport.subscribeCommands((envelope: Envelope<CommandPayload>) => {
    const command = envelope.payload;
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
        adapter.interrupt();
        cancelQuestion(conversationId);
        emitCommandTrace(transport, runId, "handled", command);
        break;
      case "interrupt":
        adapter.interrupt();
        emitCommandTrace(transport, runId, "handled", command);
        break;
      case "approval_resolved":
        resolveQuestion(command.conversationId, command.answers);
        emitCommandTrace(transport, runId, "handled", command);
        break;
      case "user_message":
        // 仅 persistent 模式处理；single 模式每个 run 独立 worker，无复用
        break;
    }
  });

  // Run the adapter
  adapter.run(config.input as Parameters<typeof adapter.run>[0]).subscribe({
    next: (event: unknown) => {
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
    clearInterval(heartbeatTimer);

    const forceExitTimer = setTimeout(() => {
      workerLog("single worker interrupt grace period exceeded", {
        runId,
        reason,
      }, "error");
      process.exit(code);
    }, SHUTDOWN_GRACE_MS);
    forceExitTimer.unref();

    try {
      await adapter.interrupt();
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
    clearInterval(heartbeatTimer);
    // 终态上报必须成功：失败时 API 侧 Run 会卡在 running 直到心跳超时。
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

type Adapter = ClaudeAgentAdapter | CodexAgentAdapter;

async function runPersistent() {
  const client = new PersistentHttpClient();
  // 按 agentType 缓存 adapter：同一持久容器可能承接分属 claude / codex 的多个会话，
  // 各自注入不同的 apiKey/model/baseUrl，必须独立实例，不可跨 agentType 复用。
  const adapters = new Map<AgentType, Adapter>();
  const conversationIdToRun = new Map<string, string>();
  // 反向索引，run 完成时 O(1) 定位要删除的 conversationId，避免线性扫描
  const runToConversationId = new Map<string, string>();
  const traces = new AgentEventTraceRegistry();
  traces.setEmitter((runId, msg) => {
    client.emit(runId, msg).catch((err) => {
      workerLog("emit trace failed", { runId, ...errorDetails(err) }, "error");
    });
  });
  workerLog("persistent worker started", {
    ownerId: process.env.AGEWORK_WORKER_OWNER_ID,
    runtimeChannel: process.env.AGEWORK_WORKER_CHANNEL,
  });

  const mux = new RunRouter(
    (runId, event) => {
      client.emit(runId, { runId, seq: 0, type: "agui.event", payload: event as AGUIEvent, ts: "" }).catch((err) => {
        workerLog("emit agui event failed", { runId, ...errorDetails(err) }, "error");
      });
    },
    (runId, payload) => {
      workerLog("multiplexed run completed", {
        runId,
        status: payload.status,
        ...("error" in payload ? { error: payload.error } : {}),
      }, payload.status === "error" ? "error" : "info");
      return client
        .emit(runId, { runId, seq: 0, type: "run.status", payload: payload as RunStatusPayload, ts: "" })
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
          const conversationId = runToConversationId.get(runId);
          if (conversationId) {
            runToConversationId.delete(runId);
            conversationIdToRun.delete(conversationId);
          }
          traces.delete(runId);
          unregisterWorkerRunLog(runId);
          client.cleanup(runId);
        });
    }
  );

  const heartbeatTimer = setInterval(() => {
    void client.emitOwnerHeartbeat();
  }, HEARTBEAT_INTERVAL_MS);

  const processedCommands = new Set<string>();
  let pollIterations = 0;
  let shuttingDown = false;
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

  for (;;) {
    if (shuttingDown) break;
    const commands = await client.pollCommands(COMMAND_LONG_POLL_MS);
    if (shuttingDown) break;
    // 每 100 轮清理一次已处理命令集合，防止长期运行时内存泄漏
    // （pollCommands 基于 afterSeq 去重，processedCommands 仅作防御性检查）
    if (++pollIterations >= 100) {
      processedCommands.clear();
      pollIterations = 0;
    }
    for (const envelope of commands) {
      if (shuttingDown) break;
      const command = envelope.payload;
      if (processedCommands.has(command.commandId)) continue;
      processedCommands.add(command.commandId);

      if (command.type === "user_message") {
        workerLog("processing user_message command", {
          runId: command.runId,
          commandId: command.commandId,
        });
        emitPersistentCommandTrace(client, command.runId, "received", command);
        let config: RunConfig;
        try {
          config = await client.fetchRunConfig(command.runId);
        } catch (err) {
          workerLog("failed to fetch run config", {
            runId: command.runId,
            ...errorDetails(err),
          }, "error");
          emitPersistentCommandTrace(client, command.runId, "failed", command, String(err));
          client.emit(command.runId, {
            runId: command.runId, seq: 0, type: "run.status",
            payload: { status: "error", error: `Failed to fetch run config: ${String(err)}` },
            ts: new Date().toISOString(),
          }).catch((emitErr) => {
            workerLog("emit run config failure status failed", { runId: command.runId, ...errorDetails(emitErr) }, "error");
          });
          continue;
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
        traces.create(config.agentEventTrace);
        const agentType = config.agentProviderConfig.agentType as AgentType;
        if (!adapters.has(agentType)) {
          workerLog("creating adapter", {
            runId: command.runId,
            agentType: config.agentProviderConfig.agentType,
            agentProviderSource: config.agentProviderConfig.source,
            runtimePath: config.runtimePath,
          });
          const adapter = createAdapter(config, createRegistryTraceSink(traces), (aguiThreadId, payload) => {
            // AG-UI 边界：adapter 回调的 threadId 值即 AgeWork conversationId
            const runId = conversationIdToRun.get(aguiThreadId);
            if (runId) {
              client.emit(runId, { runId, seq: 0, type: "run.status", payload, ts: "" }).catch((err) => {
                workerLog("emit adapter status failed", { runId, ...errorDetails(err) }, "error");
              });
            }
            else workerLog("adapter status callback had no run mapping", {
              aguiThreadId,
              status: payload.status,
            }, "warn");
          });
          adapters.set(agentType, adapter);
          mux.setAdapter(agentType, adapter);
        }
        conversationIdToRun.set(config.conversationId, command.runId);
        runToConversationId.set(command.runId, config.conversationId);
        workerLog("starting multiplexed run", {
          runId: command.runId,
          conversationId: config.conversationId,
        });
        mux.startRun(command.runId, agentType, config.input as { threadId: string } & Record<string, unknown>);
        emitPersistentCommandTrace(client, command.runId, "handled", command);
      } else if (command.type === "cancel") {
        workerLog("processing cancel command", {
          runId: command.runId,
          conversationId: command.conversationId,
        });
        emitPersistentCommandTrace(client, command.runId, "received", command);
        if (command.runId && command.conversationId) {
          const hasActiveRun = mux.has(command.runId);
          if (hasActiveRun) {
            cancelQuestion(command.conversationId);
          }
          void mux.cancelRun(command.runId, command.conversationId).then((cancelled) => {
            emitPersistentCommandTrace(
              client,
              command.runId,
              cancelled ? "handled" : "failed",
              command,
              cancelled ? undefined : "no active run matched"
            );
            if (!cancelled) {
              workerLog("cancel command did not match an active run", {
                runId: command.runId,
                conversationId: command.conversationId,
              }, "warn");
            }
          }).catch((err) => {
            emitPersistentCommandTrace(client, command.runId, "failed", command, String(err));
            workerLog("cancel command failed", {
              runId: command.runId,
              conversationId: command.conversationId,
              ...errorDetails(err),
            }, "error");
          });
        } else {
          emitPersistentCommandTrace(client, command.runId, "failed", command, "missing runId or conversationId");
          workerLog("cancel command missing runId or conversationId", {
            runId: command.runId,
            conversationId: command.conversationId,
          }, "warn");
        }
      } else if (command.type === "approval_resolved") {
        workerLog("processing approval_resolved command", {
          conversationId: command.conversationId,
          answerKeys: Object.keys(command.answers ?? {}),
        });
        const resolvedRunId = conversationIdToRun.get(command.conversationId);
        if (resolvedRunId) {
          emitPersistentCommandTrace(client, resolvedRunId, "received", command);
        }
        resolveQuestion(command.conversationId, command.answers);
        if (resolvedRunId) {
          emitPersistentCommandTrace(client, resolvedRunId, "handled", command);
        }
      }
    }
    if (commands.length === 0) {
      await sleep(COMMAND_EMPTY_RETRY_DELAY_MS);
    }
  }

  async function shutdown(signal: NodeJS.Signals) {
    shuttingDown = true;
    clearInterval(heartbeatTimer);

    const activeRuns = mux.activeRuns();
    workerLog("persistent worker received shutdown signal", {
      signal,
      activeRuns: activeRuns.map((run) => ({
        runId: run.runId,
        agentType: run.agentType,
        aguiThreadId: run.aguiThreadId,
      })),
    }, activeRuns.length > 0 ? "warn" : "info");

    for (const run of activeRuns) {
      cancelQuestion(run.aguiThreadId);
    }

    const forceExitTimer = setTimeout(() => {
      workerLog("persistent worker shutdown grace period exceeded", {
        signal,
        activeRunCount: mux.size(),
      }, "error");
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    forceExitTimer.unref();

    await mux.shutdownAll({
      status: "error",
      error: `worker received ${signal}`,
    });

    clearTimeout(forceExitTimer);
    process.exit(0);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createAdapter(
  config: RunConfig,
  trace: AgentTraceSink | undefined,
  emitRunStatusForAguiThread: (aguiThreadId: string, payload: RunStatusPayload) => void
) {
  const { agentProviderConfig, runtimePath } = config;
  const { claudeExecutablePath, codexExecutablePath } = resolveAgentCliPaths(process.env);

  const pendingActionSink = (event: {
    threadId: string;
    pendingAction: "question" | null;
  }) => {
    const payload: RunStatusPayload = event.pendingAction
      ? { status: "requires_action", pendingAction: event.pendingAction }
      : { status: "running", pendingAction: null };
    // AG-UI 边界：event.threadId 值即 AgeWork conversationId。
    emitRunStatusForAguiThread(event.threadId, payload);
  };

  // 系统配置不带任何配置字段；自定义配置透传 baseUrl/apiKey/model/extraConfig 给两个 adapter。
  const credentials = agentProviderConfig.source === "system"
    ? {}
    : {
        apiKey: agentProviderConfig.apiKey,
        model: agentProviderConfig.model,
        baseUrl: agentProviderConfig.baseUrl,
        extraConfig: agentProviderConfig.extraConfig,
      };

  if (agentProviderConfig.agentType === "claude") {
    return new ClaudeAgentAdapter({
      ...credentials,
      cwd: runtimePath,
      isEnvironmentConfig: agentProviderConfig.source === "system",
      pendingActionSink,
      trace,
      ...(claudeExecutablePath ? { pathToClaudeCodeExecutable: claudeExecutablePath } : {}),
    });
  }

  return new CodexAgentAdapter({
    ...credentials,
    cwd: runtimePath,
    trace,
    ...(codexExecutablePath ? { codexPathOverride: codexExecutablePath } : {}),
  });
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

/** persistent worker 版：用 client.emit(runId, msg) 上报命令 trace。 */
function emitPersistentCommandTrace(
  client: PersistentHttpClient,
  runId: string,
  phase: "received" | "handled" | "failed",
  command: CommandPayload,
  error?: string
) {
  void client
    .emit(runId, {
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

main().catch((err) => {
  workerLog("worker fatal error", errorDetails(err), "error");
  process.exit(1);
});
