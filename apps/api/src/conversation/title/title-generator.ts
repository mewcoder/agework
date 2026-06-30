import { Injectable } from "@nestjs/common";
import type { AgentType } from "@agework/shared";
import { generateText } from "ai";
import { ModelProviderService } from "../../model-provider/model-provider.service";
import { getLLMClient } from "../../common/llm";

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

function normalizeTitle(raw: string): string | null {
  const title = raw
    .trim()
    .replace(/^["'「『]+|["'」』]+$/g, "")
    .replace(/\s+/g, " ")
    .slice(0, TITLE_MAX_LEN)
    .trim();
  return title || null;
}

@Injectable()
export class TitleGenerator {
  constructor(private readonly modelProviderService: ModelProviderService) {}

  /**
   * 截断兜底标题：把用户消息文本硬截到 TITLE_MAX_LEN，去掉因截断残留的结尾标点和空白。
   * 不依赖模型,供 ConversationService 在首条用户消息时即时落一个标题（不经 DI）。
   */
  static generateDefaultTitle(text: string): string | null {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized) return null;
    const title = normalized
      .slice(0, TITLE_MAX_LEN)
      .replace(
        /[，。、；！？,.;!?…—\-~·""''「」『』（）()【】[\]《》<>\s]+$/u,
        ""
      );
    return title || null;
  }

  async generateLLMTitle(input: GenerateTitleInput): Promise<string | null> {
    const userText = input.userText.trim();
    if (!userText || !input.modelProviderId) return null;

    const resolved = await this.modelProviderService.resolveEnabledProvider(
      input.agentType,
      input.modelProviderId
    );
    if (!resolved || resolved.source === "system") return null;

    const built = getLLMClient(
      input.agentType,
      resolved.providerConfig
    );
    if ("error" in built) return null;

    const { text } = await generateText({
      model: built.model,
      prompt: titlePrompt(userText),
      maxOutputTokens: MAX_TOKENS,
      temperature: 0,
      maxRetries: 0,
      timeout: REQUEST_TIMEOUT_MS,
    });
    return normalizeTitle(text);
  }
}
