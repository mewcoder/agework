import type {
  AgentApp,
  ClientConnection,
  InitializeResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionNotification,
  Stream,
} from "@agentclientprotocol/sdk";
import { loadAcpSdk, type AcpSdk } from "../sdk";
import { AcpError } from "../protocol/types";
import {
  normalizeCapabilities,
  type AcpNormalizedCapabilities,
} from "../protocol/capabilities";

/** The `update` payload of a `session/update` notification. */
export type AcpSessionUpdate = SessionNotification["update"];

/** Handles an incoming `session/request_permission` (installed by the permission bridge). */
export type AcpPermissionHandler = (
  req: RequestPermissionRequest
) => Promise<RequestPermissionResponse>;

/** Raw-trace hook for ACP protocol diagnostics. */
export type AcpTrace = (name: string, payload: unknown) => void;

/** Where the client attaches: a stdio {@link Stream} (production) or an in-process {@link AgentApp} (tests). */
export type AcpConnectTarget = Stream | AgentApp;

export type AcpConnectionOptions = {
  target: AcpConnectTarget;
  clientInfo: { name: string; version: string };
  trace?: AcpTrace;
};

/**
 * Owns the client side of an ACP connection: performs the initialize handshake,
 * snapshots normalized capabilities, and routes inbound `session/update`
 * notifications and `session/request_permission` requests to the right
 * per-session handler. It exposes the agent-side RPCs (`session/new`, `load`,
 * `resume`, `prompt`, `cancel`) but does not own session lifecycle — see
 * {@link AcpSession}.
 */
export class AcpConnection {
  private conn!: ClientConnection;
  private caps!: AcpNormalizedCapabilities;
  private readonly sessionHandlers = new Map<
    string,
    (update: AcpSessionUpdate) => void
  >();
  private permissionHandler?: AcpPermissionHandler;

  private constructor(
    private readonly sdk: AcpSdk,
    private readonly trace?: AcpTrace
  ) {}

  /** Connect, run the `initialize` handshake, and snapshot capabilities. */
  static async initialize(opts: AcpConnectionOptions): Promise<AcpConnection> {
    const sdk = await loadAcpSdk();
    const instance = new AcpConnection(sdk, opts.trace);

    const app = sdk
      .client()
      .onNotification(sdk.methods.client.session.update, (ctx) => {
        instance.routeUpdate(ctx.params);
      })
      .onRequest(sdk.methods.client.session.requestPermission, (ctx) =>
        instance.routePermission(ctx.params)
      );

    // Narrow the union so the overloaded `connect` resolves cleanly.
    instance.conn =
      opts.target instanceof sdk.AgentApp
        ? app.connect(opts.target)
        : app.connect(opts.target);

    let initRes: InitializeResponse;
    try {
      initRes = await instance.conn.agent.request(sdk.methods.agent.initialize, {
        protocolVersion: sdk.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: opts.clientInfo,
      });
    } catch (err) {
      instance.conn.close();
      throw new AcpError("ACP_INITIALIZE_FAILED", "ACP initialize failed", err);
    }

    if (initRes.protocolVersion !== sdk.PROTOCOL_VERSION) {
      instance.conn.close();
      throw new AcpError(
        "ACP_VERSION_UNSUPPORTED",
        `ACP protocol version ${initRes.protocolVersion} unsupported (client uses ${sdk.PROTOCOL_VERSION})`
      );
    }

    instance.caps = normalizeCapabilities(initRes);
    instance.trace?.("sdk.acp.initialize", initRes);
    return instance;
  }

  get capabilities(): AcpNormalizedCapabilities {
    return this.caps;
  }

  /** Resolves when the underlying connection closes. */
  get closed(): Promise<void> {
    return this.conn.closed;
  }

  /**
   * Route `session/update` notifications for `sessionId` to `handler`. Returns
   * an unregister function.
   */
  registerSession(
    sessionId: string,
    handler: (update: AcpSessionUpdate) => void
  ): () => void {
    this.sessionHandlers.set(sessionId, handler);
    return () => {
      if (this.sessionHandlers.get(sessionId) === handler) {
        this.sessionHandlers.delete(sessionId);
      }
    };
  }

  /** Install (or clear) the permission bridge handler (Ticket 4). */
  setPermissionHandler(handler: AcpPermissionHandler | undefined): void {
    this.permissionHandler = handler;
  }

  async newSession(req: NewSessionRequest): Promise<NewSessionResponse> {
    try {
      return await this.conn.agent.request(
        this.sdk.methods.agent.session.new,
        req
      );
    } catch (err) {
      throw new AcpError("ACP_SESSION_CREATE_FAILED", "session/new failed", err);
    }
  }

  async loadSession(req: LoadSessionRequest): Promise<LoadSessionResponse> {
    try {
      return await this.conn.agent.request(
        this.sdk.methods.agent.session.load,
        req
      );
    } catch (err) {
      throw new AcpError(
        "ACP_SESSION_NOT_FOUND",
        "session/load failed (session may not exist)",
        err
      );
    }
  }

  async resumeSession(
    req: ResumeSessionRequest
  ): Promise<ResumeSessionResponse> {
    try {
      return await this.conn.agent.request(
        this.sdk.methods.agent.session.resume,
        req
      );
    } catch (err) {
      throw new AcpError(
        "ACP_SESSION_NOT_FOUND",
        "session/resume failed (session may not exist)",
        err
      );
    }
  }

  async prompt(req: PromptRequest): Promise<PromptResponse> {
    try {
      return await this.conn.agent.request(
        this.sdk.methods.agent.session.prompt,
        req
      );
    } catch (err) {
      throw new AcpError("ACP_PROMPT_FAILED", "session/prompt failed", err);
    }
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    try {
      await this.conn.agent.request(this.sdk.methods.agent.session.setMode, {
        sessionId,
        modeId,
      });
    } catch (err) {
      throw new AcpError(
        "ACP_SET_MODE_FAILED",
        `session/set_mode failed for mode ${modeId}`,
        err
      );
    }
  }

  /** 部分 agent(如 opencode)不用 modes 字段,把模式暴露为 config option。 */
  async setConfigOption(
    sessionId: string,
    configId: string,
    value: string
  ): Promise<void> {
    try {
      await this.conn.agent.request(
        this.sdk.methods.agent.session.setConfigOption,
        { sessionId, configId, value }
      );
    } catch (err) {
      throw new AcpError(
        "ACP_SET_MODE_FAILED",
        `session/set_config_option failed for ${configId}=${value}`,
        err
      );
    }
  }

  async cancel(sessionId: string): Promise<void> {
    await this.conn.agent.notify(this.sdk.methods.agent.session.cancel, {
      sessionId,
    });
  }

  /** Close the connection, rejecting any pending requests. */
  close(): void {
    this.conn.close();
  }

  private routeUpdate(params: SessionNotification): void {
    this.trace?.("sdk.acp.notification", params);
    this.sessionHandlers.get(params.sessionId)?.(params.update);
  }

  private async routePermission(
    req: RequestPermissionRequest
  ): Promise<RequestPermissionResponse> {
    this.trace?.("sdk.acp.permission.request", req);
    if (this.permissionHandler) return this.permissionHandler(req);
    // No permission bridge installed (pre-Ticket 4): decline safely.
    return { outcome: { outcome: "cancelled" } };
  }
}
