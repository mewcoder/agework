import { useEffect } from "react";
import type { useAui, ChatModelRunResult } from "@assistant-ui/react";
import { useQueryClient } from "@tanstack/react-query";
import { useSelectionStore } from "@/stores/selection-store";
import { useRunSessionStore } from "@/stores/run-session-store";
import { openResumeStream } from "@/stores/run-session-resume";
import {
  dropStalePendingQuestionMessage,
  needsManualResumeReconnect,
  toExportedMessageRepository,
  type ExportedMessageRepositoryLike,
} from "./pending-question-resume";

type Aui = ReturnType<typeof useAui>;

/**
 * 刷新后在 requires_action 状态下回答了 pending question 时，前端没有 SSE 连接，
 * worker 继续执行的事件收不到。检测到 RunSession 的已回答标记后，直接在当前
 * runtime 上调用 resumeRun，建立新的 resume SSE 连接把后续事件接上，不 reload 页面。
 *
 * 这是 resume 的 aui 接线层：数据流（fetch/重试/快照归一/runStatus 回填）在
 * RunSession 的 openResumeStream 里。后端可能还没处理完 reply（resume 返回 409），
 * openResumeStream 以 retryOn409 退避重试兜住这个窗口。
 */
export function useResumeAfterQuestionReply(aui: Aui): void {
  const qc = useQueryClient();
  const selectedConversationId = useSelectionStore(
    (s) => s.selectedConversationId,
  );
  const pendingQuestionReplied = useRunSessionStore((s) =>
    selectedConversationId
      ? s.pendingQuestionRepliedConversations.has(selectedConversationId)
      : false,
  );

  useEffect(() => {
    if (!pendingQuestionReplied || !selectedConversationId) return;
    // 注意：不提前 consume，等 resumeRun 真正发起后再 consume，
    // 避免 resumeRun 失败时标记丢失、后续无法重试。

    // 没刷新页面时，原始 /agent/run 的 SSE 连接仍然存活，worker resolve 后的
    // 续接事件会通过它正常到达——不需要、也不能再手动 resumeRun，否则会和正在
    // 进行的原始 run 同时各建一条助手消息，出现两个"正在处理"。
    if (!needsManualResumeReconnect(aui.thread().getState().isRunning)) {
      useRunSessionStore
        .getState()
        .consumePendingQuestionReplied(selectedConversationId);
      return;
    }

    const threadRuntime = (
      aui as unknown as {
        thread: () => {
          __internal_getRuntime?: () => {
            resumeRun?: (config: {
              parentId: string | null;
              stream?: (
                options: unknown,
              ) => AsyncGenerator<ChatModelRunResult, void, unknown>;
            }) => void;
            import?: (
              data: ExportedMessageRepositoryLike<unknown>,
            ) => void;
          };
        };
      }
    )
      .thread()
      .__internal_getRuntime?.();

    if (!threadRuntime?.resumeRun) {
      console.warn(
        "[useResumeAfterQuestionReply] resumeRun not available, falling back to reload",
      );
      useRunSessionStore
        .getState()
        .consumePendingQuestionReplied(selectedConversationId);
      window.location.reload();
      return;
    }

    // 旧的 pending-question 消息还停在 status=running——resumeRun 会无条件
    // 新建一条占位 assistant 消息，两者都 running 会变成重复的"正在处理"，
    // 且旧消息永远不会再更新。续接前先把它从消息列表里去掉。
    const { messages: liveMessages, removed } =
      dropStalePendingQuestionMessage(aui.thread().getState().messages);
    if (removed) {
      threadRuntime.import?.(toExportedMessageRepository(liveMessages));
    }
    const parentId = liveMessages.at(-1)?.id ?? null;

    try {
      threadRuntime.resumeRun({
        parentId,
        stream: () =>
          openResumeStream(selectedConversationId, qc, { retryOn409: true }),
      });
      // resumeRun 已成功发起，消费标记
      useRunSessionStore
        .getState()
        .consumePendingQuestionReplied(selectedConversationId);
    } catch (err) {
      console.error("[useResumeAfterQuestionReply] resumeRun failed:", err);
      useRunSessionStore
        .getState()
        .consumePendingQuestionReplied(selectedConversationId);
    }
  }, [pendingQuestionReplied, selectedConversationId, aui, qc]);
}
