import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "@/api/agents";

export function useAgentOptions() {
  return useQuery({
    queryKey: ["agents", "options"],
    queryFn: () => agentsApi.options(),
  });
}
