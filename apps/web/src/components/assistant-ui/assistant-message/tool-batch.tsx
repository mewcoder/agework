import { useState } from "react";
import { Collapsible } from "@/components/ui/collapsible";
import {
  ToolFallback,
  ToolFallbackTrigger,
  ToolFallbackContent,
} from "@/components/assistant-ui/tool-fallback";
import { cn } from "@/lib/utils";
import {
  type ToolCallBatch,
  aggregateToolStatus,
  hasToolContent,
} from "@/components/assistant-ui/thread-utils";

const toolBatchStatusDot: Record<string, string> = {
  running: "bg-primary animate-pulse",
  complete: "bg-emerald-500 dark:bg-emerald-400",
  incomplete: "bg-destructive",
  "requires-action": "bg-amber-500 dark:bg-amber-400",
};

export function ToolBatch({ batch }: { batch: ToolCallBatch }) {
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const { toolName, parts } = batch;
  const status = aggregateToolStatus(parts);
  const tp = parts[activeIdx];
  const isCancelled = tp?.status?.type === "incomplete" && tp?.status?.reason === "cancelled";
  const locked = !parts.some(hasToolContent);

  return (
    <Collapsible
      open={locked ? false : open}
      onOpenChange={locked ? undefined : setOpen}
      disabled={locked}
      className="w-full py-0"
      style={{ "--animation-duration": "200ms" } as React.CSSProperties}
    >
      <ToolFallbackTrigger toolName={`${toolName} × ${parts.length}`} status={status} disabled={locked} />
      <ToolFallbackContent>
        <div className="flex gap-0.5 pb-0.5">
          {parts.map((p, i) => {
            const st = p.status?.type ?? "complete";
            return (
              <button
                key={i}
                type="button"
                onClick={() => setActiveIdx(i)}
                className={cn(
                  "inline-flex h-5 min-w-5 items-center justify-center gap-1 rounded px-1.5 text-[11px] font-medium transition-colors",
                  i === activeIdx
                    ? "bg-foreground/8 text-foreground"
                    : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
                )}
              >
                <span className={cn("size-1.5 shrink-0 rounded-full", toolBatchStatusDot[st] ?? "bg-muted-foreground")} />
                {i + 1}
              </button>
            );
          })}
        </div>
        <ToolFallback.Error status={tp?.status} />
        <ToolFallback.Args argsText={tp?.argsText} className={cn(isCancelled && "opacity-60")} />
        {!isCancelled && <ToolFallback.Result result={tp?.result} />}
      </ToolFallbackContent>
    </Collapsible>
  );
}
