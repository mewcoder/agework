import { useSelectionStore } from "@/stores/selection-store";
import { cn } from "@/lib/utils";
import { AgentIcon } from "@/components/icons/agent";

export function AgentSelect() {
  const selectedAgentType = useSelectionStore((s) => s.selectedAgentType);
  const selectAgentType = useSelectionStore((s) => s.selectAgentType);

  return (
    <div className="inline-flex items-center gap-1 rounded-lg border border-border bg-background p-1">
      <button
        type="button"
        onClick={() => selectAgentType("claude")}
        className={cn(
          "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-sm transition-colors",
          selectedAgentType === "claude"
            ? "bg-primary text-primary-foreground"
            : "text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
        aria-pressed={selectedAgentType === "claude"}
      >
        <AgentIcon agent="claude" />
        <span>Claude</span>
      </button>
      <button
        type="button"
        onClick={() => selectAgentType("codex")}
        className={cn(
          "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-sm transition-colors",
          selectedAgentType === "codex"
            ? "bg-primary text-primary-foreground"
            : "text-muted-foreground hover:bg-muted hover:text-foreground",
        )}
        aria-pressed={selectedAgentType === "codex"}
      >
        <AgentIcon agent="codex" />
        <span>Codex</span>
      </button>
    </div>
  );
}
