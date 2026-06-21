/**
 * forwardedProps 白名单 —— 允许运行时通过 input.forwardedProps 按请求覆盖的字段。
 * 对应 ThreadOptions 的字段名（camelCase）。
 */
export const ALLOWED_FORWARDED_PROPS = new Set<string>([
  "model",
  "sandboxMode",
  "workingDirectory",
  "skipGitRepoCheck",
  "modelReasoningEffort",
  "networkAccessEnabled",
  "webSearchMode",
  "webSearchEnabled",
  "approvalPolicy",
  "approvalsReviewer",
  "additionalDirectories",
]);
