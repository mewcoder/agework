import dayjs from "dayjs";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

export function formatDateTime(value?: string | null): string {
  if (!value) return '';
  const d = dayjs(value);
  return d.isValid() ? d.format('YYYY/MM/DD HH:mm:ss') : '';
}

export function formatDateTimeMs(value?: string | null): string {
  if (!value) return '';
  const d = dayjs(value);
  return d.isValid() ? d.format('YYYY/MM/DD HH:mm:ss.SSS') : '';
}

export function formatRelativeTime(dateStr: string): string {
  const t = Date.parse(dateStr);
  if (Number.isNaN(t)) return "";
  const diff = Math.max(0, Date.now() - t);
  if (diff < MINUTE) return "刚刚";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}分钟前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}小时前`;
  if (diff < MONTH) return `${Math.floor(diff / DAY)}天前`;
  if (diff < YEAR) return `${Math.floor(diff / MONTH)}个月前`;
  return `${Math.floor(diff / YEAR)}年前`;
}