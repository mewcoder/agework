"use client";

import { memo } from "react";
import { ChevronDownIcon } from "lucide-react";
import {
  type ToolCallMessagePartStatus,
  type ToolCallMessagePartComponent,
} from "@assistant-ui/react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { useCollapsibleOpen } from "@/hooks/use-collapsible-open";
import { hasToolContent } from "@/components/assistant-ui/thread-utils";
import { getToolSummary } from "@/components/assistant-ui/tool-summary";
import { StatusDot, type DotStatus } from "@/components/assistant-ui/status-dot";

export type ToolFallbackRootProps = Omit<
  React.ComponentProps<typeof Collapsible>,
  "open" | "onOpenChange"
> & {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  defaultOpen?: boolean;
  /** 没有可展示内容时锁定：禁止展开，并强制收起。 */
  locked?: boolean;
};

function ToolFallbackRoot({
  className,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  defaultOpen = false,
  locked = false,
  children,
  ...props
}: ToolFallbackRootProps) {
  const { isOpen, handleOpenChange } = useCollapsibleOpen(
    controlledOpen,
    controlledOnOpenChange,
    defaultOpen,
  );

  return (
    <Collapsible
      data-slot="tool-fallback-root"
      open={locked ? false : isOpen}
      onOpenChange={locked ? undefined : handleOpenChange}
      disabled={locked}
      className={cn(
        "aui-tool-fallback-root group/tool-fallback-root w-full",
        className,
      )}
      style={
        {
          "--animation-duration": "200ms",
        } as React.CSSProperties
      }
      {...props}
    >
      {children}
    </Collapsible>
  );
}

type ToolStatus = ToolCallMessagePartStatus["type"];

const statusLabelMap: Record<ToolStatus, string> = {
  running: "运行中",
  complete: "已完成",
  incomplete: "未完成",
  "requires-action": "等待确认",
};

function ToolFallbackTrigger({
  toolName,
  summary,
  status,
  className,
  disabled,
  ...props
}: React.ComponentProps<typeof CollapsibleTrigger> & {
  toolName: string;
  /** 收起态标题的一行摘要（如命令、文件名、搜索词）。无则只显 toolName。 */
  summary?: string;
  status?: ToolCallMessagePartStatus;
}) {
  const statusType = status?.type ?? "complete";
  const isCancelled =
    status?.type === "incomplete" && status.reason === "cancelled";

  const statusLabel = isCancelled ? "已取消" : statusLabelMap[statusType];
  const dotStatus: DotStatus = isCancelled ? "cancelled" : statusType;

  return (
    <CollapsibleTrigger
      data-slot="tool-fallback-trigger"
      aria-label={`${toolName}，${statusLabel}`}
      disabled={disabled}
      className={cn(
        "aui-tool-fallback-trigger group/trigger flex min-h-7 w-full items-center gap-1.5 rounded-md py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground",
        "disabled:cursor-default disabled:hover:text-muted-foreground",
        className,
      )}
      {...props}
    >
      <StatusDot status={dotStatus} />
      <span
        data-slot="tool-fallback-trigger-label"
        className={cn(
          "aui-tool-fallback-trigger-label-wrapper flex min-w-0 items-center gap-1.5 text-start",
          isCancelled && "text-muted-foreground line-through",
        )}
      >
        <span className="shrink-0 font-medium text-foreground/70 transition-colors group-hover/trigger:text-foreground">
          {toolName}
        </span>
        {!disabled && (
          <ChevronDownIcon
            data-slot="tool-fallback-trigger-chevron"
            className={cn(
              "aui-tool-fallback-trigger-chevron size-3 shrink-0 text-muted-foreground",
              "transition-transform duration-(--animation-duration) ease-out",
              "-rotate-90 group-data-[panel-open]/trigger:rotate-0",
            )}
          />
        )}
        {summary && (
          <span className="max-w-[40ch] truncate text-muted-foreground">
            {summary}
          </span>
        )}
      </span>
    </CollapsibleTrigger>
  );
}

function ToolFallbackContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent
      data-slot="tool-fallback-content"
      className={cn(
        "aui-tool-fallback-content relative overflow-hidden text-[13px] outline-none",
        "group/collapsible-content ease-out",
        "data-closed:animate-collapsible-up",
        "data-open:animate-collapsible-down",
        "data-closed:fill-mode-forwards",
        "data-closed:pointer-events-none",
        "data-open:duration-(--animation-duration)",
        "data-closed:duration-(--animation-duration)",
        className,
      )}
      {...props}
    >
      <div className="flex flex-col gap-2 rounded-md bg-muted-foreground/[0.05] px-2.5 py-2 text-muted-foreground">
        {children}
      </div>
    </CollapsibleContent>
  );
}

