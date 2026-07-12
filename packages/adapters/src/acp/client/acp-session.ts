import type {
  ContentBlock,
  McpServer,
  PromptResponse,
} from "@agentclientprotocol/sdk";
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

  private constructor(private readonly opts: AcpSessionStartOptions) {}

  /** ACP session id (empty until {@link start} resolves). */
  get sessionId(): string {
    return this.sessionIdValue;
  }

  /** Whether this run created a brand-new session (vs resumed/loaded an existing one). */
  get isNew(): boolean {
    return this.createdFresh;
  }

  static async start(opts: AcpSessionStartOptions): Promise<AcpSession> {
    const session = new AcpSession(opts);
    const mcpServers = opts.mcpServers ?? [];

    if (!opts.existingSessionId) {
      const res = await opts.connection.newSession({ cwd: opts.cwd, mcpServers });
      session.bind(res.sessionId, false);
      session.createdFresh = true;
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
      await opts.connection.resumeSession({
        sessionId: opts.existingSessionId,
        cwd: opts.cwd,
        mcpServers,
      });
    } else if (caps.loadSession) {
      session.bind(opts.existingSessionId, true);
      await opts.connection.loadSession({
        sessionId: opts.existingSessionId,
        cwd: opts.cwd,
        mcpServers,
      });
    } else {
      throw new AcpError(
        "ACP_SESSION_RESUME_UNSUPPORTED",
        "Agent supports neither session/resume nor session/load; cannot restore an existing session without losing context"
      );
    }
    return session;
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
}
