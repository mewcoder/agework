import { describe, expect, it, beforeEach, vi } from "vitest";
import type { ProviderConfig } from "@agework/shared/api";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { getLLMClient } from "./llm";

vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: vi.fn() }));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI: vi.fn() }));

const CONFIG: ProviderConfig = {
  baseUrl: "https://api.example.com",
  apiKey: " sk-test ",
  models: [" ", " claude-test "],
  extraConfig: {},
};

describe("getLLMClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createAnthropic).mockReturnValue({
      languageModel: vi.fn().mockReturnValue("anthropic-model"),
    } as never);
    vi.mocked(createOpenAI).mockReturnValue({
      chat: vi.fn().mockReturnValue("openai-model"),
    } as never);
  });

  it("builds an anthropic model for claude, trimming key and picking first non-empty model", () => {
    const built = getLLMClient("claude", CONFIG);

    expect(createAnthropic).toHaveBeenCalledWith({
      authToken: "sk-test",
      baseURL: "https://api.example.com/v1",
    });
    expect(built).toEqual({ model: "anthropic-model" });
  });

  it("builds an openai chat model for non-claude agents", () => {
    const built = getLLMClient("codex", CONFIG);

    expect(createOpenAI).toHaveBeenCalledWith({
      apiKey: "sk-test",
      baseURL: "https://api.example.com/v1",
    });
    expect(built).toEqual({ model: "openai-model" });
  });

  it("returns an error when required config is missing", () => {
    expect(
      getLLMClient("claude", { ...CONFIG, apiKey: "  " })
    ).toEqual({
      error: "未配置 apiKey",
    });
    expect(
      getLLMClient("claude", { ...CONFIG, models: [] })
    ).toEqual({
      error: "未配置 models",
    });
    expect(
      getLLMClient("claude", { ...CONFIG, baseUrl: "" })
    ).toEqual({
      error: "未配置 baseUrl",
    });
    expect(createAnthropic).not.toHaveBeenCalled();
  });
});
