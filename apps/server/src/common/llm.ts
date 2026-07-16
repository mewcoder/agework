/**
 * 从一个 provider 配置构造可直接调用的 ai-SDK LanguageModel。
 * 纯函数、后端通用 LLM 基础设施，只认 @agework/shared 的 ApiFormat / ProviderConfig，
 * 不属于任何 feature 领域。配置不全或 baseUrl 非法时返回 { error }，由调用方决定如何处理。
 */
import type { ApiFormat } from "@agework/shared";
import type { ProviderConfig } from "@agework/shared/api";
import type { LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { normalizeBaseUrl } from "./base-url";

export function getLLMClient(
  apiFormat: ApiFormat,
  providerConfig: ProviderConfig
): { model: LanguageModel } | { error: string } {
  let base: string | undefined;
  try {
    base = normalizeBaseUrl(providerConfig.baseUrl);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  if (!base) return { error: "未配置 baseUrl" };

  const apiKey = providerConfig.apiKey.trim();
  if (!apiKey) return { error: "未配置 apiKey" };
  const modelId = providerConfig.models.map((m) => m.trim()).find(Boolean);
  if (!modelId) return { error: "未配置 models" };

  const baseURL = base.endsWith("/v1") ? base : `${base}/v1`;
  if (apiFormat === "anthropic") {
    return {
      model: createAnthropic({ authToken: apiKey, baseURL }).languageModel(
        modelId
      ),
    };
  }
  // openai-compatible 端点走 chat completions;这里统一用 @ai-sdk/openai 的两种入口探测。
  const openai = createOpenAI({ apiKey, baseURL });
  return {
    model:
      apiFormat === "openai-responses"
        ? openai.responses(modelId)
        : openai.chat(modelId),
  };
}
