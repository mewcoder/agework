export function isDevAuthDisabled() {
  // 仅允许 development 或未设置 NODE_ENV（开发默认）时启用 AGEWORK_DEV_AUTH_DISABLED，
  // 防止 staging/test 等环境意外绕过认证。
  const nodeEnv = process.env.NODE_ENV;
  const isDev = !nodeEnv || nodeEnv === "development";
  return isDev && process.env.AGEWORK_DEV_AUTH_DISABLED === "true";
}
