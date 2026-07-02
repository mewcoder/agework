import { useEffect, useRef, useState } from "react";
import { useAuiState, useMessageTiming } from "@assistant-ui/react";
import type { GroupableMessagePart } from "@/components/assistant-ui/thread-utils";
import { isToolCallPart } from "@/components/assistant-ui/thread-utils";

/**
 * 计算并格式化 assistant 消息的运行耗时。
 * 自动排除等待用户输入（AskUserQuestion / AskUserPermission）的时间段。
 */
export function useRunDurationText() {
  const timing = useMessageTiming();
  const isRunning = useAuiState((s) => s.message.status?.type === "running");
  const isWaiting = useAuiState((s) =>
    (s.message.parts as readonly GroupableMessagePart[]).some(
      (p) =>
        isToolCallPart(p) &&
        (p.toolName === "AskUserQuestion" || p.toolName === "AskUserPermission") &&
        p.status?.type === "running",
    ),
  );

  const [now, setNow] = useState<number>(() => Date.now());
  const [pausedMs, setPausedMs] = useState(0);
  const waitingStartedAtRef = useRef<number | null>(null);

  useEffect(() => {
    waitingStartedAtRef.current = null;
    queueMicrotask(() => {
      setPausedMs(0);
      setNow(Date.now());
    });
  }, [timing?.streamStartTime]);

  useEffect(() => {
    const current = Date.now();
    const waitingStartedAt = waitingStartedAtRef.current;

    if (waitingStartedAt != null && (!isRunning || !isWaiting)) {
      setPausedMs((prev) => prev + Math.max(0, current - waitingStartedAt));
      waitingStartedAtRef.current = null;
    }

    if (!isRunning) {
      setNow(current);
      return;
    }

    if (isWaiting) {
      if (waitingStartedAt == null) {
        waitingStartedAtRef.current = current;
        setNow(current);
      }
      return;
    }

    setNow(current);
    const id = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(id);
  }, [isRunning, isWaiting]);

  const liveMs =
    isRunning && timing?.streamStartTime != null
      ? now - timing.streamStartTime
      : null;
  const baseMs = liveMs != null ? liveMs : timing?.totalStreamTime;
  if (baseMs == null) return null;

  const ms = Math.max(0, baseMs - pausedMs);

  const sec = ms / 1000;
  return sec < 60 ? `${Math.floor(sec)}s` : `${Math.floor(sec / 60)}m${Math.round(sec % 60)}s`;
}
