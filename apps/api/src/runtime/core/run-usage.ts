import type { RunUsage } from "@agework/shared/protocol";

/**
 * 从 `RUN_FINISHED.result`（unknown）安全抽取并归一化为 `RunUsage`。
 *
 * 两个 adapter 上报的字段名不同：
 * - Codex：`{ usage: { input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens }, numTurns }`
 * - Claude：`{ usage: { input_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens }, totalCostUsd, numTurns }`
 *
 * 任一非数值字段按 0 处理；整体为 null/非对象/没有任何已知 token 字段时返回 null。
 */
export function normalizeRunUsage(result: unknown): RunUsage | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  const usageRaw = r.usage;
  const usage =
    usageRaw && typeof usageRaw === "object"
      ? (usageRaw as Record<string, unknown>)
      : {};

  const inputTokens = num(usage.input_tokens);
  const outputTokens = num(usage.output_tokens);
  // cached input：codex 用 cached_input_tokens，claude 用 cache_read_input_tokens
  const cachedInputTokens =
    num(usage.cached_input_tokens) || num(usage.cache_read_input_tokens);
  const reasoningOutputTokens = num(usage.reasoning_output_tokens);
  const cacheCreationInputTokens = num(usage.cache_creation_input_tokens);
  const totalCostUsd = nullableNum(r.totalCostUsd);
  const numTurns = num(r.numTurns);
  // adapter 在 RUN_FINISHED.result 顶层上报的纯 API 耗时（ms）。无值时为 null。
  const durationApiMs = nullableNum(r.durationApiMs);

  // 全为 0 且无 cost / 无 turns / 无 API 耗时 —— 视作没有有效 usage，跳过落库。
  if (
    inputTokens === 0 &&
    outputTokens === 0 &&
    cachedInputTokens === 0 &&
    reasoningOutputTokens === 0 &&
    cacheCreationInputTokens === 0 &&
    totalCostUsd === null &&
    numTurns === 0 &&
    durationApiMs === null
  ) {
    return null;
  }

  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    reasoningOutputTokens,
    cacheCreationInputTokens,
    totalCostUsd,
    numTurns,
    durationApiMs,
  };
}

/** 取数值字段：非有限数（含 null/undefined/NaN/string）一律视为 0。 */
function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** 取可空数值：非有限数返回 null（用于 cost 这类「有就有、没有就空」的字段）。 */
function nullableNum(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
