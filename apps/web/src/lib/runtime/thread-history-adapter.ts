import type {
  ThreadHistoryAdapter,
  ChatModelRunResult,
} from "@assistant-ui/react";
import type { useAui } from "@assistant-ui/react";
import type { useQueryClient } from "@tanstack/react-query";
import { conversationsApi } from "@/api/conversations";
import { openResumeStream } from "@/stores/run-session-resume";
import { toThreadMessageItem, isThreadMessageItem } from "./thread-message";

type Aui = ReturnType<typeof useAui>;
type QC = ReturnType<typeof useQueryClient>;

/**
 * 创建 ThreadHistoryAdapter：负责 thread 消息加载 + 进行中 run 的续接。
 *
 * 显式由 useAgentChatRuntime 传入 useAgUiRuntime（而非走 RuntimeAdapterProvider 注入），
 * 确保 useAgUiRuntime 的 coreRef 首次创建时就绑定 history，__internal_load 能正确触发 load。
 * resume 的数据流（SSE 拉取、快照归一化、runStatus 回填）统一在 RunSession 的
 * openResumeStream 里，这里只做 aui 接线。
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

      // 判断是否有进行中的 run：优先用 thread list 透传的 runStatus，
      // 缺失时回退到 conversationsApi.get 拿权威状态。
      const custom = aui.threadListItem().getState().custom as
        | { runStatus?: string; pendingUserAction?: string }
        | undefined;
      let runStatus = custom?.runStatus;
      let pendingUserAction = custom?.pendingUserAction;
      if (!runStatus) {
        const conv = await conversationsApi.get(remoteId);
        runStatus = conv.runStatus;
        pendingUserAction = conv.pendingUserAction ?? undefined;
      }

      // 问答挂起（pendingUserAction="question"）的 run：terminal model 下问题
      // 消息以 requires-action/interrupt 状态 + interrupts metadata 持久化，
      // 原样加载即可（PendingQuestionPanel 按 requires-action 判定待答，
      // 回答走 interrupt resume）。没有活跃的 AG-UI run，不触发 resume。
      const isPendingQuestion = pendingUserAction === "question";
      const isRunning = runStatus === "running" && !isPendingQuestion;

      const items = raw.map(toThreadMessageItem).filter(isThreadMessageItem);

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

    // 刷新网页后续接进行中的 run：数据流交给 RunSession，快照由 AG-UI runtime
    // 的 consumeResumeStream 应用到 assistant message，实现刷新后实时续接。
    async *resume(options): AsyncGenerator<ChatModelRunResult, void, unknown> {
      const { remoteId } = aui.threadListItem().getState();
      if (!remoteId) return;
      yield* openResumeStream(remoteId, qc, { signal: options.abortSignal });
    },
  };
}
