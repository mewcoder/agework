import { Observable } from "rxjs";
import type {
  AgentDriver,
  AgentEventStream,
  AgentRunInput,
  AgentRunPayload,
} from "@agework/agent-sdk";

/**
 * 确定性 mock 执行器：`baseUrl` 以 `mock:` 开头的自定义模型 provider 会命中它
 * （见 createAgentDriver），不接任何真实 SDK/CLI。供 e2e 与本地联调使用——
 * 消除对真实模型 key 的依赖，让 agent-run / cancel 用例可在 CI 稳定复现。
 *
 * 行为约定（由最后一条 user 消息文本驱动）：
 * - 默认：流式回显 `mock reply: <原文>`，几十毫秒内完成。
 * - 含 `[slow]`：以 250ms/块 持续输出约 30s，给"停止生成"类用例留出取消窗口。
 * - cancel/interrupt：中止发流并直接 complete（不发 TEXT_MESSAGE_END /
 *   RUN_FINISHED），runner 按 stopRequested 收敛成 cancelled——与真实 adapter
 *   被打断时的形态一致。
 * - HITL（问答/审批）暂不模拟：resolveControl 恒 false（后续按 resume 契约补）。
 */
export class MockAgentDriver implements AgentDriver {
  private aborted = false;
  private wake: (() => void) | undefined;

  run(input: AgentRunInput): AgentEventStream {
    return new Observable<unknown>((subscriber) => {
      this.play(input, (event) => subscriber.next(event)).then(
        () => subscriber.complete(),
        (err) => subscriber.error(err as Error)
      );
    });
  }

  // async 是有意的：与 AgentDriver 契约对齐，中止本身是同步的。
  // eslint-disable-next-line @typescript-eslint/require-await
  async interrupt(): Promise<void> {
    this.aborted = true;
    this.wake?.();
  }

  cancel(): Promise<void> {
    return this.interrupt();
  }

  resolveControl(): boolean {
    return false;
  }

  private async play(
    input: AgentRunInput,
    emit: (event: unknown) => void
  ): Promise<void> {
    const { aguiThreadId, payload } = input;
    const runId =
      typeof payload.runId === "string" && payload.runId
        ? payload.runId
        : aguiThreadId;
    const prompt = lastUserText(payload);
    const slow = prompt.includes("[slow]");
    const chunks = slow
      ? Array.from({ length: 120 }, (_, i) => `tick ${i} `)
      : ["mock reply: ", prompt || "(empty)"];
    const delayMs = slow ? 250 : 20;

    emit({ type: "RUN_STARTED", threadId: aguiThreadId, runId });
    const messageId = `mock-${runId}`;
    emit({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" });
    for (const delta of chunks) {
      await this.sleep(delayMs);
      if (this.aborted) return;
      emit({ type: "TEXT_MESSAGE_CONTENT", messageId, delta });
    }
    emit({ type: "TEXT_MESSAGE_END", messageId });
    emit({ type: "RUN_FINISHED", threadId: aguiThreadId, runId });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wake = undefined;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
    });
  }
}

/** 从 AG-UI RunAgentInput 形状的 payload 里取最后一条 user 消息的纯文本。 */
function lastUserText(payload: AgentRunPayload): string {
  const messages = payload.messages;
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as {
      role?: unknown;
      content?: unknown;
    } | null;
    if (!message || message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .map((part) =>
          part && typeof part === "object" && "text" in part
            ? String((part as { text: unknown }).text ?? "")
            : ""
        )
        .join("");
    }
    return "";
  }
  return "";
}
