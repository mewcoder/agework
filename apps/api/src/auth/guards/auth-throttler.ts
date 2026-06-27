import type { ThrottlerOptions } from "@nestjs/throttler";

/**
 * 公开认证接口的限流配置。两个独立桶组合防爆破：
 * - `ip`：按来源 IP 计数，挡同一 IP 的撞库 / 枚举（无论用户名是否存在）。
 * - `ip-username`：按 IP + 用户名计数，挡针对单一账号的密码爆破。
 *
 * 限流在 service 之前的 guard 阶段计数，因此不存在的用户名也照样进桶，
 * 与已有的账号级失败锁定（仅对存在用户生效）互补，堵住用户枚举绕过。
 */
const WINDOW_MS = 60_000;

export const AUTH_THROTTLER_IP = "auth-ip";
export const AUTH_THROTTLER_IP_USERNAME = "auth-ip-username";

function trackerIp(req: Record<string, unknown>): string {
  const ips = req.ips as string[] | undefined;
  return ips?.length ? ips[0] : ((req.ip as string | undefined) ?? "unknown");
}

function trackerUsername(req: Record<string, unknown>): string {
  const body = req.body as { username?: unknown } | undefined;
  const username =
    typeof body?.username === "string" ? body.username.trim().toLowerCase() : "";
  return `${trackerIp(req)}:${username}`;
}

export const AUTH_THROTTLERS: ThrottlerOptions[] = [
  {
    name: AUTH_THROTTLER_IP,
    ttl: WINDOW_MS,
    limit: 20,
    getTracker: (req) => trackerIp(req),
  },
  {
    name: AUTH_THROTTLER_IP_USERNAME,
    ttl: WINDOW_MS,
    limit: 8,
    getTracker: (req) => trackerUsername(req),
  },
];
