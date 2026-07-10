import { memo, useEffect, useMemo, useState } from "react";
import { diffLines } from "diff";
import { AlertCircle, ChevronsUpDown, FoldVertical, UnfoldVertical } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { useWorkspaceFileDiff } from "@/hooks/use-workspace";
import type { ChangedFileEntry } from "@agework/shared/api";
import { cn } from "@/lib/utils";
import { ChangeStatusBadge } from "./workspace-change-status";

// ── 行级 diff 计算 ──

type DiffRow =
  | { kind: "add"; no: number; text: string }
  | { kind: "del"; no: number; text: string }
  | { kind: "context"; no: number; text: string };

type RenderItem =
  | { type: "row"; row: DiffRow }
  | { type: "gap"; rows: DiffRow[] };

/** 连续未变更行超过此阈值时折叠。 */
const CONTEXT_COLLAPSE_THRESHOLD = 8;

function splitLines(value: string): string[] {
  const lines = value.split("\n");
  // jsdiff 的每个片段 value 通常以换行结尾,split 后末尾会多一个空串
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function buildRows(before: string, after: string): DiffRow[] {
  // 统一换行符：git show 输出 LF，但 Windows 工作区文件是 CRLF，
  // diffLines 会把 "line\r\n" 和 "line\n" 当成不同行，导致整文件全红全绿。
  const parts = diffLines(before.replace(/\r\n/g, "\n"), after.replace(/\r\n/g, "\n"));
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const part of parts) {
    for (const text of splitLines(part.value)) {
      if (part.added) rows.push({ kind: "add", no: ++newNo, text });
      else if (part.removed) rows.push({ kind: "del", no: ++oldNo, text });
      else {
        oldNo++;
        rows.push({ kind: "context", no: ++newNo, text });
      }
    }
  }
  return rows;
}

function groupRows(rows: DiffRow[]): RenderItem[] {
  const items: RenderItem[] = [];
  let ctx: DiffRow[] = [];
  const flush = () => {
    if (ctx.length === 0) return;
    if (ctx.length > CONTEXT_COLLAPSE_THRESHOLD) {
      items.push({ type: "gap", rows: ctx });
    } else {
      for (const row of ctx) items.push({ type: "row", row });
    }
    ctx = [];
  };
  for (const row of rows) {
    if (row.kind === "context") {
      ctx.push(row);
    } else {
      flush();
      items.push({ type: "row", row });
    }
  }
  flush();
  return items;
}

// ── 行渲染 ──

function DiffLine({ row }: { row: DiffRow }) {
  const marker = row.kind === "add" ? "+" : row.kind === "del" ? "-" : " ";
  return (
    <div
      className={cn(
        "flex",
        row.kind === "add" && "bg-green-500/10",
        row.kind === "del" && "bg-destructive/10",
      )}
    >
      <span className="w-10 shrink-0 select-none py-0.5 pr-2 text-right text-[10px] text-muted-foreground/60 tabular-nums">
        {row.no}
      </span>
      <span
        className={cn(
          "w-4 shrink-0 select-none py-0.5 text-center",
          row.kind === "add" && "text-green-700 dark:text-green-400",
          row.kind === "del" && "text-destructive",
          row.kind === "context" && "text-muted-foreground/40",
        )}
      >
        {marker}
      </span>
      <pre
        className={cn(
          "min-w-0 flex-1 py-0.5 pr-3 font-mono whitespace-pre-wrap break-all",
          row.kind === "add" && "text-green-700 dark:text-green-400",
          row.kind === "del" && "text-destructive",
          row.kind === "context" && "text-foreground/80",
        )}
      >
        {row.text || " "}
      </pre>
    </div>
  );
}

