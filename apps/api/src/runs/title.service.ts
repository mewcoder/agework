import { Injectable, Logger } from "@nestjs/common";
import type { AgentType } from "@agework/shared";
import type { ProviderConfig } from "@agework/shared/api";
import { PrismaService } from "../prisma/prisma.service";
import { extractText } from "../conversations/message-text";
import { ModelProviderService } from "../model-providers/model-provider.service";
import {
  normalizeBaseUrl,
  anthropicMessagesUrl,
  anthropicHeaders,
  openAIChatCompletionsUrl,
  openAIHeaders,
} from "../model-providers/llm-client";

const TITLE_MAX_LEN = 40;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_TOKENS = 64;

function buildPrompt(userText: string): string {
  return (
    "根据用户的提问生成一个简洁的会话标题。要求：概括核心意图；" +
    "不超过 15 个字（英文不超过 6 个词）；使用与提问相同的语言；" +
    "不要引号、标点或任何前缀，只输出标题本身。\n\n用户提问：\n" +
    userText.slice(0, 1000)
  );
}

@Injectable()
export class TitleService {
  private readonly logger = new Logger(TitleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly modelProviderService: ModelProviderService
  ) {}

  // 首轮对话结束后生成更优标题。走该 agent 配置的 LLM HTTP API（非 SDK 子进程）。
  // 系统环境无 key / 无 baseUrl / 调用失败时，保留 saveUserMessage 写入的规则标题。
  async maybeGenerate(
    conversationId: string,
    agentType: string,
    modelProviderId?: string | null
  ): Promise<void> {
    try {
      // 仅首轮生成一次：以 user 消息数 == 1 判定（触发发生在 user 消息已存、
      // assistant 回复之前）。多轮对话不再重新生成，用户可手动重命名。
      const { userCount, firstUserText } =
        await this.scanUserMessages(conversationId);
      if (userCount !== 1 || !firstUserText) return;

      const title = await this.generate(
        agentType as AgentType,
        firstUserText,
        modelProviderId
      );
      if (!title) return;

      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: { title },
      });
    } catch (err) {
      this.logger.debug(
        `title generation skipped for ${conversationId}: ${String(err)}`
      );
    }
  }

  private async generate(
    agentType: AgentType,
    userText: string,
    modelProviderId?: string | null
  ): Promise<string | null> {
    if (!modelProviderId) return null; // 系统配置无可直连的 key，回退规则标题
    const resolved = await this.modelProviderService.resolveEnabledProvider(
      agentType,
      modelProviderId
    );
    if (!resolved || resolved.source === "system") return null;
    const providerConfig = resolved.providerConfig;

    if (agentType === "claude")
      return this.generateClaude(providerConfig, userText);
    if (agentType === "codex")
      return this.generateOpenAI(providerConfig, userText);
    return null;
  }

  // Anthropic Messages API（认证格式参考 ModelProviderService.test）
  private async generateClaude(
    providerConfig: ProviderConfig,
    userText: string
  ): Promise<string | null> {
    const base = normalizeBaseUrl(providerConfig.baseUrl);
    const apiKey = providerConfig.apiKey;
    const model = providerConfig.models[0];
    if (!base || !apiKey || !model) return null;

    const res = await fetch(anthropicMessagesUrl(base), {
      method: "POST",
      headers: anthropicHeaders(apiKey),
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        // 推理模型默认会先输出 thinking 块，64 token 的预算会被思考过程占满，
        // 导致拿不到 text 块（见 mimo-v2.5 实测）。生成标题不需要思考，直接关闭。
        thinking: { type: "disabled" },
        messages: [{ role: "user", content: buildPrompt(userText) }],
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      content?: Array<{ type?: string; text?: string }>;
    };
    const text = data.content?.find((c) => c.type === "text")?.text ?? "";
    return this.sanitize(text);
  }

  // OpenAI 兼容 Chat Completions API
  private async generateOpenAI(
    providerConfig: ProviderConfig,
    userText: string
  ): Promise<string | null> {
    const base = normalizeBaseUrl(providerConfig.baseUrl);
    const apiKey = providerConfig.apiKey;
    const model = providerConfig.models[0];
    if (!base || !apiKey || !model) return null;

    const res = await fetch(openAIChatCompletionsUrl(base), {
      method: "POST",
      headers: { ...openAIHeaders(apiKey), "content-type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        messages: [{ role: "user", content: buildPrompt(userText) }],
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content ?? "";
    return this.sanitize(text);
  }

  private sanitize(raw: string): string | null {
    const title = raw
      .trim()
      .replace(/^["'「『]+|["'」』]+$/g, "")
      .replace(/\s+/g, " ")
      .slice(0, TITLE_MAX_LEN)
      .trim();
    return title || null;
  }

  // 统计 user 消息数并取首条 user 文本（一次遍历）
  private async scanUserMessages(
    conversationId: string
  ): Promise<{ userCount: number; firstUserText: string }> {
    const messages = await this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: "asc" },
    });
    let userCount = 0;
    let firstUserText = "";
    for (const m of messages) {
      try {
        const content = m.content as {
          role?: string;
          content?: unknown;
        };
        if (content?.role === "user") {
          userCount++;
          if (!firstUserText) firstUserText = extractText(content.content);
        }
      } catch {
        // 跳过无法解析的消息
      }
    }
    return { userCount, firstUserText };
  }
}
