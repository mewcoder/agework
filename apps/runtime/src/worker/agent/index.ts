import type {
  AgentDriver,
  AgentRunInput,
  AgentRunPayload,
} from "@agework/agent-sdk";
import type {
  AgentTraceSink,
  RunConfig,
  RunStatusPayload,
} from "@agework/shared/protocol";
import { findInPath } from "@agework/shared/cli";
import { MockAgentDriver } from "./mock-agent.driver";
import { AgentPluginRegistry } from "./plugin-registry";
import {
  loadAgentPlugins,
  parseAgentPluginPackages,
} from "./plugin-loader";
import { createBundledAgentPlugins } from "./bundled-plugins";

export type { AgentDriver, AgentRunInput, AgentRunPayload } from "@agework/agent-sdk";

export async function createAgentDriver(
  config: RunConfig,
  trace: AgentTraceSink | undefined,
  emitRunStatusForAguiThread: (
    aguiThreadId: string,
    payload: RunStatusPayload
  ) => void
): Promise<AgentDriver> {
  const { agentProviderConfig, runtimePath } = config;
  const agentType = agentProviderConfig.agentType;
  // Native Host 解析结果优先；容器/手工部署退回约定 env，再退回 PATH。
  const executablePath =
    config.agentExecutablePaths?.[agentType] ??
    resolveAgentExecutablePath(agentType, process.env);

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

  const registry = new AgentPluginRegistry();
  for (const plugin of createBundledAgentPlugins()) registry.register(plugin);
  const externalPlugins = await loadAgentPlugins(
    parseAgentPluginPackages(process.env.AGEWORK_AGENT_PLUGINS)
  );
  for (const plugin of externalPlugins) registry.register(plugin);

  return registry.createDriver({
    agentType,
    provider: agentProviderConfig,
    runtimePath,
    input: config.input,
    ...(executablePath ? { executablePath } : {}),
    env: config.env,
    trace,
    pendingActionSink,
  });
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

export function resolveAgentExecutablePath(
  agentType: string,
  env: Record<string, string | undefined>
): string | undefined {
  const envKey = `AGEWORK_${agentType.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}_CLI_PATH`;
  return env[envKey]?.trim() || (findInPath(agentType) ?? undefined);
}
