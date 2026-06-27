import helmet from "helmet";

/**
 * 基础 HTTP 安全头中间件。开启 helmet 的低成本默认头
 * （X-Content-Type-Options、X-Frame-Options、HSTS、Referrer-Policy 等），
 * 暂时关闭 Content-Security-Policy：CSP 需要针对前端 SPA 与 SSE 单独制定
 * 策略，否则容易误伤内联资源与流式响应，留待后续按路径细化。
 */
export function securityHeaders() {
  return helmet({ contentSecurityPolicy: false });
}
