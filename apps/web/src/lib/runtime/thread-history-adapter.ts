import type {
  ThreadHistoryAdapter,
  ChatModelRunResult,
  ThreadMessage,
} from "@assistant-ui/react";
import type { useAui } from "@assistant-ui/react";
import type { useQueryClient } from "@tanstack/react-query";
import { conversationsApi, type Conversation } from "@/api/conversations";
import { apiUrl } from "@/lib/http";
import { useAuthStore } from "@/stores/auth-store";
import { toThreadMessageItem, isThreadMessageItem } from "./thread-message";

type Aui = ReturnType<typeof useAui>;
type QC = ReturnType<typeof useQueryClient>;
type ConversationsCache = { conversations: Conversation[] };

/**
 * 直接更新 conversations 缓存中指定会话的 activeRunStatus（乐观更新）。
 * resume 流绕过了 agent middleware，RUN_FINISHED 时不会自动刷新 conversation 状态，
 * 这里根据终态快照推断 activeRunStatus 并写入缓存，避免 UI 卡在"运行中"。
 */
function setConversationRunStatusInCache(
  qc: QC,
  conversationId: string,
  activeRunStatus: Conversation["activeRunStatus"],
) {
  for (const [queryKey, old] of qc.getQueriesData<ConversationsCache>({
    queryKey: ["conversations"],
  })) {
    if (queryKey[1] === "archived") continue;
    if (!old) continue;
    qc.setQueryData<ConversationsCache>(queryKey, {
      ...old,
      conversations: old.conversations.map((c) =>
        c.conversationId === conversationId
          ? { ...c, activeRunStatus }
          : c,
      ),
    });
  }
}

/**
 * 从终态快照 status 推断 conversation.activeRunStatus。
 *  - complete → idle
 *  - incomplete/cancelled → idle（用户取消，后端也设 idle）
 *  - incomplete/error → error
 *  - 其它（如 incomplete/streaming，理论上不应作为终态）→ undefined，由 invalidate 兜底
 */
