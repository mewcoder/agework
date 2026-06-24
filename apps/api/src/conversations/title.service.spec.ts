import { describe, expect, it, beforeEach, vi } from "vitest";
import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { TitleService } from "./title.service";

vi.mock("ai", () => ({
  generateText: vi.fn(),
}));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: vi.fn(),
}));

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: vi.fn(),
}));

const CUSTOM_PROVIDER = {
  source: "custom",
  providerConfig: {
    baseUrl: "https://api.example.com",
    apiKey: " sk-test ",
    models: [" claude-test "],
    extraConfig: {},
  },
} as const;

function createService(options: {
  messages?: Array<{ content: unknown }>;
  resolvedProvider?: unknown;
} = {}) {
  const prisma = {
    message: {
      findMany: vi.fn().mockResolvedValue(options.messages ?? []),
    },
    conversation: {
      update: vi.fn().mockResolvedValue({}),
    },
  };
  const modelProviderService = {
    resolveEnabledProvider: vi
      .fn()
      .mockResolvedValue(options.resolvedProvider ?? CUSTOM_PROVIDER),
  };

  return {
    prisma,
    modelProviderService,
    service: new TitleService(prisma as never, modelProviderService as never),
  };
}

describe("TitleService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(generateText).mockResolvedValue({ text: "「简洁标题」" } as never);
    vi.mocked(createAnthropic).mockReturnValue({
      languageModel: vi.fn().mockReturnValue("anthropic-title-model"),
    } as never);
    vi.mocked(createOpenAI).mockReturnValue({
      chat: vi.fn().mockReturnValue("openai-title-model"),
    } as never);
  });

  it("generates and saves a title for the first user message", async () => {
    const { service, prisma, modelProviderService } = createService({
      messages: [
        {
          content: {
            role: "user",
            content: [{ type: "text", text: "帮我重构参数校验" }],
          },
        },
      ],
    });

    await service.generateIfNeeded({
      conversationId: "conversation-1",
      agentType: "claude",
      modelProviderId: "mp-1",
    });

    expect(modelProviderService.resolveEnabledProvider).toHaveBeenCalledWith(
      "claude",
      "mp-1"
    );
    expect(createAnthropic).toHaveBeenCalledWith({
      authToken: "sk-test",
      baseURL: "https://api.example.com/v1",
    });
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "anthropic-title-model",
        prompt: expect.stringContaining("帮我重构参数校验"),
        maxOutputTokens: 64,
        temperature: 0,
      })
    );
    expect(prisma.conversation.update).toHaveBeenCalledWith({
      where: { id: "conversation-1" },
      data: { title: "简洁标题" },
    });
  });

  it("skips title generation after the first user message", async () => {
    const { service, prisma, modelProviderService } = createService({
      messages: [
        { content: { role: "user", content: "first" } },
        { content: { role: "assistant", content: "reply" } },
        { content: { role: "user", content: "second" } },
      ],
    });

    await service.generateIfNeeded({
      conversationId: "conversation-1",
      agentType: "claude",
      modelProviderId: "mp-1",
    });

    expect(modelProviderService.resolveEnabledProvider).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
    expect(prisma.conversation.update).not.toHaveBeenCalled();
  });

  it("keeps the fallback title for system providers", async () => {
    const { service, prisma } = createService({
      resolvedProvider: { source: "system" },
      messages: [{ content: { role: "user", content: "hello" } }],
    });

    await service.generateIfNeeded({
      conversationId: "conversation-1",
      agentType: "claude",
      modelProviderId: "system:claude",
    });

    expect(generateText).not.toHaveBeenCalled();
    expect(prisma.conversation.update).not.toHaveBeenCalled();
  });
});
