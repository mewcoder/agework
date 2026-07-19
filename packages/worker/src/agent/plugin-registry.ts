import {
  AGENT_PLUGIN_API_VERSION,
  defineAgentPlugin,
  type AgentDriver,
  type AgentPlugin,
  type AgentPluginCreateContext,
} from "@agework/agent-sdk";

/** Host-side registry. A single agentType has exactly one owning plugin. */
export class AgentPluginRegistry {
  private readonly pluginsByAgentType = new Map<string, AgentPlugin>();

  register(candidate: AgentPlugin): void {
    const plugin = defineAgentPlugin(candidate);
    if (plugin.apiVersion !== AGENT_PLUGIN_API_VERSION) {
      throw new Error(
        `Unsupported agent plugin API version for ${plugin.id}: ${plugin.apiVersion}`
      );
    }
    for (const agentType of plugin.agentTypes) {
      const existing = this.pluginsByAgentType.get(agentType);
      if (existing) {
        throw new Error(
          `Duplicate agent type ${agentType}: plugins ${existing.id} and ${plugin.id}`
        );
      }
      this.pluginsByAgentType.set(agentType, plugin);
    }
  }

  async createDriver(context: AgentPluginCreateContext): Promise<AgentDriver> {
    const plugin = this.pluginsByAgentType.get(context.agentType);
    if (!plugin) {
      throw new Error(`No agent plugin registered for: ${context.agentType}`);
    }
    return plugin.create(context);
  }
}
