import type { CookieOptions, Request, Response } from "express";
import { REFRESH_TOKEN_TTL_MS } from "./session.service";

/** refresh token 所在的 HttpOnly cookie 名。 */
export const REFRESH_COOKIE_NAME = "agework_rt";

/**
 * 三端均同源访问（dev 经 Vite 代理、prod/桌面同 host），故 SameSite=Lax 足够；
 * Secure 仅在生产启用，避免本地 http 下浏览器拒收。HttpOnly 让 JS 读不到，防 XSS 窃取。
 */
function cookieOptions(isProduction: boolean): CookieOptions {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    path: "/",
  };
}

export function setRefreshCookie(
  res: Response,
  rawToken: string,
  isProduction: boolean
): void {
  res.cookie(REFRESH_COOKIE_NAME, rawToken, {
    ...cookieOptions(isProduction),
    maxAge: REFRESH_TOKEN_TTL_MS,
  });
}

export function clearRefreshCookie(res: Response, isProduction: boolean): void {
  res.clearCookie(REFRESH_COOKIE_NAME, cookieOptions(isProduction));
}

export function readRefreshCookie(req: Request): string | undefined {
  const cookies = (req as Request & { cookies?: Record<string, string> })
    .cookies;
  const value: unknown = cookies?.[REFRESH_COOKIE_NAME];
  return typeof value === "string" && value ? value : undefined;
}
