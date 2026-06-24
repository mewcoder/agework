import { toast } from "sonner";
import type { ModelProvider } from "@/hooks/model-provider-hooks";
import {
  AGENT_LABELS,
  AGENT_TYPES,
  isAgentType,
  type AgentType,
} from "@agework/shared";

// ── Constants ──────────────────────────────────────────────────────────────

export const MANAGED_AGENTS = AGENT_TYPES;
export type ManagedAgent = AgentType;

// ── Helpers ────────────────────────────────────────────────────────────────

export function isManagedAgent(agent: string): agent is ManagedAgent {
  return isAgentType(agent);
}

export function agentOrDefault(agent: string): ManagedAgent {
  return isManagedAgent(agent) ? agent : "claude";
}

// ── Admin helpers ──────────────────────────────────────────────────────────

export function agentLabel(agentType: string) {
  return isManagedAgent(agentType) ? AGENT_LABELS[agentType] : agentType;
}

export function isSystemModelProvider(modelProvider: ModelProvider) {
  return (
    modelProvider.scope === "system" ||
    modelProvider.modelProviderId.startsWith("system:")
  );
}

function agentSortOrder(agentType: string) {
  const index = MANAGED_AGENTS.indexOf(agentType as ManagedAgent);
  return index === -1 ? MANAGED_AGENTS.length : index;
}

export function compareModelProviders(a: ModelProvider, b: ModelProvider) {
  const aSystem = isSystemModelProvider(a);
  const bSystem = isSystemModelProvider(b);
  if (aSystem !== bSystem) return aSystem ? -1 : 1;

  const agentOrder = agentSortOrder(a.agentType) - agentSortOrder(b.agentType);
  if (agentOrder !== 0) return agentOrder;

  return Date.parse(a.createdAt) - Date.parse(b.createdAt);
}

// ── Config value accessors ────────────────────────────────────────────────

function parseRawConfig(providerConfig: string): { baseUrl?: unknown; models?: unknown } {
  try {
    return JSON.parse(providerConfig) as { baseUrl?: unknown; models?: unknown };
  } catch {
    return {};
  }
}

export function getBaseUrl(modelProvider: ModelProvider): string {
  const { baseUrl } = parseRawConfig(modelProvider.providerConfig);
  return typeof baseUrl === 'string' ? baseUrl : '';
}

export function getModel(modelProvider: ModelProvider): string {
  const { models } = parseRawConfig(modelProvider.providerConfig);
  return Array.isArray(models) && typeof models[0] === 'string' ? models[0] : '';
}

// ── Toast helpers ───────────────────────────────────────────────────────────

export function showModelProviderTestToast(type: 'success' | 'error', message: string) {
  toast[type](message, { position: 'top-center' });
}
