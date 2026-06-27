export type AgentTraceEvent = {
  name: string;
  payload?: unknown;
  runId?: string;
  threadId?: string;
};

export type AgentTraceSink = (event: AgentTraceEvent) => void;

export type AgentEventTracePayload = {
  name: string;
  payload?: unknown;
  runId?: string;
  threadId?: string;
  conversationId?: string;
  workspaceId?: string;
  agentType?: string;
};

export type AgentEventTraceConfig = {
  enabled: boolean;
  logDir?: string;
  rawFilePath?: string;
  rawRuntimeFilePath?: string;
  aguiFilePath?: string;
  aguiRuntimeFilePath?: string;
  maxFileMb?: number;
  runId: string;
  conversationId: string;
  workspaceId: string;
  agentType: string;
};