function ToolFallbackArgs({
  argsText,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  argsText?: string;
}) {
  if (!argsText) return null;

  return (
    <div
      data-slot="tool-fallback-args"
      className={cn("aui-tool-fallback-args space-y-1.5", className)}
      {...props}
    >
      <p className="text-[11px] font-medium text-muted-foreground/65">
        输入
      </p>
      <pre className="aui-tool-fallback-args-value max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-muted/25 px-2.5 py-2 font-mono text-[12px] leading-5 text-foreground/80">
        {argsText}
      </pre>
    </div>
  );
}

function ToolFallbackResult({
  result,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  result?: unknown;
}) {
  if (result === undefined) return null;
  const resultText =
    typeof result === "string" ? result : JSON.stringify(result, null, 2);

  return (
    <div
      data-slot="tool-fallback-result"
      className={cn(
        "aui-tool-fallback-result space-y-1.5",
        className,
      )}
      {...props}
    >
      <p className="aui-tool-fallback-result-header text-[11px] font-medium text-muted-foreground/65">
        输出
      </p>
      <pre className="aui-tool-fallback-result-content max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-muted/25 px-2.5 py-2 font-mono text-[12px] leading-5 text-foreground/80">
        {resultText}
      </pre>
    </div>
  );
}

function ToolFallbackError({
  status,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  status?: ToolCallMessagePartStatus;
}) {
  if (status?.type !== "incomplete") return null;

  const error = status.error;
  const errorText = error
    ? typeof error === "string"
      ? error
      : JSON.stringify(error)
    : null;

  if (!errorText) return null;

  const isCancelled = status.reason === "cancelled";
  const headerText = isCancelled ? "取消原因：" : "错误：";

  return (
    <div
      data-slot="tool-fallback-error"
      className={cn(
        "aui-tool-fallback-error rounded-md bg-destructive/10 px-2.5 py-2",
        className,
      )}
      {...props}
    >
      <p className="aui-tool-fallback-error-header text-[11px] font-semibold text-destructive/80">
        {headerText}
      </p>
      <p className="aui-tool-fallback-error-reason mt-1 text-[13px] text-destructive">
        {errorText}
      </p>
    </div>
  );
}

const ToolFallbackImpl: ToolCallMessagePartComponent = ({
  toolName,
  args,
  argsText,
  result,
  status,
}) => {
  const isCancelled =
    status?.type === "incomplete" && status.reason === "cancelled";
  const locked = !hasToolContent({ argsText, result, status });
  const summary = getToolSummary(
    toolName,
    args as Record<string, unknown> | undefined,
  );

  return (
    <ToolFallbackRoot
      data-status={status?.type ?? "complete"}
      locked={locked}
      className={cn(
        "py-0",
        isCancelled && "opacity-70",
      )}
    >
      <ToolFallbackTrigger
        toolName={toolName}
        summary={summary}
        status={status}
        disabled={locked}
      />
      <ToolFallbackContent>
        <ToolFallbackError status={status} />
        <ToolFallbackArgs
          argsText={argsText}
          className={cn(isCancelled && "opacity-60")}
        />
        {!isCancelled && <ToolFallbackResult result={result} />}
      </ToolFallbackContent>
    </ToolFallbackRoot>
  );
};

const ToolFallback = memo(
  ToolFallbackImpl,
) as unknown as ToolCallMessagePartComponent & {
  Root: typeof ToolFallbackRoot;
  Trigger: typeof ToolFallbackTrigger;
  Content: typeof ToolFallbackContent;
  Args: typeof ToolFallbackArgs;
  Result: typeof ToolFallbackResult;
  Error: typeof ToolFallbackError;
};

ToolFallback.displayName = "ToolFallback";
ToolFallback.Root = ToolFallbackRoot;
ToolFallback.Trigger = ToolFallbackTrigger;
ToolFallback.Content = ToolFallbackContent;
ToolFallback.Args = ToolFallbackArgs;
ToolFallback.Result = ToolFallbackResult;
ToolFallback.Error = ToolFallbackError;

export {
  ToolFallback,
  ToolFallbackRoot,
  ToolFallbackTrigger,
  ToolFallbackContent,
  ToolFallbackArgs,
  ToolFallbackResult,
  ToolFallbackError,
};
