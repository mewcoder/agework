import { useEffect, useState, type ReactNode } from "react";
import { ChevronDownIcon } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

export function ToolGroup({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-col gap-1">{children}</div>
    </div>
  );
}

export function ProcessBlock({
  children,
  active = false,
  cancelled = false,
  userSteered = false,
}: {
  children: ReactNode;
  active?: boolean;
  cancelled?: boolean;
  userSteered?: boolean;
}) {
  const [open, setOpen] = useState(active);
  const title = userSteered
    ? "处理过程 · 用户已引导"
    : cancelled
      ? "处理过程 · 用户已取消"
      : active
        ? "正在处理"
        : "处理过程";

  useEffect(() => {
    setOpen(active);
  }, [active]);

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="group/process my-2 w-full first:mt-0 last:mb-0"
    >
      <CollapsibleTrigger
        title={title}
        className="group/trigger flex w-full items-center gap-2 py-1 text-[15px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <span className="shrink-0 font-medium">
          {title}
        </span>
        <ChevronDownIcon className="size-3.5 shrink-0 transition-transform duration-200 -rotate-90 group-data-[panel-open]/trigger:rotate-0" />
        <div className="h-px min-w-8 flex-1 bg-border/60" />
      </CollapsibleTrigger>
      <CollapsibleContent
        className={cn(
          "overflow-hidden text-[13px] outline-none",
          "data-closed:animate-collapsible-up data-open:animate-collapsible-down",
          "data-closed:fill-mode-forwards data-closed:pointer-events-none",
          "data-open:duration-200 data-closed:duration-200",
        )}
      >
        <div
          className="aui-process-scroll flex flex-col gap-1 py-1.5 pr-1 text-[14px] leading-6 text-foreground/80"
        >
          {children}
        </div>
        <div className="h-px bg-border/60" />
      </CollapsibleContent>
    </Collapsible>
  );
}
