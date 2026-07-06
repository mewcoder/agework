import { describe, it, expect } from "vitest";
import { toRunUsage } from "./utils";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

function successResult(): SDKResultMessage {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 1000,
    duration_api_ms: 800,
    is_error: false,
    num_turns: 2,
    result: "done",
    stop_reason: null,
    total_cost_usd: 0.05,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 2,
    },
  } as unknown as SDKResultMessage;
}

describe("toRunUsage (claude)", () => {
  it("正确映射 SDKResultMessage 字段，reasoningOutputTokens 固定为 0（claude 无此字段）", () => {
    const usage = toRunUsage(successResult());

    expect(usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 3,
      cacheCreationInputTokens: 2,
      reasoningOutputTokens: 0,
      totalCostUsd: 0.05,
      numTurns: 2,
      durationApiMs: 800,
    });
  });

  it("对 error 变体（无 result/structured_output 字段）同样能取到 usage 相关字段", () => {
    const errorResult = {
      type: "result",
      subtype: "error_during_execution",
      duration_ms: 500,
      duration_api_ms: 400,
      is_error: true,
      num_turns: 1,
      stop_reason: null,
      total_cost_usd: 0.01,
      usage: {
        input_tokens: 4,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    } as unknown as SDKResultMessage;

    const usage = toRunUsage(errorResult);

    expect(usage.inputTokens).toBe(4);
    expect(usage.totalCostUsd).toBe(0.01);
    expect(usage.numTurns).toBe(1);
  });
});
