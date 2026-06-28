import { Injectable } from "@nestjs/common";
import type { AgentType } from "@agework/shared";
import type { ProviderConfig } from "@agework/shared/api";
import { generateText, type LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { ModelProviderService } from "../../model-providers/model-provider.service";
import { normalizeBaseUrl } from "../../common/base-url";

const TITLE_MAX_LEN = 40;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_TOKENS = 64;

type GenerateTitleInput = {
  agentType: AgentType;
  modelProviderId?: string | null;
  userText: string;
};

function titlePrompt(userText: string): string {
  return (
    "根据用户的提问生成一个简洁的会话标题。要求：概括核心意图；" +
    "不超过 15 个字（英文不超过 6 个词）；使用与提问相同的语言；" +
    "不要引号、标点或任何前缀，只输出标题本身。\n\n用户提问：\n" +
    userText.slice(0, 1000)
  );
}

function aiSdkBaseUrl(baseUrl: string): string | undefined {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) return undefined;
  return base.endsWith("/v1") ? base : `${base}/v1`;
}

function normalizeTitle(raw: string): string | null {
  const title = raw
    .trim()
    .replace(/^["'「『]+|["'」』]+$/g, "")
    .replace(/\s+/g, " ")
    .slice(0, TITLE_MAX_LEN)
    .trim();
  return title || null;
}

function firstConfiguredModel(providerConfig: ProviderConfig): string | null {
  return providerConfig.models.map((m) => m.trim()).find(Boolean) ?? null;
}

@Injectable()
export class TitleService {
  constructor(private readonly modelProviderService: ModelProviderService) {}

  async generateTitle(input: GenerateTitleInput): Promise<string | null> {
    const userText = input.userText.trim();
    if (!userText) return null;

    const model = await this.resolveTitleModel(
      input.agentType,
      input.modelProviderId
    );
    if (!model) return null;

    const { text } = await generateText({
      model,
      prompt: titlePrompt(userText),
      maxOutputTokens: MAX_TOKENS,
      temperature: 0,
      maxRetries: 0,
      timeout: REQUEST_TIMEOUT_MS,
    });
    return normalizeTitle(text);
  }

  private async resolveTitleModel(
    agentType: AgentType,
    modelProviderId?: string | null
  ): Promise<LanguageModel | null> {
    if (!modelProviderId) return null;

    const resolved = await this.modelProviderService.resolveEnabledProvider(
      agentType,
      modelProviderId
    );
    if (!resolved || resolved.source === "system") return null;

    return this.createTitleModel(agentType, resolved.providerConfig);
  }

  private createTitleModel(
    agentType: AgentType,
    providerConfig: ProviderConfig
  ): LanguageModel | null {
    const baseURL = aiSdkBaseUrl(providerConfig.baseUrl);
    const apiKey = providerConfig.apiKey.trim();
    const modelId = firstConfiguredModel(providerConfig);
    if (!baseURL || !apiKey || !modelId) return null;

    if (agentType === "claude") {
      return createAnthropic({ authToken: apiKey, baseURL }).languageModel(
        modelId
      );
    }
    return createOpenAI({ apiKey, baseURL }).chat(modelId);
  }
}
