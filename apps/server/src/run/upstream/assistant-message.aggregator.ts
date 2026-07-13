// Thin persistence wrapper around @assistant-ui/react-ag-ui's RunAggregator.
// Delegates the AG-UI event state machine to RunAggregator and adds the
// backend-only concern of building a point-in-time snapshot for persistence
// (build() may be called many times during a run, not just once at the end).
//
// Interrupt terminal model:问答挂起时 adapter 会用 RUN_FINISHED{interrupt}
// 结束当前 AG-UI run,答复后以新 runId 发 RUN_STARTED 续接。RunAggregator 在
// RUN_STARTED 时整体重置,所以这里在重置前留存已产出的 parts,build 时前置
// 拼接——持久化保持「一条平台 run = 一条 assistant 消息」,与 interrupt 之前
// 的形状一致。续接段里出现的跨段 TOOL_CALL_RESULT(问题工具的结果属于上一段)
// 直接补进留存 parts,不进聚合器(finishToolCall 会为未知 id 造空壳 part)。

import {
  RunAggregator,
  type AgUiEvent,
} from "@assistant-ui/react-ag-ui/runtime/adapter/run-aggregator";

export type AssistantMessageContent = {
  messageId: string | undefined;
  content: unknown[];
  status: unknown;
  metadata?: Record<string, unknown>;
};

export type IncompleteMessageReason =
  | "streaming"
  | "cancelled"
  | "error"
  | "user_steered";

export class AssistantMessageAggregator {
  private readonly aggregator: RunAggregator;
  private serverMessageId: string | undefined;
  private previousParts: Array<Record<string, unknown>> = [];

  constructor() {
    this.aggregator = new RunAggregator({
      // Backend persists reasoning regardless of UI display preference.
      showThinking: true,
      logger: { debug: () => {}, error: () => {} },
      // No streaming consumer here; build() pulls a snapshot on demand instead.
      emit: () => {},
      onServerMessageId: (id) => {
        if (!this.serverMessageId) this.serverMessageId = id;
      },
    });
  }

  handle(event: { type: string; [key: string]: unknown }): void {
    if (event.type === "RUN_STARTED") {
      this.retainCurrentParts();
    } else if (
      event.type === "TOOL_CALL_RESULT" &&
      typeof event.toolCallId === "string" &&
      !this.aggregator.hasToolCall(event.toolCallId) &&
      this.patchRetainedToolResult(event)
    ) {
      return;
    }
    this.aggregator.handle(event as AgUiEvent);
  }

  build(
    complete: boolean,
    incompleteReason: IncompleteMessageReason = "streaming"
  ): AssistantMessageContent {
    const snapshot = this.aggregator.getSnapshot();
    const currentParts = snapshot.content ? [...snapshot.content] : [];

    return {
      messageId: this.serverMessageId,
      content: [...this.previousParts, ...currentParts],
      status: complete
        ? (snapshot.status ?? { type: "complete", reason: "stop" })
        : this.incompleteStatus(snapshot.status, incompleteReason),
      ...(snapshot.metadata ? { metadata: snapshot.metadata } : {}),
    };
  }

  /** 续接前把当前段已产出的 parts 留存(RUN_STARTED 会重置底层聚合器)。 */
  private retainCurrentParts(): void {
    const snapshot = this.aggregator.getSnapshot();
    if (snapshot.content?.length) {
      this.previousParts.push(
        ...(snapshot.content as ReadonlyArray<Record<string, unknown>>)
      );
    }
  }

  /** 跨段 tool result:目标 tool call 在留存段里时补结果,返回是否命中。 */
  private patchRetainedToolResult(event: { [key: string]: unknown }): boolean {
    const index = this.previousParts.findIndex(
      (part) =>
        part.type === "tool-call" && part.toolCallId === event.toolCallId
    );
    if (index < 0) return false;
    const content = typeof event.content === "string" ? event.content : "";
    this.previousParts[index] = {
      ...this.previousParts[index],
      result: tryParseJson(content),
      ...(event.role === "tool" ? { isError: false } : {}),
      ...(typeof event.messageId === "string" && event.messageId
        ? { unstable_toolMessageId: event.messageId }
        : {}),
    };
    return true;
  }

  private incompleteStatus(status: unknown, reason: IncompleteMessageReason) {
    // 问答挂起(requires-action/interrupt)是合法的非终态,局部保存原样保留,
    // 刷新后据此恢复待答 UI;但 run 被取消/出错时终局原因覆盖挂起态,
    // 问题不再显示为待答。
    if (
      status &&
      typeof status === "object" &&
      "type" in status &&
      status.type === "requires-action"
    ) {
      if (reason === "streaming") return status;
      return { type: "incomplete", reason };
    }
    if (
      status &&
      typeof status === "object" &&
      "type" in status &&
      status.type === "incomplete"
    ) {
      if (reason !== "streaming") return { ...status, reason };
      return status;
    }

    return { type: "incomplete", reason };
  }
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
