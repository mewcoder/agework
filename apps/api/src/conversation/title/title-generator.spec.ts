import { describe, expect, it, beforeEach, vi } from "vitest";
import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { TitleGenerator } from "./title-generator";

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

function createService(
  options: {
    resolvedProvider?: unknown;
  } = {}
) {
  const modelProviderService = {
    resolveEnabledProvider: vi
      .fn()
      .mockResolvedValue(options.resolvedProvider ?? CUSTOM_PROVIDER),
  };

  return {
    modelProviderService,
    service: new TitleGenerator(modelProviderService as never),
  };
}

describe("TitleGenerator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(generateText).mockResolvedValue({
      text: "「简洁标题」",
    } as never);
    vi.mocked(createAnthropic).mockReturnValue({
      languageModel: vi.fn().mockReturnValue("anthropic-title-model"),
    } as never);
    vi.mocked(createOpenAI).mockReturnValue({
      chat: vi.fn().mockReturnValue("openai-title-model"),
    } as never);
  });

  it("generates a normalized title from user text", async () => {
    const { service, modelProviderService } = createService();

    const title = await service.generateLLMTitle({
      agentType: "claude",
      modelProviderId: "mp-1",
      userText: "帮我重构参数校验",
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
        prompt: expect.stringContaining("帮我重构参数校验") as string,
        maxOutputTokens: 64,
        temperature: 0,
      })
    );
    expect(title).toBe("简洁标题");
  });

  it("skips title generation for empty user text", async () => {
    const { service, modelProviderService } = createService();

    const title = await service.generateLLMTitle({
      agentType: "claude",
      modelProviderId: "mp-1",
      userText: "   ",
    });

    expect(modelProviderService.resolveEnabledProvider).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
    expect(title).toBeNull();
  });

  it("keeps the fallback title for system providers", async () => {
    const { service } = createService({
      resolvedProvider: { source: "system" },
    });

    const title = await service.generateLLMTitle({
      agentType: "claude",
      modelProviderId: "system:claude",
      userText: "hello",
    });

    expect(generateText).not.toHaveBeenCalled();
    expect(title).toBeNull();
  });
});

describe("generateDefaultTitle", () => {
  it("collapses whitespace and keeps short text as-is", () => {
    expect(TitleGenerator.generateDefaultTitle("  帮我  重构\n参数校验 ")).toBe(
      "帮我 重构 参数校验"
    );
  });

  it("truncates to 40 chars and strips trailing punctuation left by the cut", () => {
    const text = "请帮我重构这个超长的会话标题文本，".repeat(5);
    const title = TitleGenerator.generateDefaultTitle(text);
    expect(title).not.toBeNull();
    expect(title!.length).toBeLessThanOrEqual(40);
    expect(title!).not.toMatch(/[，。、；！？,.;!?\s]$/u);
  });

  it("returns null for empty or whitespace-only text", () => {
    expect(TitleGenerator.generateDefaultTitle("")).toBeNull();
    expect(TitleGenerator.generateDefaultTitle("   \n  ")).toBeNull();
  });
});
