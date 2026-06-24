import { useSelectionStore } from "@/stores/selection-store";
import { cn } from "@/lib/utils";
import { AgentIcon } from "@/components/icons/agent";
import { useAgentOptions } from "@/hooks/use-agent-options";
import { AGENT_LABELS } from "@agework/shared";

export function AgentSelect() {
  const selectedAgentType = useSelectionStore((s) => s.selectedAgentType);
  const selectAgentType = useSelectionStore((s) => s.selectAgentType);
  const { data: agentOptions } = useAgentOptions();
  const agents = agentOptions?.agents ?? [];

  return (
    <div className="inline-flex items-center gap-1 rounded-lg border border-border bg-background p-1">
      {agents.map((agent) => (
        <button
          key={agent.id}
          type="button"
          onClick={() => selectAgentType(agent.id)}
          className={cn(
            "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-sm transition-colors",
            selectedAgentType === agent.id
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
          aria-pressed={selectedAgentType === agent.id}
        >
          <AgentIcon agent={agent.id} />
          <span>{agent.label ?? AGENT_LABELS[agent.id]}</span>
        </button>
      ))}
    </div>
  );
}
