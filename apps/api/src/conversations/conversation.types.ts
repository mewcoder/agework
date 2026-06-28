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
