import type { RunStatus } from "@/api/runs";

export const STATUS_OPTIONS: { value: RunStatus | "all"; label: string }[] = [
  { value: "all", label: "全部状态" },
  { value: "running", label: "运行中" },
  { value: "queued", label: "排队中" },
  { value: "preparing", label: "准备中" },
  { value: "requires_action", label: "等待操作" },
  { value: "cancelling", label: "取消中" },
  { value: "finished", label: "已完成" },
  { value: "error", label: "出错" },
  { value: "cancelled", label: "已取消" },
];

export function statusLabel(status: string) {
  return STATUS_OPTIONS.find((o) => o.value === status)?.label ?? status;
}

export function statusVariant(status: string) {
  if (status === "error") return "destructive" as const;
  if (status === "finished") return "secondary" as const;
  if (status === "running" || status === "requires_action")
    return "default" as const;
  return "outline" as const;
}

export function runStatusLabel(status: string) {
  if (status === "idle") return "空闲";
  if (status === "running") return "运行中";
  if (status === "error") return "出错";
  return status;
}

export function runStatusVariant(status: string) {
  if (status === "error") return "destructive" as const;
  if (status === "running") return "default" as const;
  return "secondary" as const;
}

export function runStatusBadgeClassName(status: string) {
  if (status === "error") return undefined;
  if (status === "running" || status === "requires_action") {
    return "border-primary/30 bg-primary/10 text-primary";
  }
  if (status === "finished") {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700";
  }
  if (status === "cancelled" || status === "cancelling") {
    return "border-muted-foreground/30 bg-muted text-muted-foreground";
  }
  return "border-amber-500/30 bg-amber-500/10 text-amber-700";
}

export function runStatusBadgeClassName(status: string) {
  if (status === "error") return undefined;
  if (status === "running") {
    return "border-primary/30 bg-primary/10 text-primary";
  }
  return "border-muted-foreground/30 bg-muted text-muted-foreground";
}
