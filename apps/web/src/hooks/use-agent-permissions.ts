import { useQuery } from "@tanstack/react-query";
import { agentPermissionsApi } from "@/api/agent-permissions";

export function useAgentPermissionOptions() {
  return useQuery({
    queryKey: ["agent", "permission-options"],
    queryFn: () => agentPermissionsApi.options(),
  });
}
