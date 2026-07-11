import {
  ClaudeAgentAdapter,
  CodexAgentAdapter,
  cancelQuestion,
  resolveQuestion,
} from "@agework/adapters";
import type {
  AgentTraceSink,
  CommandPayload,
  RunConfig,
  RunStatusPayload,
} from "@agework/shared/protocol";
import { findInPath } from "@agework/shared/cli";
import type { Subscription } from "rxjs";

type Adapter = ClaudeAgentAdapter | CodexAgentAdapter;

export type AgentRunPayload = { threadId: string } & Record<string, unknown>;

export type AgentRunInput = {
  aguiThreadId: string;
  payload: AgentRunPayload;
};

export type DriverEventStream = {
  subscribe(o: {
    next: (event: unknown) => void;
    complete: () => void;
    error: (error: Error) => void;
  }): Subscription;
};

export type AgentDriver = {
  run(input: AgentRunInput): DriverEventStream;
  interrupt(aguiThreadId?: string): Promise<void>;
  cancel(aguiThreadId?: string): Promise<void>;
  resolveControl(command: CommandPayload): boolean | Promise<boolean>;
  shutdown?(): Promise<void>;
};

type CliPaths = {
  claudeExecutablePath?: string;
  codexExecutablePath?: string;
};

class AdapterDriver implements AgentDriver {
  constructor(private readonly adapter: Adapter) {}

  run(input: AgentRunInput): DriverEventStream {
    return this.adapter.run(input.payload as never) as DriverEventStream;
  }

  interrupt(aguiThreadId?: string): Promise<void> {
    return this.adapter.interrupt(aguiThreadId);
  }

  async cancel(aguiThreadId?: string): Promise<void> {
    if (aguiThreadId) {
      cancelQuestion(aguiThreadId);
    }
    await this.adapter.interrupt(aguiThreadId);
  }

  resolveControl(command: CommandPayload): boolean {
    if (command.type !== "approval_resolved") return false;
    return resolveQuestion(
      command.conversationId,
      command.answers,
      command.resumeRunId
    );
  }
}

export function createAgentDriver(
  config: RunConfig,
  trace: AgentTraceSink | undefined,
  emitRunStatusForAguiThread: (
    aguiThreadId: string,
    payload: RunStatusPayload
  ) => void
): AgentDriver {
  const { agentProviderConfig, runtimePath } = config;
  // RunConfig 里的路径（local runtime 从 envConfig 提取）优先于 worker env。
  const envCliPaths = resolveCliPaths(process.env);
  const claudeExecutablePath =
    config.claudeExecutablePath ?? envCliPaths.claudeExecutablePath;
  const codexExecutablePath =
    config.codexExecutablePath ?? envCliPaths.codexExecutablePath;

  const pendingActionSink = (event: {
    threadId: string;
    pendingAction: "question" | null;
  }) => {
    const payload: RunStatusPayload = event.pendingAction
      ? { status: "requires_action", pendingAction: event.pendingAction }
      : { status: "running", pendingAction: null };
    // AG-UI boundary: event.threadId is the AgeWork conversationId.
    emitRunStatusForAguiThread(event.threadId, payload);
  };

  const credentials =
    agentProviderConfig.source === "system"
      ? {}
      : {
          apiKey: agentProviderConfig.apiKey,
          model: agentProviderConfig.model,
          baseUrl: agentProviderConfig.baseUrl,
          extraConfig: agentProviderConfig.extraConfig,
        };

  if (agentProviderConfig.agentType === "claude") {
    return new AdapterDriver(
      new ClaudeAgentAdapter({
        ...credentials,
        cwd: runtimePath,
        isEnvironmentConfig: agentProviderConfig.source === "system",
        pendingActionSink,
        trace,
        ...(claudeExecutablePath
          ? { pathToClaudeCodeExecutable: claudeExecutablePath }
          : {}),
      })
    );
  }

  return new AdapterDriver(
    new CodexAgentAdapter({
      ...credentials,
      cwd: runtimePath,
      trace,
      ...(codexExecutablePath ? { codexPathOverride: codexExecutablePath } : {}),
    })
  );
}

export function toAgentRunInput(
  input: unknown,
  fallbackAguiThreadId: string
): AgentRunInput {
  const payload =
    input && typeof input === "object" && !Array.isArray(input)
      ? ({ ...(input as Record<string, unknown>) } as AgentRunPayload)
      : ({ input } as unknown as AgentRunPayload);
  const threadId =
    typeof payload.threadId === "string" && payload.threadId.length > 0
      ? payload.threadId
      : fallbackAguiThreadId;

  return {
    aguiThreadId: threadId,
    payload: {
      ...payload,
      threadId,
    },
  };
}

export function resolveCliPaths(
  env: Record<string, string | undefined>
): CliPaths {
  const claudeExecutablePath =
    env.AGEWORK_CLAUDE_CLI_PATH?.trim() || (findInPath("claude") ?? undefined);
  const codexExecutablePath =
    env.AGEWORK_CODEX_CLI_PATH?.trim() || (findInPath("codex") ?? undefined);
  return { claudeExecutablePath, codexExecutablePath };
}
