import {
  defineAgentPlugin,
  type AgentControlCommand,
  type AgentDriver,
  type AgentEventStream,
  type AgentPlugin,
  type AgentPluginCreateContext,
  type AgentRunInput,
} from "@agework/agent-sdk";
import { AcpAgentAdapter } from "./adapter";
import { createAcpAdapter } from "./create-adapter";
import { getAcpProfile, listAcpProfiles } from "./agents/registry";

class AcpAgentDriver implements AgentDriver {
  constructor(private readonly adapter: AcpAgentAdapter) {}

  run(input: AgentRunInput): AgentEventStream {
    return this.adapter.run(input.payload as never) as AgentEventStream;
  }

  interrupt(aguiThreadId?: string): Promise<void> {
    return this.adapter.interrupt(aguiThreadId);
  }

  cancel(aguiThreadId?: string): Promise<void> {
    return this.adapter.interrupt(aguiThreadId);
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

  shutdown(): Promise<void> {
    return this.adapter.shutdown();
  }
}

function createAcpDriver(context: AgentPluginCreateContext): AgentDriver {
  const profile = getAcpProfile(context.agentType);
  if (!profile) {
    throw new Error(`ACP profile not registered: ${context.agentType}`);
  }
  const provider = context.provider;
  const credentials =
    provider.source === "system"
      ? {}
      : {
          apiKey: provider.apiKey,
          model: provider.model,
          baseUrl: provider.baseUrl,
          extraConfig: provider.extraConfig,
        };
  const forwardedProps = (
    context.input as { forwardedProps?: Record<string, unknown> } | undefined
  )?.forwardedProps;
  const permissionMode =
    typeof forwardedProps?.permissionMode === "string"
      ? forwardedProps.permissionMode
      : undefined;

  return new AcpAgentDriver(
    createAcpAdapter(profile, {
      source: provider.source,
      cwd: context.runtimePath,
      apiFormat:
        provider.source === "custom" ? provider.apiFormat : undefined,
      ...credentials,
      ...(permissionMode ? { permissionMode } : {}),
      trace: context.trace,
      pendingActionSink: context.pendingActionSink,
      ...(context.executablePath
        ? { executablePath: context.executablePath }
        : {}),
    })
  );
}

/** Official bundled Agent Plugin and reference implementation for ACP profiles. */
export function createAgentPlugin(): AgentPlugin {
  const profiles = listAcpProfiles();
  return defineAgentPlugin({
    apiVersion: 1,
    id: "acp",
    displayName: "Agent Client Protocol",
    agentTypes: profiles.map((profile) => profile.agentType),
    runtimeRequirements: Object.fromEntries(
      profiles.map((profile) => [
        profile.agentType,
        profile.runtimeRequirement,
      ])
    ),
    create: createAcpDriver,
  });
}
