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
import { resolveAgentCliPaths } from "./agent-cli-paths.js";
import type {
  AgentDriver,
  AgentRunInput,
  DriverEventStream,
} from "./agent-driver.js";

type Adapter = ClaudeAgentAdapter | CodexAgentAdapter;

class AdapterAgentDriver implements AgentDriver {
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
    return resolveQuestion(command.conversationId, command.answers);
  }
}

export function createAdapterAgentDriver(
  config: RunConfig,
  trace: AgentTraceSink | undefined,
  emitRunStatusForAguiThread: (
    aguiThreadId: string,
    payload: RunStatusPayload
  ) => void
): AgentDriver {
  const { agentProviderConfig, runtimePath } = config;
  const { claudeExecutablePath, codexExecutablePath } =
    resolveAgentCliPaths(process.env);

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
    return new AdapterAgentDriver(
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

  return new AdapterAgentDriver(
    new CodexAgentAdapter({
      ...credentials,
      cwd: runtimePath,
      trace,
      ...(codexExecutablePath ? { codexPathOverride: codexExecutablePath } : {}),
    })
  );
}
