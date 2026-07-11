import type { ChatModelRunResult } from "@assistant-ui/react";
import type { Conversation } from "@/api/conversations";

/**
 * RunSession 的「运行快照 → 状态」解释规则（纯函数，无 aui runtime 依赖）。
 *
 * 后端 resume/冷加载返回的快照 status 有自己的一套取值，前端要据此推断两样东西：
 * 会话级 runStatus（写回 conversations 缓存），以及流式期间的消息级展示状态。
 * 这套规则原先散在 thread-history-adapter 里、又被 thread.tsx 反向 import，
 * 现在统一收在 RunSession 模块中，两个 resume 路径都从这里取。
 */

/**
 * 从终态快照 status 推断 conversation.runStatus。
 *  - complete → idle
 *  - incomplete/cancelled → idle（用户取消，后端也设 idle）
 *  - incomplete/error → error
 *  - 其它（如 incomplete/streaming，理论上不应作为终态）→ undefined，由 invalidate 兜底
 */
export function runStatusFromSnapshot(
  status: { type?: string; reason?: string } | undefined,
): Conversation["runStatus"] | undefined {
  if (!status) return undefined;
  if (status.type === "complete") return "idle";
  if (status.type === "incomplete") {
    if (status.reason === "error") return "error";
    if (status.reason === "cancelled" || status.reason === "user_steered")
      return "idle";
    // streaming 等非终态，不应出现在流结束时；交给 invalidate 兜底
    return undefined;
  }
  if (status.type === "requires-action") return "idle";
  return undefined;
}

/**
 * 把 resume 中间快照的 status 归一化成 running。
 * 后端中间快照 status 是 { type:"incomplete", reason:"streaming" }，但 assistant-ui 的
 * toMessagePartStatus 会把它直接赋给「无 result 的 tool-call part」作为 part.status——
 * incomplete 会被 ToolFallback 当成错误（红色 XCircle）。而正常流式运行期间 message.status
 * 是 { type:"running" }，part 继承后显示运行中 Loader。把中间快照归一化成 running，让 resume
 * 与正常流式 UI 完全一致；终态快照（complete / cancelled / error / user_steered）保持原样。
 */
export function normalizeResumeSnapshot(
  result: ChatModelRunResult,
): ChatModelRunResult {
  const status = result.status as { type?: string; reason?: string } | undefined;
  if (status?.type === "incomplete" && status?.reason === "streaming") {
    return { ...result, status: { type: "running" } };
  }
  return result;
}
