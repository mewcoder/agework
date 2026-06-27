/** 从 Authorization header 中提取 Bearer token，未找到时返回 null。 */
export function extractBearerToken(
  headers: Record<string, string | string[] | undefined>
): string | null {
  const authHeaderValue = headers.authorization;
  const authHeader = Array.isArray(authHeaderValue)
    ? authHeaderValue[0]
    : authHeaderValue;
  return authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
}
