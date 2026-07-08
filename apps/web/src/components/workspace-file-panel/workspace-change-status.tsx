import type { WorkspaceChangeStatus } from "@agework/shared/api";
import { cn } from "@/lib/utils";

/** 状态 → 单字母 + 配色。added=绿、modified=琥珀、deleted=红、renamed=蓝。 */
const STATUS_META: Record<
  WorkspaceChangeStatus,
  { letter: string; className: string }
> = {
  added: {
    letter: "A",
    className: "bg-green-500/10 text-green-700 dark:text-green-400",
  },
  modified: {
    letter: "M",
    className: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
  deleted: {
    letter: "D",
    className: "bg-destructive/10 text-destructive",
  },
  renamed: {
    letter: "R",
    className: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
  },
};

export function ChangeStatusBadge({ status }: { status: WorkspaceChangeStatus }) {
  const meta = STATUS_META[status];
  return (
    <span
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-[10px] font-semibold select-none",
        meta.className,
      )}
      title={status}
    >
      {meta.letter}
    </span>
  );
}
