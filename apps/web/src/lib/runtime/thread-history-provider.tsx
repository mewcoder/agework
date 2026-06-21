import type { PropsWithChildren } from "react";

/**
 * thread list adapter 的 unstable_Provider 壳。
 *
 * 历史上此处通过 RuntimeAdapterProvider 注入 ThreadHistoryAdapter，但该注入
 * 依赖 React context 时序：useAgUiRuntime 的 coreRef 在首次渲染时创建并绑定
 * historyAdapter，若此时 runtimeAdapters.history 尚未就绪，core 会缺少 history，
 * __internal_load 的 _loadPromise 守卫又会阻止后续重跑，导致 load 不触发。
 *
 * 现在 history adapter 改由 useAgentChatRuntime 显式传入 useAgUiRuntime（见
 * thread-history-adapter.ts），不再走 context 注入。此 Provider 仅保留为
 * unstable_Provider 要求的组件壳，直接渲染 children。
 */
export function ThreadHistoryProvider({ children }: PropsWithChildren) {
  return children;
}
