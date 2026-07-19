import type { AgentPlugin } from "./types";

export const AGENT_PLUGIN_API_VERSION = 1 as const;

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9-]*$/;
const PACKAGE_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const EXECUTABLE_PATTERN = /^[A-Za-z0-9._-]+$/;

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

  if (plugin.runtimeRequirements) {
    const requirementTypes = Object.keys(plugin.runtimeRequirements);
    for (const agentType of plugin.agentTypes) {
      if (!plugin.runtimeRequirements[agentType]) {
        throw new Error(
          `Agent plugin ${plugin.id} is missing runtime requirements for ${agentType}`
        );
      }
    }
    for (const agentType of requirementTypes) {
      if (!agentTypes.has(agentType)) {
        throw new Error(
          `Agent plugin ${plugin.id} has runtime requirements for unknown agent type ${agentType}`
        );
      }
      const requirement = plugin.runtimeRequirements[agentType]!;
      const packages = Object.entries(requirement.npmPackages);
      if (packages.length === 0) {
        throw new Error(
          `Agent plugin ${plugin.id} runtime requirements for ${agentType} require at least one npm package`
        );
      }
      for (const [packageName, version] of packages) {
        if (!PACKAGE_PATTERN.test(packageName)) {
          throw new Error(
            `Invalid runtime package in plugin ${plugin.id}: ${packageName}`
          );
        }
        if (!EXACT_VERSION_PATTERN.test(version)) {
          throw new Error(
            `Runtime package ${packageName} in plugin ${plugin.id} must use an exact version: ${version}`
          );
        }
      }
      if (
        requirement.agentExecutable &&
        !EXECUTABLE_PATTERN.test(requirement.agentExecutable)
      ) {
        throw new Error(
          `Invalid agent executable in plugin ${plugin.id}: ${requirement.agentExecutable}`
        );
      }
    }
  }
  return plugin;
}
