import { describe, it, expect } from "vitest";
import { toRunUsage } from "./utils";
import type { Usage } from "@openai/codex-sdk";

describe("toRunUsage (codex)", () => {
  it("正确映射 Usage 字段，totalCostUsd/durationApiMs/cacheCreationInputTokens 固定为 null/0（codex 无此字段）", () => {
    const usage: Usage = {
      input_tokens: 20,
      cached_input_tokens: 5,
      output_tokens: 8,
      reasoning_output_tokens: 3,
    };

    const result = toRunUsage(usage, 4);

    expect(result).toEqual({
      inputTokens: 20,
      outputTokens: 8,
      cachedInputTokens: 5,
      reasoningOutputTokens: 3,
      cacheCreationInputTokens: 0,
      totalCostUsd: null,
      numTurns: 4,
      durationApiMs: null,
    });
  });
});
