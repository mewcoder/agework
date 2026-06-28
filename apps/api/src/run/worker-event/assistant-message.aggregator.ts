// Thin persistence wrapper around @assistant-ui/react-ag-ui's RunAggregator.
// Delegates the AG-UI event state machine to RunAggregator and adds the
// backend-only concern of building a point-in-time snapshot for persistence
// (build() may be called many times during a run, not just once at the end).

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
    this.aggregator.handle(event as AgUiEvent);
  }

  build(
    complete: boolean,
    incompleteReason: IncompleteMessageReason = "streaming"
  ): AssistantMessageContent {
    const snapshot = this.aggregator.getSnapshot();

    return {
      messageId: this.serverMessageId,
      content: snapshot.content ? [...snapshot.content] : [],
      status: complete
        ? (snapshot.status ?? { type: "complete", reason: "stop" })
        : this.incompleteStatus(snapshot.status, incompleteReason),
      ...(snapshot.metadata ? { metadata: snapshot.metadata } : {}),
    };
  }

  private incompleteStatus(status: unknown, reason: IncompleteMessageReason) {
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
