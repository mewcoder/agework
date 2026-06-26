/**
 * 控制下发 trace 的记录端口（port）：control-queue 在 control 入队时记一条
 * 「已下发」事件。由 run 层提供实现并注入，从而保持 worker-host → run 零依赖。
 */
export interface ControlSentRecorder {
  recordControlSent(input: {
    runId: string;
    commandId: string;
    controlType: string;
  }): Promise<void>;
}
