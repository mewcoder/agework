import type { AdapterRuntimeConfig } from "@agework/shared/protocol";

/**
 * agent 层产出的运行规格：placement-free，只描述"用哪个 agent、怎么配适配器"。
 * RunConfigAssembler 再把它和 placement/run/conversation/workspace 信息组装成 RunConfig。
 */
export type AgentSpec = {
  agentType: string;
  adapter: AdapterRuntimeConfig;
};
