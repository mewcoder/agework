/**
 * 状态点：工具卡片与思考卡片共用的前缀指示器。
 *
 * 统一尺寸/圆角；完成态颜色可覆盖（工具用绿色、思考用灰色）。
 * running 脉动、cancelled 静默灰。
 */
import { cn } from "@/lib/utils";

export type DotStatus =
  | "running"
  | "complete"
  | "incomplete"
  | "requires-action"
  | "cancelled";

const dotColorMap: Record<DotStatus, string> = {
  running: "bg-primary animate-pulse",
  complete: "bg-emerald-500 dark:bg-emerald-400",
  incomplete: "bg-destructive",
  "requires-action": "bg-amber-500 dark:bg-amber-400",
  cancelled: "bg-muted-foreground/40",
};

export function StatusDot({
  status,
  /** 覆盖完成态颜色（如思考卡片用中性灰）。仅 status="complete" 生效。 */
  completeClassName,
  className,
}: {
  status: DotStatus;
  completeClassName?: string;
  className?: string;
}) {
  const color =
    status === "complete" && completeClassName
      ? completeClassName
      : dotColorMap[status];
  return (
    <span
      data-slot="status-dot"
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        color,
        className,
      )}
    />
  );
}
