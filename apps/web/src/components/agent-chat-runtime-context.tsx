import {
  useEffect,
  useMemo,
  useRef,
  type RefObject,
  type ReactNode,
} from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  type AssistantRuntime,
  useRemoteThreadListRuntime,
} from "@assistant-ui/react";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { type AgentType } from "@/stores/selection-store";
import { useSelectionStore } from "@/stores/selection-store";
import { useRuntimeUiStore } from "@/stores/runtime-ui-store";
import { createThreadListAdapter } from "@/lib/runtime/thread-list-adapter";
import { useAgentChatRuntime, findCachedConversation } from "@/hooks/use-agent-chat-runtime";
import { AgentChatContext } from "./agent-chat-context";
import { AgentChatRuntimeContext } from "./agent-chat-runtime-context-value";

type NavigateRef = RefObject<ReturnType<typeof useNavigate>>;

// 新会话经 initialize 拿到 remoteId（即 conversationId）后，把 URL 从 / 更新到 /c/$conversationId
function useSyncNewConversationUrl(
  runtime: AssistantRuntime,
  routeConversationId: string | undefined,
  pathname: string,
  navigateRef: NavigateRef,
) {
  useEffect(() => {
    const tl = runtime.threads;
    const sync = () => {
      const mainThread = tl.mainItem.getState();
      const remoteId = mainThread.remoteId;
      if (!remoteId) return;
      if (routeConversationId === remoteId) return;
      if (pathname !== "/") return;
      if (mainThread.id === remoteId) return;
      navigateRef.current({
        to: "/c/$conversationId",
        params: { conversationId: remoteId },
      });
    };
    const unsub = tl.subscribe(sync);
    sync();
    return unsub;
  }, [pathname, runtime, routeConversationId, navigateRef]);
}

// URL 的 conversationId 同步到 chat-store，供 composer / sidebar / ask-user-question 读取
function useSyncSelectedConversationFromUrl(routeConversationId: string | undefined, qc: QueryClient) {
  useEffect(() => {
    const selStore = useSelectionStore.getState();
    if (routeConversationId) {
      const c = findCachedConversation(qc, routeConversationId);
      const agentType =
        c?.agentType === "claude" || c?.agentType === "codex"
          ? c.agentType
          : undefined;
      selStore.selectConversation(routeConversationId, agentType, c?.workspaceId);
      useRuntimeUiStore.getState().clearRunStatusForConversation(routeConversationId);
    } else if (selStore.selectedConversationId !== undefined) {
      // 新会话：清空 selectedConversationId，保留已选 workspace
      useSelectionStore.setState({ selectedConversationId: undefined });
    }
  }, [routeConversationId, qc]);
}

export function AgentChatRuntimeProvider({ children }: { children: ReactNode }) {
  // 用 router location 读 conversationId（而非 useParams）：AgentChatRuntimeProvider 挂在
  // pathless layout 路由上，跨 / ↔ /c/$conversationId 不 remount，后台会话得以保活。
  const routeConversationId = useRouterState({
    select: (s) => s.location.pathname.match(/\/c\/([^/]+)/)?.[1],
  });
  const pathname = useRouterState({
    select: (s) => s.location.pathname,
  });
  const qc = useQueryClient();
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  useEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);

  const routeConversationIdRef = useRef(routeConversationId);
  useEffect(() => {
    routeConversationIdRef.current = routeConversationId;
  }, [routeConversationId]);

  // archive 回调：当 assistant-ui 内部归档当前正在查看的 conversation 时，导航回新会话
  // 回调本身只在 archive 事件触发时异步执行，不在渲染期间读取 ref，故手动关闭该规则。
  const adapter = useMemo(
    () =>
      // eslint-disable-next-line react-hooks/refs -- 回调延迟触发，不在渲染期间读 ref
      createThreadListAdapter((conversationId) => {
        if (conversationId !== routeConversationIdRef.current) return;
        const workspaceId = findCachedConversation(qc, conversationId)?.workspaceId;
        useSelectionStore.getState().startNewConversation(workspaceId);
        navigateRef.current({ to: "/" });
      }),
    [qc],
  );

  const runtime = useRemoteThreadListRuntime({
    runtimeHook: useAgentChatRuntime,
    adapter,
    threadId: routeConversationId,
  });

  useSyncNewConversationUrl(runtime, routeConversationId, pathname, navigateRef);
  useSyncSelectedConversationFromUrl(routeConversationId, qc);

  const conversationContextValue = useMemo(
    () => ({
      onSelectConversation: (conversationId: string) => {
        navigateRef.current({
          to: "/c/$conversationId",
          params: { conversationId },
        });
      },
      onNewConversation: (workspaceId?: string, agent?: AgentType) => {
        useSelectionStore.getState().startNewConversation(workspaceId, agent);
        (async () => {
          await runtime.threads.switchToNewThread().catch((e) => console.error("[AgentChatRuntimeProvider] switchToNewThread failed:", e));
          await navigateRef.current({ to: "/" });
        })();
      },
      onSelectWorkspace: (workspaceId: string) => {
        useSelectionStore.getState().selectWorkspace(workspaceId);
        navigateRef.current({ to: "/" });
      },
      onClearWorkspace: () => {
        useSelectionStore.getState().clearSelectedWorkspace();
      },
    }),
    [runtime],
  );

  return (
    <AgentChatContext.Provider value={conversationContextValue}>
      <AgentChatRuntimeContext.Provider value={runtime}>
        {children}
      </AgentChatRuntimeContext.Provider>
    </AgentChatContext.Provider>
  );
}
