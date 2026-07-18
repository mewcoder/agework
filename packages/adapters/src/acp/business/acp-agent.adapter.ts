import { Observable, type Subscriber } from "rxjs";
import { AbstractAgent, EventType, type AgentConfig } from "@ag-ui/client";
import type { BaseEvent, RunAgentInput, Message } from "@ag-ui/core";
import { generateId } from "@agework/shared";
import type { AgentTraceSink, RunUsage } from "@agework/shared/protocol";
import type { ContentBlock, PromptResponse } from "@agentclientprotocol/sdk";
import { AcpProcess } from "../process/acp-process";
import { createStdioStream } from "../process/stdio-stream";
import { AcpConnection, type AcpTrace } from "../client/acp-client";
import { AcpSession } from "../client/acp-session";
import { AcpToAguiMapper } from "../agui/acp-to-agui";
import { AcpPermissionBridge } from "../control/permission-bridge";
import { AcpError } from "../protocol/types";

export type AcpPendingAction = "question" | null;

export type AcpAgentAdapterConfig = AgentConfig & {
  /** Resolved agent executable (e.g. the `opencode` binary). */
  command: string;
  /** Launch arguments (e.g. `["acp"]`). */
  args: string[];
  /** Runtime workspace path — process cwd and ACP session cwd. */
  cwd: string;
  /** Full child environment (already safe-env filtered by the profile). */
  env: Record<string, string>;
  /** Agent label for RUN_FINISHED.result (e.g. "opencode"). */
  agentType?: string;
  clientInfo?: { name: string; version: string };
  trace?: AgentTraceSink;
  pendingActionSink?: (event: {
    threadId: string;
    pendingAction: AcpPendingAction;
  }) => void;
  permissionTimeoutMs?: number;
};

type RunHandle = {
  runId: string;
  resumedRunId?: string;
  process: AcpProcess;
  connection: AcpConnection;
  session?: AcpSession;
  mapper: AcpToAguiMapper;
  bridge: AcpPermissionBridge;
  aborted: boolean;
};

const CLIENT_INFO = { name: "agework", version: "0.0.1" };

/**
 * AG-UI adapter that runs any ACP agent (first: `opencode acp`). Each platform
 * run spawns one agent subprocess (owned by the Runner), performs the ACP
 * handshake, drives one prompt turn, and translates the stream to AG-UI. Session
 * ids persist across runs for resume; `session/request_permission` maps to the
 * terminal-interrupt / resume model via {@link AcpPermissionBridge}.
 */
export class AcpAgentAdapter extends AbstractAgent {
  private config: AcpAgentAdapterConfig;
  /** AG-UI threadId → ACP session id (cross-run resume). */
  private readonly sessions = new Map<string, string>();
  /** AG-UI threadId → in-flight run handle (interrupt / resolveControl / shutdown). */
  private readonly activeRuns = new Map<string, RunHandle>();

  constructor(config: AcpAgentAdapterConfig) {
    super(config);
    this.config = config;
  }

