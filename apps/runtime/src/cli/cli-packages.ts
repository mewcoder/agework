/**
 * Agent CLI 对应的独立安装包信息（runtime manager 侧副本）。
 * 逻辑与 apps/server/src/runtime/cli/cli-packages.ts 保持一致。
 */

import type { AgentType } from "@agework/shared";

/** 返回某个 agent 类型对应的、可通过 npm 安装的独立 CLI 包名
 *  （区别于内嵌调用用的 SDK 包，如 `@anthropic-ai/claude-agent-sdk`）。 */
export function resolveCliPackageName(agentType: AgentType): string {
  return agentType === "claude" ? "@anthropic-ai/claude-code" : "@openai/codex";
}
