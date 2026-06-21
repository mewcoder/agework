"use client";

import type { ComponentProps, ReactNode } from "react";
import { isValidElement } from "react";
import {
  CheckCircleIcon,
  ChevronDownIcon,
  CircleIcon,
  ClockIcon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

export type ToolState =
  | "approval-requested"
  | "approval-responded"
  | "input-available"
  | "input-streaming"
  | "output-available"
  | "output-denied"
  | "output-error";

export type ToolProps = ComponentProps<typeof Collapsible>;

export function Tool({ className, ...props }: ToolProps) {
  return (
    <Collapsible
      className={cn("group w-full overflow-hidden rounded-lg border bg-card", className)}
      {...props}
    />
  );
}

export type ToolHeaderProps = ComponentProps<typeof CollapsibleTrigger> & {
  state: ToolState;
  title?: string;
  toolName: string;
  meta?: ReactNode;
};

const statusLabels: Record<ToolState, string> = {
  "approval-requested": "待审批",
  "approval-responded": "已响应",
  "input-available": "运行中",
  "input-streaming": "等待中",
  "output-available": "已完成",
  "output-denied": "已拒绝",
  "output-error": "出错",
};

const statusIcons: Record<ToolState, ReactNode> = {
  "approval-requested": <ClockIcon className="size-3.5 text-amber-600" />,
  "approval-responded": <CheckCircleIcon className="size-3.5 text-blue-600" />,
  "input-available": <ClockIcon className="size-3.5 animate-pulse text-amber-600" />,
  "input-streaming": <CircleIcon className="size-3.5 text-muted-foreground" />,
  "output-available": <CheckCircleIcon className="size-3.5 text-emerald-600" />,
  "output-denied": <XCircleIcon className="size-3.5 text-orange-600" />,
  "output-error": <XCircleIcon className="size-3.5 text-destructive" />,
};

export function ToolStatusBadge({ state }: { state: ToolState }) {
  return (
    <Badge variant="secondary" className="gap-1 rounded-full text-xs">
      {statusIcons[state]}
      {statusLabels[state]}
    </Badge>
  );
}

export function ToolHeader({
  className,
  state,
  title,
  toolName,
  meta,
  ...props
}: ToolHeaderProps) {
  return (
    <CollapsibleTrigger
      className={cn(
        "flex w-full items-center justify-between gap-3 p-3 text-left outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/50",
        className
      )}
      {...props}
    >
      <div className="flex min-w-0 items-center gap-2">
        <WrenchIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate font-mono text-sm font-medium">
          {title ?? toolName}
        </span>
        <ToolStatusBadge state={state} />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {meta}
        <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-open:rotate-180" />
      </div>
    </CollapsibleTrigger>
  );
}

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export function ToolContent({ className, ...props }: ToolContentProps) {
  return (
    <CollapsibleContent
      className={cn("space-y-3 border-t px-3 pb-3 pt-2", className)}
      {...props}
    />
  );
}

export type ToolInputProps = ComponentProps<"div"> & {
  input: unknown;
  title?: string;
};

export function ToolInput({
  className,
  input,
  title = "参数",
  ...props
}: ToolInputProps) {
  if (input === undefined || input === null) return null;
  return (
    <div className={cn("space-y-1.5", className)} {...props}>
      <h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
      <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 text-xs">
        {formatToolValue(input)}
      </pre>
    </div>
  );
}

export type ToolOutputProps = ComponentProps<"div"> & {
  output?: unknown;
  errorText?: string;
  title?: string;
};

export function ToolOutput({
  className,
  output,
  errorText,
  title,
  ...props
}: ToolOutputProps) {
  if (output === undefined && !errorText) return null;
  return (
    <div className={cn("space-y-1.5", className)} {...props}>
      <h4 className="text-xs font-medium text-muted-foreground">
        {title ?? (errorText ? "错误" : "结果")}
      </h4>
      <div
        className={cn(
          "max-h-48 overflow-auto rounded-md bg-muted p-2 text-xs",
          errorText && "bg-destructive/10 text-destructive"
        )}
      >
        {errorText ? (
          <pre className="whitespace-pre-wrap break-words">{errorText}</pre>
        ) : isValidElement(output) ? (
          output
        ) : (
          <pre className="whitespace-pre-wrap break-words">
            {formatToolValue(output)}
          </pre>
        )}
      </div>
    </div>
  );
}

function formatToolValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
