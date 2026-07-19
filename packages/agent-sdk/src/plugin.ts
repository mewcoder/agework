import type { AgentPlugin } from "./types";

export const AGENT_PLUGIN_API_VERSION = 1 as const;

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Define and validate an agent plugin at its package boundary. */
export function defineAgentPlugin<T extends AgentPlugin>(plugin: T): T {
  if (plugin.apiVersion !== AGENT_PLUGIN_API_VERSION) {
    throw new Error(`Unsupported agent plugin API version: ${plugin.apiVersion}`);
  }
  if (!IDENTIFIER_PATTERN.test(plugin.id)) {
    throw new Error(`Invalid agent plugin id: ${plugin.id}`);
  }
  if (!plugin.displayName.trim()) {
    throw new Error(`Agent plugin ${plugin.id} requires displayName`);
  }
  if (plugin.agentTypes.length === 0) {
    throw new Error(`Agent plugin ${plugin.id} requires at least one agent type`);
  }
  const agentTypes = new Set<string>();
  for (const agentType of plugin.agentTypes) {
    if (!IDENTIFIER_PATTERN.test(agentType)) {
      throw new Error(`Invalid agent type in plugin ${plugin.id}: ${agentType}`);
    }
    if (agentTypes.has(agentType)) {
      throw new Error(`Duplicate agent type in plugin ${plugin.id}: ${agentType}`);
    }
    agentTypes.add(agentType);
  }
  return plugin;
}
