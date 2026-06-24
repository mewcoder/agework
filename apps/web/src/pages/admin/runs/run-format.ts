const INTEGER_FORMATTER = new Intl.NumberFormat("zh-CN");

export function formatInteger(value?: number | null) {
  return typeof value === "number" ? INTEGER_FORMATTER.format(value) : "-";
}

export function formatRunDuration(
  startedAt?: string | null,
  finishedAt?: string | null
): string {
  if (!startedAt) return "-";
  const start = Date.parse(startedAt);
  const end = finishedAt ? Date.parse(finishedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
    return "-";

  return formatDurationMs(end - start);
}

/** 毫秒 → 可读时长（与总耗时同风格）。 */
export function formatDurationMs(ms?: number | null): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "-";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}小时 ${minutes}分钟`;
  if (minutes > 0) return `${minutes}分钟 ${seconds}秒`;
  if (seconds > 0) return `${seconds}秒`;
  return `${Math.floor(ms)}毫秒`;
}
