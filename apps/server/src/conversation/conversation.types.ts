/**
 * 来自 assistant-ui 的用户消息形状（id / parentId 命名两种风格 + content）。
 * 作为 conversations 领域的后端跨模块契约，供 agent 入参与 runs 使用。
 */
export type AssistantUserMessage = {
  id?: unknown;
  parentId?: unknown;
  parent_id?: unknown;
  content?: unknown;
};

/**
 * run 聚合器产出的 assistant 消息快照。已存消息的信封(role/id/status/metadata
 * 嵌套、消息行 id=runId、format)由 ConversationService.saveAssistantMessage
 * 唯一构造,run 层只交快照本体,不再手拼信封。
 */
export type AssistantMessageSnapshot = {
  messageId: string | undefined;
  content: unknown[];
  status: unknown;
  metadata?: Record<string, unknown>;
};
