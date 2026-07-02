/**
 * 规范化外部 base URL：去掉结尾斜杠，并校验 scheme，
 * 防止 file:// / javascript: 等非法协议通过。后端通用，与具体领域无关。
 */
export function normalizeBaseUrl(baseUrl?: string): string | undefined {
  if (!baseUrl) return undefined;
  const trimmed = baseUrl.trim().replace(/\/$/, "");
  if (trimmed && !/^https?:\/\//i.test(trimmed)) {
    throw new Error(`Base URL 必须以 http:// 或 https:// 开头: ${trimmed}`);
  }
  return trimmed;
}
