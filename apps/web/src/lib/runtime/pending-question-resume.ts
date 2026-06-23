export type PendingQuestionResumeMessage = {
  id: string;
  role: string;
  status?: { type?: string };
};

/**
 * 去掉卡在 running 状态、承载 AskUserQuestion 的末尾 assistant 消息。
 * resumeRun() 续接时 AgUiThreadRuntimeCore 会无条件新建一条占位 assistant 消息，
 * 如果这条旧消息还留在列表里，就会同时存在两条 status=running 的消息——
 * 重复的"正在处理"指示，且旧消息永远不会再被更新，看起来像卡住。
 */
export function dropStalePendingQuestionMessage<
  T extends PendingQuestionResumeMessage,
>(messages: readonly T[]): { messages: readonly T[]; removed: boolean } {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant" || last.status?.type !== "running") {
    return { messages, removed: false };
  }
  return { messages: messages.slice(0, -1), removed: true };
}

/**
 * 回答 pending question 后是否需要手动发起 resume 重连。
 * 只有刷新过页面（assistant-ui core 是全新实例，原始 /conversations/agent/run 的 SSE 连接已经
 * 丢失，isRunning=false）才需要；没刷新页面时原始连接仍存活，worker resolve 后
 * 续事件会通过它正常到达，再手动 resumeRun 会和原始 run 同时产生第二条助手消息。
 */
export function needsManualResumeReconnect(isRunning: boolean): boolean {
  return !isRunning;
}

export type ExportedMessageRepositoryLike<T> = {
  headId: string | null;
  messages: Array<{ parentId: string | null; message: T }>;
};

/**
 * 把按顺序排列的消息数组转成 ThreadRuntime.import() 所需的 ExportedMessageRepository
 * 形态，保留原始消息对象（包括其 id）。不用 assistant-ui 自带的
 * ExportedMessageRepository.fromArray——它会给每条消息重新生成 id，丢失消息原有身份。
 */
export function toExportedMessageRepository<T extends { id: string }>(
  messages: readonly T[],
): ExportedMessageRepositoryLike<T> {
  return {
    headId: messages.at(-1)?.id ?? null,
    messages: messages.map((message, index) => ({
      parentId: index > 0 ? messages[index - 1]!.id : null,
      message,
    })),
  };
}
