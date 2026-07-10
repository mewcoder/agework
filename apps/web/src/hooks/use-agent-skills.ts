import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "@/api/agents";
import type { AgentType } from "@agework/shared";

export function useAgentSkills(workspaceId?: string, agentType?: AgentType) {
  return useQuery({
    queryKey: ["agents", "skills", workspaceId, agentType],
    queryFn: () => agentsApi.skills(workspaceId!, agentType!),
    enabled: !!workspaceId && !!agentType,
    staleTime: 60_000,
  });
}
