import { Injectable } from "@nestjs/common";
import type { Response } from "express";
import type { AgentEventTraceConfig, RuntimeHandle } from "@agework/shared/protocol";
import type { IncompleteMessageReason, RuntimeMessageAggregator } from "./runtime-message-aggregator";

export type RunHandle = {
  runtimeHandle: RuntimeHandle;
  res: Response | null;
  aggregator: RuntimeMessageAggregator;
  conversationId: string;
  runId: string;
  workspaceId: string;
  agentType: string;
  agentEventTrace?: AgentEventTraceConfig;
  stopRequested: boolean;
  stopReason?: IncompleteMessageReason;
  saveRun: (complete: boolean, incompleteReason?: IncompleteMessageReason) => void;
  onAgentSessionId?: (sessionId: string) => void;
  /**
   * 当前 SSE 连接是否以「累积快照」模式推送。
   * 正常 run=false：转发原始 AG-UI 事件（前端 ChatHttpAgent 期望）。
   * resume 接续=true：每次事件 build 一个 ChatModelRunResult 快照推送
   *   （前端 ThreadHistoryAdapter.resume 直接 yield）。
   */
  streamingSnapshot?: boolean;
};

@Injectable()
export class RuntimeActiveStore {
  private readonly handles = new Map<string, RunHandle>();

  register(runId: string, handle: RunHandle): void {
    this.handles.set(runId, handle);
  }

  unregister(runId: string): void {
    this.handles.delete(runId);
  }

  get(runId: string): RunHandle | undefined {
    return this.handles.get(runId);
  }
}
