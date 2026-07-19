export type AgentRunPayload = { threadId: string } & Record<string, unknown>;

export type AgentRunInput = {
  aguiThreadId: string;
  payload: AgentRunPayload;
};

export type AgentSubscription = {
  unsubscribe(): void;
};

/** Observable-like event stream, without requiring plugins to depend on RxJS. */
export type AgentEventStream = {
  subscribe(observer: {
    next: (event: unknown) => void;
    complete: () => void;
    error: (error: Error) => void;
  }): AgentSubscription;
};

/** Worker control command. Provider-specific payloads stay opaque to the host. */
export type AgentControlCommand = {
  type: string;
  commandId: string;
  runId: string;
  conversationId?: string;
  payload?: unknown;
  resumeRunId?: string;
};

/** The only execution surface the Worker consumes from an agent integration. */
export interface AgentDriver {
  run(input: AgentRunInput): AgentEventStream;
  interrupt(aguiThreadId?: string): Promise<void>;
  cancel(aguiThreadId?: string): Promise<void>;
  resolveControl(command: AgentControlCommand): boolean | Promise<boolean>;
  shutdown?(): Promise<void>;
}

export type AgentTraceEvent = {
  name: string;
  payload?: unknown;
  runId?: string;
  threadId?: string;
};

export type AgentTraceSink = (event: AgentTraceEvent) => void;

export type AgentPendingAction = "question" | null;

export type AgentPendingActionSink = (event: {
  threadId: string;
  pendingAction: AgentPendingAction;
}) => void;

export type AgentProviderSettings =
  | {
      agentType: string;
      source: "system";
    }
  | {
      agentType: string;
      source: "custom";
      apiFormat: string;
      baseUrl: string;
      apiKey: string;
      model: string;
      extraConfig?: Record<string, string>;
    };

/** Per-run data supplied by the Worker to the selected plugin. */
export type AgentPluginCreateContext = {
  agentType: string;
  provider: AgentProviderSettings;
  runtimePath: string;
  input: unknown;
  /** Host-resolved CLI path for this agent type, when available. */
  executablePath?: string;
  /** Explicit run environment only; Worker process secrets are not exposed here. */
  env: Readonly<Record<string, string>>;
  trace?: AgentTraceSink;
  pendingActionSink: AgentPendingActionSink;
};

/** Reproducible packages and binaries required by one agent in a managed runtime. */
export type AgentRuntimeRequirement = {
  /** Exact npm versions installed into the managed Runtime dependency prefix. */
  npmPackages: Readonly<Record<string, string>>;
  /** Agent CLI binary resolved through the managed Runtime PATH. */
  agentExecutable?: string;
};

export type AgentRuntimeRequirements = Readonly<
  Record<string, AgentRuntimeRequirement>
>;

/** One package may serve several agent types (for example the bundled ACP profiles). */
export interface AgentPlugin {
  readonly apiVersion: 1;
  readonly id: string;
  readonly displayName: string;
  readonly agentTypes: readonly string[];
  /**
   * Managed-runtime requirements keyed by agentType. Optional for API v1
   * compatibility; bundled plugins must provide it and are checked by Runtime.
   */
  readonly runtimeRequirements?: AgentRuntimeRequirements;
  create(
    context: AgentPluginCreateContext
  ): AgentDriver | Promise<AgentDriver>;
}

/** Standard package export used by the Worker plugin loader. */
export interface AgentPluginModule {
  createAgentPlugin?: () => AgentPlugin | Promise<AgentPlugin>;
}
