import { createAgentPlugin as createBuiltinAgentPlugin } from "@agework/adapters/plugin";
import { createAgentPlugin as createAcpAgentPlugin } from "@agework/agent-acp";
import type { AgentPlugin } from "@agework/agent-sdk";

/** Single registry used by both Worker execution and managed Runtime packaging. */
const BUNDLED_AGENT_PLUGINS = [
  { id: "builtin-agents", create: createBuiltinAgentPlugin },
  { id: "acp", create: createAcpAgentPlugin },
] as const;

export function createBundledAgentPlugins(): AgentPlugin[] {
  return BUNDLED_AGENT_PLUGINS.map(({ id, create }) => {
    const plugin = create();
    if (plugin.id !== id) {
      throw new Error(
        `Bundled agent plugin registry expected ${id}, received ${plugin.id}`
      );
    }
    return plugin;
  });
}

export function listBundledAgentPluginIds(): string[] {
  return BUNDLED_AGENT_PLUGINS.map(({ id }) => id);
}
