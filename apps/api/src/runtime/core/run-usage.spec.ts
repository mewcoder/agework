import { describe, it, expect } from "vitest";
import { normalizeRunUsage } from "./run-usage";

describe("normalizeRunUsage", () => {
  it("normalizes codex result shape", () => {
    const result = {
      isError: false,
      numTurns: 3,
      usage: {
        input_tokens: 1000,
        cached_input_tokens: 200,
        output_tokens: 500,
        reasoning_output_tokens: 80,
      },
    };

    expect(normalizeRunUsage(result)).toEqual({
      inputTokens: 1000,
      outputTokens: 500,
      cachedInputTokens: 200,
      reasoningOutputTokens: 80,
      cacheCreationInputTokens: 0,
      totalCostUsd: null,
      numTurns: 3,
      durationApiMs: null,
    });
  });

  it("normalizes claude result shape (cache_read + totalCostUsd)", () => {
    const result = {
      isError: false,
      numTurns: 2,
      totalCostUsd: 0.0342,
      usage: {
        input_tokens: 12000,
        cache_read_input_tokens: 8000,
        cache_creation_input_tokens: 1500,
        output_tokens: 6789,
      },
    };

    expect(normalizeRunUsage(result)).toEqual({
      inputTokens: 12000,
      outputTokens: 6789,
      cachedInputTokens: 8000,
      reasoningOutputTokens: 0,
      cacheCreationInputTokens: 1500,
      totalCostUsd: 0.0342,
      numTurns: 2,
      durationApiMs: null,
    });
  });

  it("returns null for empty/missing result", () => {
    expect(normalizeRunUsage(null)).toBeNull();
    expect(normalizeRunUsage(undefined)).toBeNull();
    expect(normalizeRunUsage("string")).toBeNull();
    expect(normalizeRunUsage(42)).toBeNull();
  });

  it("returns null when result has no usable token fields", () => {
    expect(normalizeRunUsage({})).toBeNull();
    expect(normalizeRunUsage({ isError: false })).toBeNull();
    expect(normalizeRunUsage({ usage: {} })).toBeNull();
    // 全 0 / 非数值也视为无 usage
    expect(
      normalizeRunUsage({
        usage: {
          input_tokens: "oops",
          output_tokens: null,
        },
      })
    ).toBeNull();
  });

  it("treats non-numeric token fields as 0 but keeps run valid via numTurns", () => {
    const result = {
      numTurns: 1,
      usage: {
        input_tokens: "bad",
        output_tokens: null,
      },
    };

    expect(normalizeRunUsage(result)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      cacheCreationInputTokens: 0,
      totalCostUsd: null,
      numTurns: 1,
      durationApiMs: null,
    });
  });

  it("survives missing usage object entirely but still records numTurns", () => {
    expect(normalizeRunUsage({ numTurns: 5 })).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
      cacheCreationInputTokens: 0,
      totalCostUsd: null,
      numTurns: 5,
      durationApiMs: null,
    });
  });
});