function DiffGap({
  rows,
  expanded,
  onToggle,
}: {
  rows: DiffRow[];
  expanded: boolean;
  onToggle: () => void;
}) {
  if (expanded) {
    return (
      <>
        <button
          type="button"
          onClick={onToggle}
          className="flex w-full items-center gap-1.5 bg-muted/30 px-3 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted/50"
        >
          <ChevronsUpDown className="size-3 shrink-0" />
          收起 {rows.length} 行
        </button>
        {rows.map((row) => (
          <DiffLine key={row.no} row={row} />
        ))}
      </>
    );
  }
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center gap-1.5 bg-muted/30 px-3 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted/50"
    >
      <ChevronsUpDown className="size-3 shrink-0" />
      展开 {rows.length} 行
    </button>
  );
}

const UnifiedDiff = memo(function UnifiedDiff({
  before,
  after,
  expandedGaps,
  onToggleGap,
}: {
  before: string;
  after: string;
  expandedGaps: Set<number>;
  onToggleGap: (index: number) => void;
}) {
  const items = useMemo(() => groupRows(buildRows(before, after)), [before, after]);

  if (items.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        无差异
      </div>
    );
  }

  return (
    <div className="text-xs leading-relaxed">
      {items.map((item, index) =>
        item.type === "gap" ? (
          <DiffGap
            key={index}
            rows={item.rows}
            expanded={expandedGaps.has(index)}
            onToggle={() => onToggleGap(index)}
          />
        ) : (
          <DiffLine key={index} row={item.row} />
        ),
      )}
    </div>
  );
});

// ── 主 diff 视图(拉取 before/after 并渲染) ──

export function WorkspaceFileDiffView({
  workspaceId,
  entry,
}: {
  workspaceId: string;
  entry: ChangedFileEntry;
}) {
  const { data, isLoading, error } = useWorkspaceFileDiff(workspaceId, entry.path);
  const before = data?.before ?? "";
  const after = data?.after ?? "";

  const items = useMemo(() => groupRows(buildRows(before, after)), [before, after]);
  const gapIndices = useMemo(
    () => items.map((item, index) => (item.type === "gap" ? index : -1)).filter((i) => i >= 0),
    [items],
  );
  const [expandedGaps, setExpandedGaps] = useState<Set<number>>(() => new Set());
  // 切换文件时重置展开状态
  useEffect(() => {
    setExpandedGaps(new Set());
  }, [entry.path]);
  const hasGaps = gapIndices.length > 0;
  const allExpanded = hasGaps && gapIndices.every((i) => expandedGaps.has(i));

  const toggleGap = (index: number) => {
    setExpandedGaps((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };
  const toggleAll = () => {
    setExpandedGaps(allExpanded ? new Set() : new Set(gapIndices));
  };

  return (
    <div className="flex h-full flex-col">
      {/* 顶部:文件路径 + 状态 + 展开/收起全部 */}
      <div className="flex h-[32px] shrink-0 items-center gap-2 border-b border-border/50 px-2">
        <ChangeStatusBadge status={entry.status} />
        <span
          className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground"
          title={entry.oldPath ? `${entry.oldPath} → ${entry.path}` : entry.path}
        >
          {entry.path}
        </span>
        {hasGaps && (
          <TooltipIconButton
            tooltip={allExpanded ? "收起全部" : "展开全部"}
            side="bottom"
            className="size-6 shrink-0 self-center !rounded-[6px] text-muted-foreground"
            onClick={toggleAll}
          >
            {allExpanded ? (
              <FoldVertical className="size-3.5" />
            ) : (
              <UnfoldVertical className="size-3.5" />
            )}
          </TooltipIconButton>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {isLoading && <Skeleton className="m-2 h-full w-[calc(100%-1rem)]" />}

        {error && (
          <div className="flex h-full items-center justify-center p-4">
            <div className="flex items-center gap-2 text-center text-sm text-muted-foreground">
              <AlertCircle className="size-4 shrink-0" />
              <span>{error instanceof Error ? error.message : "无法加载 diff"}</span>
            </div>
          </div>
        )}

        {data && !isLoading && !error && (
          <UnifiedDiff
            before={before}
            after={after}
            expandedGaps={expandedGaps}
            onToggleGap={toggleGap}
          />
        )}
      </div>
    </div>
  );
}
