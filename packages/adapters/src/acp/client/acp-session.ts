import type {
  ContentBlock,
  McpServer,
  PromptResponse,
  SessionConfigOption,
  SessionModeState,
} from "@agentclientprotocol/sdk";
import type { AgentModeState } from "@agework/shared";
import { AcpConnection, type AcpSessionUpdate } from "./acp-client";
import { AcpError } from "../protocol/types";

export type AcpSessionStartOptions = {
  connection: AcpConnection;
  /** Runtime workspace path — becomes the ACP session `cwd`. */
  cwd: string;
  mcpServers?: McpServer[];
  /** Existing ACP session id to resume/load; absent means create a fresh one. */
  existingSessionId?: string;
  /** Live (non-replay) session updates. */
  onUpdate: (update: AcpSessionUpdate) => void;
  /** Updates streamed while replaying history during `session/load` (suppressed from business output). */
  onReplayUpdate?: (update: AcpSessionUpdate) => void;
};

/** Fields shared by new/load/resume responses that can carry mode state. */
type SessionOpenResponse = {
  modes?: SessionModeState | null;
  configOptions?: SessionConfigOption[] | null;
};

/** 模式的暴露机制:ACP 原生 modes 字段,或 config option(如 opencode 的 "mode")。 */
type ModeMechanism = { kind: "modes" } | { kind: "configOption"; configId: string };

/**
 * Owns the lifecycle of a single ACP session. Chooses create vs resume vs load
 * from advertised capabilities, suppresses replayed history during `session/load`
 * (the frontend already has it), and exposes prompt/cancel for the turn.
 */
export class AcpSession {
  private sessionIdValue = "";
  private replayPhase = false;
  private unregister?: () => void;
  private createdFresh = false;
  private modesValue: AgentModeState | null = null;
  private modeMechanism: ModeMechanism | null = null;

  private constructor(private readonly opts: AcpSessionStartOptions) {}

  /** ACP session id (empty until {@link start} resolves). */
  get sessionId(): string {
    return this.sessionIdValue;
  }

  /** Whether this run created a brand-new session (vs resumed/loaded an existing one). */
  get isNew(): boolean {
    return this.createdFresh;
  }

  /**
   * Session modes reported in the new/load/resume response — either the native
   * ACP `modes` field or a `category: "mode"` config option (opencode). Null =
   * the agent exposes no modes.
   */
  get modes(): AgentModeState | null {
    return this.modesValue;
  }

  static async start(opts: AcpSessionStartOptions): Promise<AcpSession> {
    const session = new AcpSession(opts);
    const mcpServers = opts.mcpServers ?? [];

    if (!opts.existingSessionId) {
      const res = await opts.connection.newSession({ cwd: opts.cwd, mcpServers });
      session.bind(res.sessionId, false);
      session.createdFresh = true;
      session.captureModes(res);
      return session;
    }

    const caps = opts.connection.capabilities;
    // Resuming an existing session may stream prior history back as
    // `session/update` (some agents replay after the load/resume RPC resolves,
    // not just during it). Suppress everything until our own prompt is sent —
    // any update before that is history, not this turn's output. The window
    // closes in prompt().
    if (caps.resumeSession) {
      session.bind(opts.existingSessionId, true);
      const res = await opts.connection.resumeSession({
        sessionId: opts.existingSessionId,
        cwd: opts.cwd,
        mcpServers,
      });
      session.captureModes(res);
    } else if (caps.loadSession) {
      session.bind(opts.existingSessionId, true);
      const res = await opts.connection.loadSession({
        sessionId: opts.existingSessionId,
        cwd: opts.cwd,
        mcpServers,
      });
      session.captureModes(res);
    } else {
      throw new AcpError(
        "ACP_SESSION_RESUME_UNSUPPORTED",
        "Agent supports neither session/resume nor session/load; cannot restore an existing session without losing context"
      );
    }
    return session;
  }

  /** Switch mode via whichever mechanism the agent advertised. */
  async setMode(modeId: string): Promise<void> {
    if (!this.modeMechanism || !this.modesValue) {
      throw new AcpError("ACP_SET_MODE_FAILED", "agent reported no modes");
    }
    if (this.modeMechanism.kind === "modes") {
      await this.opts.connection.setMode(this.sessionIdValue, modeId);
    } else {
      await this.opts.connection.setConfigOption(
        this.sessionIdValue,
        this.modeMechanism.configId,
        modeId
      );
    }
    this.modesValue = { ...this.modesValue, currentModeId: modeId };
  }

  /** 外部观察到模式变化(current_mode_update / config_option_update)时同步本地状态。 */
  noteCurrentMode(modeId: string): void {
    if (!this.modesValue) return;
    this.modesValue = { ...this.modesValue, currentModeId: modeId };
  }

  prompt(prompt: ContentBlock[]): Promise<PromptResponse> {
    // Our prompt begins the live turn: updates from here on are real output,
    // not replayed history.
    this.replayPhase = false;
    return this.opts.connection.prompt({
      sessionId: this.sessionIdValue,
      prompt,
    });
  }

  cancel(): Promise<void> {
    return this.opts.connection.cancel(this.sessionIdValue);
  }

  /** Stop receiving updates for this session. */
  dispose(): void {
    this.unregister?.();
    this.unregister = undefined;
  }

  private bind(sessionId: string, replay: boolean): void {
    this.sessionIdValue = sessionId;
    this.replayPhase = replay;
    this.unregister = this.opts.connection.registerSession(
      sessionId,
      (update) => {
        if (this.replayPhase) this.opts.onReplayUpdate?.(update);
        else this.opts.onUpdate(update);
      }
    );
  }

  private captureModes(res: SessionOpenResponse): void {
    if (res.modes && res.modes.availableModes.length > 0) {
      this.modeMechanism = { kind: "modes" };
      this.modesValue = {
        currentModeId: res.modes.currentModeId,
        availableModes: res.modes.availableModes.map((mode) => ({
          id: mode.id,
          name: mode.name,
          ...(mode.description != null ? { description: mode.description } : {}),
        })),
      };
      return;
    }

    const modeOption = res.configOptions?.find(
      (option) => option.category === "mode" && option.type === "select"
    );
    if (!modeOption || modeOption.type !== "select") return;
    // options 可能按组嵌套(SessionConfigSelectGroup),统一摊平。
    const flat = modeOption.options.flatMap((entry) =>
      "options" in entry ? entry.options : [entry]
    );
    if (flat.length === 0) return;
    this.modeMechanism = { kind: "configOption", configId: modeOption.id };
    this.modesValue = {
      currentModeId: modeOption.currentValue,
      availableModes: flat.map((option) => ({
        id: option.value,
        name: option.name,
        ...(option.description != null
          ? { description: option.description }
          : {}),
      })),
    };
  }
}
