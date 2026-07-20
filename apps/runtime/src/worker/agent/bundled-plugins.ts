import { createAgentPlugin as createBuiltinAgentPlugin } from "@agework/adapters/plugin";
import { createAgentPlugin as createAcpAgentPlugin } from "@agework/agent-acp";
import type { AgentPlugin } from "@agework/agent-sdk";
import {
  BUNDLED_AGENT_PLUGIN_IDS,
  type BundledAgentPluginId,
} from "./bundled-plugin-manifest";

const BUNDLED_AGENT_PLUGIN_FACTORIES: Record<
  BundledAgentPluginId,
  () => AgentPlugin
> = {
  "builtin-agents": createBuiltinAgentPlugin,
  acp: createAcpAgentPlugin,
};

export function createBundledAgentPlugins(): AgentPlugin[] {
  return BUNDLED_AGENT_PLUGIN_IDS.map((id) => {
    const plugin = BUNDLED_AGENT_PLUGIN_FACTORIES[id]();
    if (plugin.id !== id) {
      throw new Error(
        `Bundled agent plugin registry expected ${id}, received ${plugin.id}`
      );
    }
    return plugin;
  });
}
