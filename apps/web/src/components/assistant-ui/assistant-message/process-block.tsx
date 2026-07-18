import { useEffect, useState, type ReactNode } from "react";
import { ChevronDownIcon } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

export type ToolGroupItem = {
  key: string | number;
  status?: { type?: string };
  children: ReactNode;
};

export type ToolGroupCluster = {
  kind: "completed" | "single";
  items: ToolGroupItem[];
};

/** Keep only adjacent completed calls in the same collapsed cluster. */
export function groupToolItems(items: ToolGroupItem[]): ToolGroupCluster[] {
  const groups: ToolGroupCluster[] = [];

  for (const item of items) {
    if (
      item.status?.type === "complete" &&
      groups.at(-1)?.kind === "completed"
    ) {
      groups.at(-1)!.items.push(item);
    } else {
      groups.push({
        kind: item.status?.type === "complete" ? "completed" : "single",
        items: [item],
      });
    }
  }

  return groups;
}

export function visibleToolItems(items: ToolGroupItem[]): ToolGroupItem[] {
  return items;
}

function CompletedToolGroup({ items }: { items: ToolGroupItem[] }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="w-full">
      <CollapsibleTrigger className="group/completed flex min-h-7 w-full items-center gap-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
        <span className="font-medium">已完成 {items.length} 个操作</span>
        <ChevronDownIcon className="size-3 shrink-0 -rotate-90 transition-transform group-data-[panel-open]/completed:rotate-0" />
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden">
        <div className="flex flex-col gap-1 py-0.5">
          {items.map((item) => (
            <div key={item.key}>{item.children}</div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ToolGroup({
  items,
  collapseCompleted = false,
}: {
  items: ToolGroupItem[];
  collapseCompleted?: boolean;
}) {
  const visibleItems = visibleToolItems(items);
  const groups = collapseCompleted
    ? groupToolItems(visibleItems)
    : visibleItems.map((item) => ({ kind: "single" as const, items: [item] }));

  return (
    <div className="flex flex-col gap-1">
      {groups.map((group, index) =>
        group.kind === "completed" && group.items.length > 1 ? (
          <CompletedToolGroup
            key={`completed-${group.items[0]?.key ?? index}`}
            items={group.items}
          />
        ) : (
          group.items.map((item) => <div key={item.key}>{item.children}</div>)
        ),
      )}
    </div>
  );
}

export function ProcessBlock({
  children,
  active = false,
  cancelled = false,
  userSteered = false,
  keepOpen = false,
}: {
  children: ReactNode;
  active?: boolean;
  cancelled?: boolean;
  userSteered?: boolean;
  /** Keep the process details visible while a permission interrupt awaits input. */
  keepOpen?: boolean;
}) {
  const shouldStayOpen = active || keepOpen;
  const [open, setOpen] = useState(shouldStayOpen);
  const title = userSteered
    ? "处理过程 · 用户已引导"
    : cancelled
      ? "处理过程 · 用户已取消"
      : active
        ? "正在处理"
        : "处理过程";

  useEffect(() => {
    queueMicrotask(() => setOpen(shouldStayOpen));
  }, [shouldStayOpen]);

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="group/process my-2 w-full first:mt-0 last:mb-0"
    >
      <CollapsibleTrigger
        title={title}
        className="group/trigger flex w-full items-center gap-2 py-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <span
          className={cn(
            "shrink-0 font-normal",
            active && "shimmer motion-reduce:animate-none",
          )}
        >
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
