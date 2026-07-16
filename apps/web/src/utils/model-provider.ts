import { toast } from "sonner";
import type { ModelProvider } from "@/hooks/model-provider-hooks";
import {
  AGENT_LABELS,
  API_FORMAT_LABELS,
  isAgentType,
  isApiFormat,
} from "@agework/shared";

// ── Helpers ────────────────────────────────────────────────────────────────

export function agentLabel(agentType: string) {
  return isAgentType(agentType) ? AGENT_LABELS[agentType] : agentType;
}

export function apiFormatLabel(apiFormat: string) {
  return isApiFormat(apiFormat) ? API_FORMAT_LABELS[apiFormat] : apiFormat;
}

export function isSystemModelProvider(modelProvider: ModelProvider) {
  return modelProvider.scope === "system";
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