  clearSession(threadId: string): void {
    this.sessions.delete(threadId);
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      const threadId = input.threadId ?? "default";
      const runId = input.runId ?? generateId();
      this.executeRun(input, threadId, runId, subscriber).catch((error) => {
        subscriber.error(error);
      });
    });
  }

  /** Cancel the in-flight turn(s): ACP `session/cancel` then terminate the process. */
  async interrupt(threadId?: string): Promise<void> {
    const handles = threadId
      ? [this.activeRuns.get(threadId)].filter((h): h is RunHandle => !!h)
      : [...this.activeRuns.values()];
    await Promise.all(handles.map((h) => this.cancelRunHandle(h)));
  }

  /**
   * Resolve a pending permission from an `approval_resolved` command (same
   * contract the Claude/Codex adapters expose to the worker driver). The opaque
   * `payload` carries the user's answer.
   */
  resolveApproval(
    conversationId: string,
    payload: unknown,
    resumeRunId?: string
  ): boolean {
    const handle = this.activeRuns.get(conversationId);
    if (!handle) return false;
    return handle.bridge.resolveControl({
      threadId: conversationId,
      answers: payload,
      resumeRunId,
    });
  }

  async shutdown(): Promise<void> {
    await this.interrupt();
  }

  private async executeRun(
    input: RunAgentInput,
    threadId: string,
    runId: string,
    subscriber: Subscriber<BaseEvent>
  ): Promise<void> {
    // Effective runId follows an interrupt/resume; trace/threadId close over it.
    let currentRunId = runId;
    const trace: AcpTrace = (name, payload) =>
      this.config.trace?.({ name, payload, runId: currentRunId, threadId });

    const proc = new AcpProcess({
      command: this.config.command,
      args: this.config.args,
      cwd: this.config.cwd,
      env: this.config.env,
      onStderr: (line) => trace("sdk.acp.process.stderr", line),
    });

    const emit = (event: BaseEvent) => subscriber.next(event);
    const mapper = new AcpToAguiMapper({
      threadId,
      runId,
      emit: emit as never,
      trace,
    });

    const handle: RunHandle = {
      runId,
      process: proc,
      connection: undefined as never,
      mapper,
      bridge: undefined as never,
      aborted: false,
    };

    const bridge = new AcpPermissionBridge({
      threadId,
      timeoutMs: this.config.permissionTimeoutMs,
      emitInterrupt: (interrupt) => {
        mapper.closeMessages();
        emit({
          type: EventType.RUN_FINISHED,
          threadId,
          runId: handle.resumedRunId ?? runId,
          outcome: { type: "interrupt", interrupts: [interrupt] },
        } as never);
      },
      emitResumeStart: (resumeRunId) => {
        handle.resumedRunId = resumeRunId;
        currentRunId = resumeRunId;
        mapper.setRunId(resumeRunId);
        emit({ type: EventType.RUN_STARTED, threadId, runId: resumeRunId });
      },
      emitPendingAction: (pendingAction) =>
        this.config.pendingActionSink?.({ threadId, pendingAction }),
    });
    handle.bridge = bridge;

    this.activeRuns.set(threadId, handle);

    try {
      emit({ type: EventType.RUN_STARTED, threadId, runId });

      proc.start();
      const stream = await createStdioStream(proc.stdin, proc.stdout);
      const connection = await AcpConnection.initialize({
        target: stream,
        clientInfo: this.config.clientInfo ?? CLIENT_INFO,
        trace,
      });
      handle.connection = connection;
      connection.setPermissionHandler(bridge.handle);

      const fp = (input.forwardedProps ?? {}) as Record<string, unknown>;
      const existingSessionId =
        (fp.agentSessionId as string | undefined) ??
        this.sessions.get(threadId);

      // Session modes(opencode 的 build/plan 等):随 new/load/resume 响应
      // 上报;emitModes 把最新状态经 CUSTOM 事件回流给 server 落到 conversation。
      const emitModes = () => {
        const modes = handle.session?.modes;
        if (!modes) return;
        emit({
          type: EventType.CUSTOM,
          name: "agent.modes",
          value: modes,
        } as never);
      };

      const session = await AcpSession.start({
        connection,
        cwd: this.config.cwd,
        existingSessionId,
        onUpdate: (u) => {
          // 模式变化的两种通知形态:原生 current_mode_update,或 config option
          // 全量刷新(opencode)。同步本地状态并回流,不进消息映射。
          if (u.sessionUpdate === "current_mode_update") {
            handle.session?.noteCurrentMode(u.currentModeId);
            emitModes();
            return;
          }
          if (u.sessionUpdate === "config_option_update") {
            const modeOption = u.configOptions.find(
              (option) => option.category === "mode" && option.type === "select"
            );
            if (modeOption && modeOption.type === "select") {
              handle.session?.noteCurrentMode(modeOption.currentValue);
              emitModes();
            }
            return;
          }
          mapper.handle(u);
        },
        onReplayUpdate: (u) => trace("sdk.acp.replay", u),
      });
      handle.session = session;
      this.sessions.set(threadId, session.sessionId);

      if (session.isNew) {
        emit({
          type: EventType.CUSTOM,
          name: "agent.sessionId",
          value: session.sessionId,
        } as never);
      }

      const desiredModeId =
        typeof fp.acpModeId === "string" ? fp.acpModeId : undefined;
      if (
        desiredModeId &&
        session.modes &&
        desiredModeId !== session.modes.currentModeId &&
        session.modes.availableModes.some((mode) => mode.id === desiredModeId)
      ) {
        await session.setMode(desiredModeId);
      }
      emitModes();

      const blocks = extractPromptBlocks(input);
      if (blocks.length === 0) {
        throw new AcpError("ACP_CONTENT_UNSUPPORTED", "empty prompt");
      }

      const result = await session.prompt(blocks);

      mapper.finalize();
      this.flushMessages(input, mapper.getMessages(), emit);

      emit({
        type: EventType.RUN_FINISHED,
        threadId,
        runId: handle.resumedRunId ?? runId,
        result: this.buildResult(result, mapper),
      } as never);
      subscriber.complete();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      trace("sdk.acp.error", error);
      if (!handle.aborted) {
        emit({
          type: EventType.RUN_ERROR,
          threadId,
          runId: handle.resumedRunId ?? runId,
          message,
        } as never);
      }
      subscriber.complete();
    } finally {
      bridge.cancel("run ended");
      handle.session?.dispose();
      handle.connection?.close();
      await proc.terminate();
      if (this.activeRuns.get(threadId) === handle) {
        this.activeRuns.delete(threadId);
      }
    }
  }

  private async cancelRunHandle(handle: RunHandle): Promise<void> {
    handle.aborted = true;
    handle.bridge.cancel("interrupted");
    try {
      await handle.session?.cancel();
    } catch {
      // best-effort; we terminate the process next
    }
    await handle.process.terminate();
  }

  private flushMessages(
    input: RunAgentInput,
    runMessages: Message[],
    emit: (event: BaseEvent) => void
  ): void {
    if (runMessages.length === 0) return;
    emit({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [...(input.messages ?? []), ...runMessages],
    } as never);
  }

  private buildResult(
    result: PromptResponse,
    mapper: AcpToAguiMapper
  ): Record<string, unknown> {
    const usage = mapUsage(result.usage);
    const contextUsage = mapper.getContextUsage();
    return {
      stopReason: result.stopReason,
      agent: this.config.agentType ?? "acp",
      protocol: "acp",
      ...(usage ? { usage } : {}),
      ...(contextUsage ? { contextWindow: contextUsage } : {}),
    };
  }
}

function extractPromptBlocks(input: RunAgentInput): ContentBlock[] {
  const messages = input.messages ?? [];
  const last = messages[messages.length - 1];
  if (!last) return [];
  const content = last.content;
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (Array.isArray(content)) {
    const blocks: ContentBlock[] = [];
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        "text" in block &&
        typeof (block as { text: unknown }).text === "string"
      ) {
        blocks.push({ type: "text", text: (block as { text: string }).text });
      }
    }
    return blocks;
  }
  return [];
}

function mapUsage(usage: PromptResponse["usage"]): RunUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedInputTokens: usage.cachedReadTokens ?? 0,
    reasoningOutputTokens: usage.thoughtTokens ?? 0,
    cacheCreationInputTokens: usage.cachedWriteTokens ?? 0,
    totalCostUsd: null,
    numTurns: 1,
    durationApiMs: null,
  };
}
