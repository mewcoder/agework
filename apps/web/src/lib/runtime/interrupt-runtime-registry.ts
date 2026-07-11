import type { AgUiAssistantRuntime } from "@assistant-ui/react-ag-ui";

/**
 * aui 接线层:按 conversationId 找到所属的 AgUiAssistantRuntime。
 *
 * 问答 UI 提交答案要调 per-thread runtime 的 unstable_submitInterruptResponses,
 * 但 useRemoteThreadListRuntime 会把 runtimeHook 返回的 runtime 包一层,
 * unstable_* 扩展方法无法经 aui context 拿到。这里由 useAgentChatRuntime
 * (每个 alive conversation 各一份)注册自己的 runtime,组件按当前
 * conversationId 查找。remoteId 在会话 initialize 后才有,所以存取值函数、
 * 查找时惰性求值。
 */
type InterruptRuntimeEntry = {
  getConversationId: () => string | undefined;
  runtime: AgUiAssistantRuntime;
};

const entries = new Set<InterruptRuntimeEntry>();

export function registerInterruptRuntime(
  entry: InterruptRuntimeEntry,
): () => void {
  entries.add(entry);
  return () => {
    entries.delete(entry);
  };
}

export function getInterruptRuntime(
  conversationId: string,
): AgUiAssistantRuntime | undefined {
  for (const entry of entries) {
    if (entry.getConversationId() === conversationId) return entry.runtime;
  }
  return undefined;
}
