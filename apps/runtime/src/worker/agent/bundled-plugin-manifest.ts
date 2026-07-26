/**
 * Bundled plugin metadata shared by build-time checks and Worker startup.
 *
 * Keep this module data-only: dependency synchronization runs before workspace
 * packages are built, so importing plugin factories here would require their
 * generated dist entrypoints too early.
 */
export const BUNDLED_AGENT_PLUGIN_IDS = ["builtin-agents", "acp"] as const;

export type BundledAgentPluginId = (typeof BUNDLED_AGENT_PLUGIN_IDS)[number];

export function listBundledAgentPluginIds(): BundledAgentPluginId[] {
  return [...BUNDLED_AGENT_PLUGIN_IDS];
}