function activeRunStatusFromSnapshot(
  status: { type?: string; reason?: string } | undefined,
): Conversation["activeRunStatus"] | undefined {
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
 * 创建 ThreadHistoryAdapter：负责 thread 消息加载 + 进行中 run 的续接。
 *
 * 显式由 useAgentChatRuntime 传入 useAgUiRuntime（而非走 RuntimeAdapterProvider 注入），
 * 确保 useAgUiRuntime 的 coreRef 首次创建时就绑定 history，__internal_load 能正确触发 load。
 */
export function createThreadHistoryAdapter(
  aui: Aui,
  qc: QC,
): ThreadHistoryAdapter {
  return {
    async load() {
      const { remoteId } = aui.threadListItem().getState();
      if (!remoteId) return { messages: [] };
      const raw = await conversationsApi.listMessages(remoteId);

      // 判断是否有进行中的 run：优先用 thread list 透传的 activeRunStatus，
      // 缺失时回退到 conversationsApi.get 拿权威状态。
      const custom = aui.threadListItem().getState().custom as
        | { activeRunStatus?: string; pendingUserAction?: string }
        | undefined;
      let activeRunStatus = custom?.activeRunStatus;
      let pendingUserAction = custom?.pendingUserAction;
      if (!activeRunStatus) {
        const conv = await conversationsApi.get(remoteId);
        activeRunStatus = conv.activeRunStatus;
        pendingUserAction = conv.pendingUserAction ?? undefined;
      }

      // requires_action 的 run：后端 conversation.activeRunStatus 仍是 "running"，
      // 但 pendingUserAction="question"。这种情况后端 resume 会返回 409 不续接
      // stream，所以不触发 resume，也不应过滤进行中的 assistant 消息——否则
      // 刷新后 AskUserQuestion 等内容会从正文消失。把进行中消息的 status
      // 归一化成 running，让 PendingQuestionPanel 能接管交互（和 resume 流的
      // normalizeResumeSnapshot 逻辑一致）。
      const isPendingQuestion = pendingUserAction === "question";
      const isRunning = activeRunStatus === "running" && !isPendingQuestion;

      let items = raw.map(toThreadMessageItem).filter(isThreadMessageItem);

      if (isPendingQuestion) {
        items = items.map((item) => {
          if (item.message.role !== "assistant") return item;
          const status = (item.message as { status?: { type?: string } })
            .status;
          if (!status) return item;
          // 把 requires-action / incomplete-streaming 等非终态归一化成 running，
          // 让 AskUserQuestion part.status 继承 running，PendingQuestionPanel
          // 能识别并接管交互。终态（complete/cancelled/error）保持原样。
          if (
            status.type === "running" ||
            status.type === "complete"
          )
            return item;
          return {
            ...item,
            message: {
              ...item.message,
              status: { type: "running" },
            } as ThreadMessage,
          };
        });
      }

      // running 时过滤掉「进行中」的 assistant 消息（status 非 complete），
      // 由 resume 快照接管，避免与 resume 初始快照内容重复。
      const messages = isRunning
        ? items.filter(
            (item) =>
              !(
                item.message.role === "assistant" &&
                (item.message as { status?: { type?: string } }).status?.type !==
                  "complete"
              ),
          )
        : items;

      return {
        messages,
        ...(isRunning ? { unstable_resume: true } : {}),
      };
    },

    // 消息由后端 SSE run 存库，这里保持 no-op
    async append() {},

    // 刷新网页后续接进行中的 run：拉取后端 resume SSE，把每个累积快照
    // 作为 ChatModelRunResult yield，AG-UI runtime 的 consumeResumeStream
    // 会把它应用到 assistant message，实现刷新后实时续接。
    async *resume(options): AsyncGenerator<ChatModelRunResult, void, unknown> {
      const { remoteId } = aui.threadListItem().getState();
      if (!remoteId) return;

      const token = useAuthStore.getState().token;
      const res = await fetch(
        apiUrl(`/api/v1/agent/run/resume?id=${remoteId}`),
        {
          headers: {
            Accept: "text/event-stream",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          signal: options.abortSignal,
        },
      );

      // 409 = run 处于 requires_action（首版不续接）/ 404 = 无活跃 run：
      // 直接结束，前端走已加载的历史 + 正常状态显示。
      if (!res.ok || !res.body) return;

      let lastStatus: { type?: string; reason?: string } | undefined;
      try {
        for await (const result of parseSseSnapshots(res.body)) {
          if (options.abortSignal.aborted) return;
          lastStatus = result.status as
            | { type?: string; reason?: string }
            | undefined;
          // 后端中间快照 status 是 { type:"incomplete", reason:"streaming" }，
          // 但 assistant-ui 的 toMessagePartStatus 会把它直接赋给「无 result 的
          // tool-call part」作为 part.status —— incomplete 会被 ToolFallback
          // 当成错误（红色 XCircle）。而正常流式运行期间 message.status 是
          // { type:"running" }，part 继承后显示运行中 Loader。
          // 把中间快照归一化成 running，让 resume 与正常流式 UI 完全一致；
          // 终态快照（complete / cancelled / error / user_steered）保持原样。
          yield normalizeResumeSnapshot(result);
        }
      } finally {
        // resume 流绕过了 agent middleware（RUN_FINISHED 时 middleware 会刷新
        // conversation.activeRunStatus），这里必须手动补上，否则 conversations
        // 缓存会一直停留在 running，composer/侧边栏持续显示"运行中"，直到刷新页面。
        // 优先用终态快照推断 activeRunStatus 做乐观更新，再 invalidate 拉权威值兜底。
        if (!options.abortSignal.aborted) {
          const inferred = activeRunStatusFromSnapshot(lastStatus);
          if (inferred) {
            setConversationRunStatusInCache(qc, remoteId, inferred);
          }
          qc.invalidateQueries({ queryKey: ["conversations"] });
        }
      }
    },
  };
}

function normalizeResumeSnapshot(
  result: ChatModelRunResult,
): ChatModelRunResult {
  const status = result.status as { type?: string; reason?: string } | undefined;
  if (
    status?.type === "incomplete" &&
    status?.reason === "streaming"
  ) {
    return { ...result, status: { type: "running" } };
  }
  return result;
}

export { normalizeResumeSnapshot };

/**
 * 解析 SSE 流：按空行分割事件，取 data: 行 JSON 解析为 ChatModelRunResult。
 * 后端 resume 端点每条 data 即一个累积快照 { content, status, metadata? }。
 */
export async function* parseSseSnapshots(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ChatModelRunResult, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLine = rawEvent
          .split("\n")
          .find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        const json = dataLine.slice(5).trim();
        if (!json) continue;
        try {
          yield JSON.parse(json) as ChatModelRunResult;
        } catch {
          // 跳过无法解析的帧
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
