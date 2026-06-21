import type { ProviderConfig } from "@agework/shared/api";

export function getApiKey(providerConfig: ProviderConfig): string {
  return providerConfig.apiKey;
}

export function normalizeBaseUrl(baseUrl?: string): string | undefined {
  if (!baseUrl) return undefined;
  const trimmed = baseUrl.trim().replace(/\/$/, "");
  // 校验 URL scheme，防止 file://、javascript: 等非法协议通过
  if (trimmed && !/^https?:\/\//i.test(trimmed)) {
    throw new Error(`Base URL 必须以 http:// 或 https:// 开头: ${trimmed}`);
  }
  return trimmed;
}

export function anthropicMessagesUrl(baseUrl: string): string {
  return `${baseUrl}/v1/messages`;
}

export function anthropicHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  };
}

export function openAIChatCompletionsUrl(baseUrl: string): string {
  return baseUrl.endsWith("/v1")
    ? `${baseUrl}/chat/completions`
    : `${baseUrl}/v1/chat/completions`;
}

export function openAIModelsUrl(baseUrl: string): string {
  return baseUrl.endsWith("/v1") ? `${baseUrl}/models` : `${baseUrl}/v1/models`;
}

export function openAIHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}
