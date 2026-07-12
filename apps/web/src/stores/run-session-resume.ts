import type { ChatModelRunResult } from "@assistant-ui/react";
import type { QueryClient } from "@tanstack/react-query";
import { apiUrl } from "@/lib/http";
import { useAuthStore } from "@/stores/auth-store";
import {
  conversationKeys,
  setConversationRunStatus,
} from "@/lib/conversations-cache";
import {
  runStatusFromSnapshot,
  normalizeResumeSnapshot,
} from "@/stores/run-session-status-rules";

/**
 * RunSession 的 resume 数据流唯一实现。
 *
 * 「刷新页面后续接一个进行中的 run」= 拉取后端 /agent/resume 的 SSE、把每个
 * 累积快照归一化后 yield 给 aui runtime、流结束时回填 conversation.runStatus。
 * 入口是 thread-history-adapter 的薄 aui 接线(本模块不碰 aui)。
 * 问答(interrupt)的续接不走这里——那是携带 resume[] 的新 run,由
 * react-ag-ui 的 submitInterruptResponses 发起。
 *
 * runStatus 回填走 conversations-cache 的唯一写入面:resume 流绕过 agent
 * middleware,RUN_FINISHED 不会自动刷新 conversation 状态,不回填的话缓存会
 * 一直停留在 running,composer/侧边栏持续显示"运行中"。
 */

export type OpenResumeStreamOptions = {
  /** 透传给 fetch;aborted 时跳过 runStatus 回填(由取消方负责状态)。 */
  signal?: AbortSignal;
};

/**
 * 打开一条 resume 快照流。每个元素是归一化后的累积快照(ChatModelRunResult),
 * 中间快照 status 归一成 running 与正常流式 UI 一致,终态快照保持原样。
 * 404(无活跃 run)或非 2xx 直接结束,不产出任何快照、不回填。
 */
export async function* openResumeStream(
  conversationId: string,
  qc: QueryClient,
  options?: OpenResumeStreamOptions,
): AsyncGenerator<ChatModelRunResult, void, unknown> {
  const signal = options?.signal;
  const res = await fetchResume(conversationId, signal);
  if (!res.ok || !res.body) return;

  let lastStatus: { type?: string; reason?: string } | undefined;
  try {
    for await (const result of parseSseSnapshots(res.body)) {
      if (signal?.aborted) return;
      lastStatus = result.status as
        | { type?: string; reason?: string }
        | undefined;
      yield normalizeResumeSnapshot(result);
    }
  } finally {
    // 优先用终态快照推断 runStatus 做乐观更新,再 invalidate 拉权威值兜底。
    if (!signal?.aborted) {
      const inferred = runStatusFromSnapshot(lastStatus);
      if (inferred) {
        setConversationRunStatus(qc, conversationId, inferred);
      }
      qc.invalidateQueries({ queryKey: conversationKeys.all });
    }
  }
}

function fetchResume(
  conversationId: string,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const token = useAuthStore.getState().token;
  return fetch(apiUrl(`/api/v1/agent/resume?id=${conversationId}`), {
    headers: {
      Accept: "text/event-stream",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(signal ? { signal } : {}),
  });
}

/**
 * 解析 SSE 流:按空行分割事件,取 data: 行 JSON 解析为 ChatModelRunResult。
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
