import { apiGet } from "@/lib/http";
import type { AgentOptionsResponse } from "@agework/shared/api";

export const agentsApi = {
  options: () =>
    apiGet<AgentOptionsResponse>("/api/v1/agent/options"),
};
