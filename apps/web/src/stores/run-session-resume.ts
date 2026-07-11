import type { ChatModelRunResult } from "@assistant-ui/react";
import type { QueryClient } from "@tanstack/react-query";
import { apiUrl } from "@/lib/http";
import { useAuthStore } from "@/stores/auth-store";
import { setConversationRunStatus } from "@/lib/conversations-cache";
import {
  runStatusFromSnapshot,
  normalizeResumeSnapshot,
} from "@/stores/run-session-status-rules";

/**
 * RunSession 的 resume 数据流唯一实现。
 *
 * 「续接一个进行中的 run」= 拉取后端 /agent/resume 的 SSE、把每个累积快照
 * 归一化后 yield 给 aui runtime、流结束时回填 conversation.runStatus。这套
 * 逻辑原先在 thread-history-adapter(刷新续接)和 thread.tsx(答题重连)各有
 * 一份,现在统一收在这里;两个入口只做 aui 接线(本模块不碰 aui)。
 *
 * runStatus 回填走 conversations-cache 的唯一写入面:resume 流绕过 agent
 * middleware,RUN_FINISHED 不会自动刷新 conversation 状态,不回填的话缓存会
 * 一直停留在 running,composer/侧边栏持续显示"运行中"。
 */

/** 409(后端还没把 reply 处理成可续接状态)时的退避重试间隔。 */
const RETRY_ON_409_DELAYS_MS = [500, 1000, 2000];

export type OpenResumeStreamOptions = {
  /** 透传给 fetch;aborted 时跳过 runStatus 回填(由取消方负责状态)。 */
  signal?: AbortSignal;
  /**
   * 答题重连场景置 true:此时 409 表示后端还在处理 reply(worker resolve +
   * run 变回 running),按退避间隔重试。刷新续接场景保持 false:那里的 409
   * 表示 run 停在 requires_action,重试无意义,直接结束走历史消息展示。
   */
  retryOn409?: boolean;
};

/**
 * 打开一条 resume 快照流。每个元素是归一化后的累积快照(ChatModelRunResult),
 * 中间快照 status 归一成 running 与正常流式 UI 一致,终态快照保持原样。
 * 404(无活跃 run)或不可重试的非 2xx 直接结束,不产出任何快照、不回填。
 */
export async function* openResumeStream(
  conversationId: string,
  qc: QueryClient,
  options?: OpenResumeStreamOptions,
): AsyncGenerator<ChatModelRunResult, void, unknown> {
  const signal = options?.signal;
  const res = await fetchResumeWithRetry(
    conversationId,
    signal,
    options?.retryOn409 ?? false,
  );
  if (!res || !res.ok || !res.body) return;

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
      qc.invalidateQueries({ queryKey: ["conversations"] });
    }
  }
}

async function fetchResumeWithRetry(
  conversationId: string,
  signal: AbortSignal | undefined,
  retryOn409: boolean,
): Promise<Response | undefined> {
  const delays = retryOn409 ? RETRY_ON_409_DELAYS_MS : [];
  for (let attempt = 0; ; attempt++) {
    const token = useAuthStore.getState().token;
    const res = await fetch(apiUrl(`/api/v1/agent/resume?id=${conversationId}`), {
      headers: {
        Accept: "text/event-stream",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(signal ? { signal } : {}),
    });
    if (res.status !== 409 || attempt >= delays.length) return res;
    await sleep(delays[attempt]!);
    if (signal?.aborted) return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
