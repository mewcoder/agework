import {
  defineAgentPlugin,
  type AgentControlCommand,
  type AgentDriver,
  type AgentEventStream,
  type AgentPlugin,
  type AgentPluginCreateContext,
  type AgentRunInput,
} from "@agework/agent-sdk";
import { ClaudeAgentAdapter, cancelQuestion } from "./claude/business/claude-agent.adapter";
import { createCodexAdapter, type CodexAgentInstance } from "./codex/factory";

type BuiltinAdapter = ClaudeAgentAdapter | CodexAgentInstance;

class BuiltinAdapterDriver implements AgentDriver {
  constructor(private readonly adapter: BuiltinAdapter) {}

  run(input: AgentRunInput): AgentEventStream {
    return this.adapter.run(input.payload as never) as AgentEventStream;
  }

  interrupt(aguiThreadId?: string): Promise<void> {
    return this.adapter.interrupt(aguiThreadId);
  }

  async cancel(aguiThreadId?: string): Promise<void> {
    if (aguiThreadId) cancelQuestion(aguiThreadId);
    await this.adapter.interrupt(aguiThreadId);
  }

  resolveControl(command: AgentControlCommand): boolean {
    if (
      command.type !== "approval_resolved" ||
      typeof command.conversationId !== "string"
    ) {
      return false;
    }
    return this.adapter.resolveApproval(
      command.conversationId,
      command.payload,
      command.resumeRunId
    );
  }

  async shutdown(): Promise<void> {
    if (
      "shutdown" in this.adapter &&
      typeof this.adapter.shutdown === "function"
    ) {
      await this.adapter.shutdown();
    }
  }
}

function createBuiltinDriver(context: AgentPluginCreateContext): AgentDriver {
  const { provider, runtimePath, executablePath, trace, pendingActionSink } =
    context;
  const credentials =
    provider.source === "system"
      ? {}
      : {
          apiKey: provider.apiKey,
          model: provider.model,
          baseUrl: provider.baseUrl,
          extraConfig: provider.extraConfig,
        };
  const apiFormat =
    provider.source === "custom" ? provider.apiFormat : undefined;

  if (context.agentType === "claude") {
    return new BuiltinAdapterDriver(
      new ClaudeAgentAdapter({
        ...credentials,
        cwd: runtimePath,
        isEnvironmentConfig: provider.source === "system",
        pendingActionSink,
        trace,
        ...(executablePath
          ? { pathToClaudeCodeExecutable: executablePath }
          : {}),
      })
    );
  }

  if (context.agentType === "codex") {
    return new BuiltinAdapterDriver(
      createCodexAdapter({
        ...credentials,
        apiFormat:
          apiFormat === "openai-responses" ||
          apiFormat === "openai-compatible"
            ? apiFormat
            : undefined,
        cwd: runtimePath,
        trace,
        pendingActionSink,
        ...(executablePath ? { codexPath: executablePath } : {}),
      })
    );
  }

  throw new Error(`Built-in adapter not registered: ${context.agentType}`);
}

/** Claude and Codex stay bundled together; ACP is a separate official plugin. */
export function createAgentPlugin(): AgentPlugin {
  return defineAgentPlugin({
    apiVersion: 1,
    id: "builtin-agents",
    displayName: "AgeWork Built-in Agents",
    agentTypes: ["claude", "codex"],
    create: createBuiltinDriver,
  });
}
