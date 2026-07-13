import {
  ClaudeAgentAdapter,
  createCodexAdapter,
  type CodexAgentInstance,
  cancelQuestion,
  AcpAgentAdapter,
  createAcpAdapter,
  getAcpProfile,
} from "@agework/adapters";
import type {
  AgentTraceSink,
  CommandPayload,
  RunConfig,
  RunStatusPayload,
} from "@agework/shared/protocol";
import { findInPath } from "@agework/shared/cli";
import type { Subscription } from "rxjs";
import { MockAgentDriver } from "./mock-agent.driver";

type Adapter = ClaudeAgentAdapter | CodexAgentInstance | AcpAgentAdapter;

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
  opencodeExecutablePath?: string;
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
    // Both Claude and Codex adapters implement resolveApproval (【决策2】).
    // The adapter interprets the opaque payload provider-specifically.
    return this.adapter.resolveApproval(
      command.conversationId,
      command.payload,
      command.resumeRunId,
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
  const opencodeExecutablePath =
    config.opencodeExecutablePath ?? envCliPaths.opencodeExecutablePath;

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

  // baseUrl 以 `mock:` 开头视为内部测试 scheme：返回确定性 mock 执行器,
  // 不接任何真实 SDK/CLI(e2e/本地联调用,见 MockAgentDriver)。
  if (
    agentProviderConfig.source === "custom" &&
    agentProviderConfig.baseUrl.startsWith("mock:")
  ) {
    return new MockAgentDriver();
  }

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

  if (agentProviderConfig.agentType === "opencode") {
    const profile = getAcpProfile("opencode");
    if (!profile) {
      throw new Error("OpenCode ACP profile not registered");
    }
    return new AdapterDriver(
      createAcpAdapter(profile, {
        source: agentProviderConfig.source,
        cwd: runtimePath,
        ...credentials,
        trace,
        pendingActionSink,
        ...(opencodeExecutablePath
          ? { executablePath: opencodeExecutablePath }
          : {}),
      })
    );
  }

  return new AdapterDriver(
    createCodexAdapter({
      ...credentials,
      cwd: runtimePath,
      trace,
      pendingActionSink,
      ...(codexExecutablePath ? { codexPath: codexExecutablePath } : {}),
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
  const opencodeExecutablePath =
    env.AGEWORK_OPENCODE_CLI_PATH?.trim() ||
    (findInPath("opencode") ?? undefined);
  return { claudeExecutablePath, codexExecutablePath, opencodeExecutablePath };
}
