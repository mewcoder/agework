/**
 * 命令下发 trace 的记录端口（port）：command-queue 在 command 入队时记一条
 * 「已下发」事件。由 run 层提供实现并注入，从而保持 worker-host → run 零依赖。
 */
export interface CommandSentPort {
  recordCommandSent(input: {
    runId: string;
    commandId: string;
    commandType: string;
  }): Promise<void>;
}
