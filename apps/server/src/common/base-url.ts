/**
 * 规范化外部 base URL：去掉结尾斜杠，并校验 scheme，
 * 防止 file:// / javascript: 等非法协议通过。后端通用，与具体领域无关。
 * `mock:` 是内部测试 scheme：worker 遇到它返回确定性 mock 执行器
 * （不发任何网络请求，见 packages/worker MockAgentDriver），供 e2e/联调使用。
 */
export function normalizeBaseUrl(baseUrl?: string): string | undefined {
  if (!baseUrl) return undefined;
  const trimmed = baseUrl.trim().replace(/\/$/, "");
  if (trimmed && !/^(https?:\/\/|mock:)/i.test(trimmed)) {
    throw new Error(
      `Base URL 必须以 http:// / https:// (或内部测试 scheme mock:) 开头: ${trimmed}`
    );
  }
  return trimmed;
}
