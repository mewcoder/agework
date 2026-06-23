import { apiGet } from "@/lib/http";
import type { AgentPermissionOptionsResponse } from "@agework/shared/api";

export const agentPermissionsApi = {
  options: () =>
    apiGet<AgentPermissionOptionsResponse>(
      "/api/v1/conversations/agent/permission-options"
    ),
};
