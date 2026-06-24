import type { AdminRunEvent } from "@/api/runs";

// 单次 run 的事件数量天然有上限，一次性取全量后在前端筛选 + 虚拟滚动，不再分页。
export const EVENTS_FETCH_LIMIT = 5000;

export type EventSeverity = "info" | "warn" | "error";

export function eventData(event: AdminRunEvent): Record<string, unknown> | null {
  return event.data && typeof event.data === "object" && !Array.isArray(event.data)
    ? (event.data as Record<string, unknown>)
    : null;
}

export function eventSeverity(event: AdminRunEvent): EventSeverity {
  const data = eventData(event);
  if (event.type.endsWith(".failed")) return "error";
  if (event.type === "system.issue" && data?.severity === "error") return "error";
  if (event.type === "system.issue") return "warn";
  if (event.type === "run.status_changed" && data?.status === "error") {
    return "error";
  }
  return "info";
}

export function eventSeverityVariant(severity: EventSeverity) {
  if (severity === "error") return "destructive" as const;
  if (severity === "warn") return "secondary" as const;
  return "outline" as const;
}

export function eventSeverityClassName(severity: EventSeverity) {
  if (severity === "error") return undefined;
  if (severity === "warn") {
    return "border-amber-500/30 bg-amber-500/10 text-amber-700";
  }
  return "border-sky-500/30 bg-sky-500/10 text-sky-700";
}
