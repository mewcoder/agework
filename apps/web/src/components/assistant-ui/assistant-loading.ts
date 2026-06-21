export type AssistantStageMessage = {
  role?: string;
  status?: { type?: string };
  parts?: readonly { type?: string; status?: { type?: string } }[];
};

/**
 * 助手消息运行期间的阶段，用于底部状态文案。
 *
 * - `thinking`   思考中（reasoning 流式、消息初始无 part、段间空隙）
 * - `executing`  执行中（工具调用运行或等待确认）
 * - `replying`   回复中（文本流式输出）
 */
export type AssistantStage = "thinking" | "executing" | "replying";

/**
 * 根据 message 的最后一个 part 推断当前运行阶段。
 *
 * assistant-ui 的状态注入规则保证：非 tool-call 的 part 只有数组里最后一个才可能处于 running
 * （见 reference-source-code assistant-ui message-runtime.ts 的 toMessagePartStatus）。
 * 因此只需看最后一个 part 的 type + status.type 即可可靠区分三态。
 *
 * resume 流式恢复时，快照 status 已在 thread-history-adapter 里归一化成
 * { type:"running" }，这里同样适用，无需单独识别 incomplete/streaming。
 *
 * 返回 null 表示消息不在运行（已完成 / 取消 / 失败），应显示 ActionBar 而非阶段文案。
 */
export function getAssistantStage(message: AssistantStageMessage): AssistantStage | null {
  if (message.role !== "assistant" || message.status?.type !== "running") return null;

  const parts = message.parts ?? [];
  const lastPart = parts[parts.length - 1];
  if (!lastPart) return "thinking";

  const statusType = lastPart.status?.type;
  if (lastPart.type === "text" && statusType === "running") return "replying";
  if (
    lastPart.type === "tool-call" &&
    (statusType === "running" || statusType === "requires-action")
  ) {
    return "executing";
  }
  return "thinking";
}
