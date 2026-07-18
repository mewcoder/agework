"use client";

import { memo } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { ChevronDownIcon } from "lucide-react";
import {
  type ReasoningMessagePartComponent,
} from "@assistant-ui/react";
import { MarkdownText } from "@/components/assistant-ui/markdown-text";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { useCollapsibleOpen } from "@/hooks/use-collapsible-open";
import { StatusDot } from "@/components/assistant-ui/status-dot";

const ANIMATION_DURATION = 200;

const reasoningVariants = cva(
  "aui-reasoning-root my-2 w-full first:mt-0 last:mb-0",
  {
    variants: {
      variant: {
        outline: "",
        ghost: "",
        muted: "border-l border-border/60 pl-3",
      },
    },
    defaultVariants: {
      variant: "outline",
    },
  }
);

export type ReasoningRootProps = Omit<
  React.ComponentProps<typeof Collapsible>,
  "open" | "onOpenChange"
> &
  VariantProps<typeof reasoningVariants> & {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    defaultOpen?: boolean;
  };

function ReasoningRoot({
  className,
  variant,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  defaultOpen = false,
  children,
  ...props
}: ReasoningRootProps) {
  const { isOpen, handleOpenChange } = useCollapsibleOpen(
    controlledOpen,
    controlledOnOpenChange,
    defaultOpen,
  );

  return (
    <Collapsible
      data-slot="reasoning-root"
      data-variant={variant}
      open={isOpen}
      onOpenChange={handleOpenChange}
      className={cn(
        "group/reasoning-root",
        reasoningVariants({ variant, className })
      )}
      style={
        {
          "--animation-duration": `${ANIMATION_DURATION}ms`,
        } as React.CSSProperties
      }
      {...props}
    >
      {children}
    </Collapsible>
  );
}

function ReasoningTrigger({
  active,
  duration,
  className,
  ...props
}: React.ComponentProps<typeof CollapsibleTrigger> & {
  active?: boolean;
  duration?: number;
}) {
  const durationText = duration ? ` (${duration}s)` : "";

  return (
    <CollapsibleTrigger
      data-slot="reasoning-trigger"
      className={cn(
        "aui-reasoning-trigger group/trigger flex min-h-7 w-full items-center gap-1.5 rounded-md py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground",
        className
      )}
      {...props}
    >
      <StatusDot
        status={active ? "running" : "complete"}
        completeClassName="bg-sky-500 dark:bg-sky-400"
      />
      <span
        data-slot="reasoning-trigger-label"
        className="aui-reasoning-trigger-label-wrapper min-w-0 text-start"
      >
        <span
          className={cn(
            "block truncate font-medium text-foreground/70 transition-colors group-hover/trigger:text-foreground",
            active && "shimmer motion-reduce:animate-none",
          )}
        >
          Thinking{durationText}
        </span>
      </span>
      <ChevronDownIcon
        data-slot="reasoning-trigger-chevron"
        className={cn(
          "aui-reasoning-trigger-chevron size-3 shrink-0",
          "transition-transform duration-(--animation-duration) ease-out",
          "-rotate-90 group-data-[panel-open]/trigger:rotate-0"
        )}
      />
    </CollapsibleTrigger>
  );
}

function ReasoningContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent
      data-slot="reasoning-content"
      className={cn(
        "aui-reasoning-content relative overflow-hidden rounded-md bg-muted-foreground/[0.05] text-[13px] text-muted-foreground outline-none",
        "group/collapsible-content ease-out",
        "data-closed:animate-collapsible-up",
        "data-open:animate-collapsible-down",
        "data-closed:fill-mode-forwards",
        "data-closed:pointer-events-none",
        "data-open:duration-(--animation-duration)",
        "data-closed:duration-(--animation-duration)",
        className
      )}
      {...props}
    >
      <div className="px-2.5 py-2">{children}</div>
    </CollapsibleContent>
  );
}

function ReasoningText({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="reasoning-text"
      className={cn(
        "aui-reasoning-text relative z-0 max-h-64 space-y-4 overflow-y-auto text-[13px] leading-relaxed",
        className
      )}
      {...props}
    />
  );
}

const ReasoningImpl: ReasoningMessagePartComponent = () => <MarkdownText />;

const Reasoning = memo(
  ReasoningImpl
) as unknown as ReasoningMessagePartComponent & {
  Root: typeof ReasoningRoot;
  Trigger: typeof ReasoningTrigger;
  Content: typeof ReasoningContent;
  Text: typeof ReasoningText;
};

Reasoning.displayName = "Reasoning";
Reasoning.Root = ReasoningRoot;
Reasoning.Trigger = ReasoningTrigger;
Reasoning.Content = ReasoningContent;
Reasoning.Text = ReasoningText;

export {
  Reasoning,
  ReasoningRoot,
  ReasoningTrigger,
  ReasoningContent,
  ReasoningText,
};
