import {
  getApiKey,
  normalizeBaseUrl,
  anthropicMessagesUrl,
  anthropicHeaders,
  openAIChatCompletionsUrl,
  openAIModelsUrl,
  openAIHeaders,
} from "./llm-client";

describe("getApiKey", () => {
  it("returns providerConfig.apiKey", () => {
    expect(
      getApiKey({ baseUrl: "https://x", apiKey: "sk-test", models: ["m"], extraConfig: {} })
    ).toBe("sk-test");
  });
});

describe("normalizeBaseUrl", () => {
  it("strips a trailing slash", () => {
    expect(normalizeBaseUrl("https://api.example.com/")).toBe(
      "https://api.example.com"
    );
  });

  it("leaves a url without trailing slash unchanged", () => {
    expect(normalizeBaseUrl("https://api.example.com")).toBe(
      "https://api.example.com"
    );
  });

  it("returns undefined for undefined input", () => {
    expect(normalizeBaseUrl(undefined)).toBeUndefined();
  });
});

describe("anthropicMessagesUrl", () => {
  it("appends /v1/messages to the base url", () => {
    expect(anthropicMessagesUrl("https://api.anthropic.com")).toBe(
      "https://api.anthropic.com/v1/messages"
    );
  });
});

describe("anthropicHeaders", () => {
  it("builds Authorization, anthropic-version and content-type headers", () => {
    expect(anthropicHeaders("sk-claude")).toEqual({
      Authorization: "Bearer sk-claude",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    });
  });
});

describe("openAIChatCompletionsUrl", () => {
  it("appends /chat/completions when base url already ends with /v1", () => {
    expect(openAIChatCompletionsUrl("https://api.openai.com/v1")).toBe(
      "https://api.openai.com/v1/chat/completions"
    );
  });

  it("appends /v1/chat/completions when base url has no /v1 suffix", () => {
    expect(openAIChatCompletionsUrl("https://api.openai.com")).toBe(
      "https://api.openai.com/v1/chat/completions"
    );
  });
});

describe("openAIModelsUrl", () => {
  it("appends /models when base url already ends with /v1", () => {
    expect(openAIModelsUrl("https://api.openai.com/v1")).toBe(
      "https://api.openai.com/v1/models"
    );
  });

  it("appends /v1/models when base url has no /v1 suffix", () => {
    expect(openAIModelsUrl("https://api.openai.com")).toBe(
      "https://api.openai.com/v1/models"
    );
  });
});

describe("openAIHeaders", () => {
  it("builds an Authorization header", () => {
    expect(openAIHeaders("sk-codex")).toEqual({
      Authorization: "Bearer sk-codex",
    });
  });
});
