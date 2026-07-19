import {
  defineAgentPlugin,
  type AgentPlugin,
  type AgentPluginModule,
} from "@agework/agent-sdk";

export function parseAgentPluginPackages(
  raw: string | undefined
): string[] {
  if (!raw) return [];
  const packageNames = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (packageNames.some((value) => /\s/.test(value))) {
    throw new Error(
      `AGEWORK_AGENT_PLUGINS expects comma-separated package names, got: ${raw}`
    );
  }
  return [...new Set(packageNames)];
}

/** Load only explicitly configured packages; there is no implicit discovery. */
export async function loadAgentPlugins(
  packageNames: readonly string[]
): Promise<AgentPlugin[]> {
  const plugins: AgentPlugin[] = [];
  for (const packageName of new Set(packageNames)) {
    let module: AgentPluginModule;
    try {
      module = (await import(packageName)) as AgentPluginModule;
    } catch (error) {
      throw new Error(`Failed to load agent plugin package: ${packageName}`, {
        cause: error,
      });
    }
    if (typeof module.createAgentPlugin !== "function") {
      throw new Error(
        `Agent plugin package ${packageName} must export createAgentPlugin()`
      );
    }
    plugins.push(defineAgentPlugin(await module.createAgentPlugin()));
  }
  return plugins;
}
