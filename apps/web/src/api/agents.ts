import { apiGet } from "@/lib/http";
import type { AgentOptionsResponse, AgentSkillsResponse } from "@agework/shared/api";
import type { AgentType } from "@agework/shared";

export const agentsApi = {
  options: () =>
    apiGet<AgentOptionsResponse>("/api/v1/agent/options"),

  skills: (workspaceId: string, agentType: AgentType) =>
    apiGet<AgentSkillsResponse>(
      `/api/v1/agent/skills?workspaceId=${encodeURIComponent(workspaceId)}&agentType=${encodeURIComponent(agentType)}`,
    ),
};
