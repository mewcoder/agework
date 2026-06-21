/**
 * Permission mode locale definitions.
 *
 * Each entry contains both `zh` and `en` strings so the UI can
 * switch between languages when i18n is wired up.
 */

// ── Claude ─────────────────────────────────────────────────────
export const CLAUDE_PERMISSION_LOCALE = {
  default: {
    zh: { label: "编辑前询问", description: "编辑或执行需要权限的操作前先询问" },
    en: { label: "Ask before edits", description: "Ask before editing or running operations that need approval" },
  },
  dontAsk: {
    zh: { label: "不询问", description: "未被规则允许的工具请求会直接拒绝" },
    en: { label: "Do not ask", description: "Tool requests not allowed by rules are denied" },
  },
  acceptEdits: {
    zh: { label: "自动编辑", description: "自动批准工作目录内的文件编辑和文件系统操作" },
    en: { label: "Accept edits", description: "Automatically approve file edits and filesystem operations in the working directory" },
  },
  plan: {
    zh: { label: "计划模式", description: "只读探索并提出方案，不编辑文件" },
    en: { label: "Plan mode", description: "Read-only exploration and planning without editing files" },
  },
  auto: {
    zh: { label: "自动模式", description: "由 Claude 自动判断是否允许工具请求" },
    en: { label: "Auto mode", description: "Let Claude automatically decide whether to allow tool requests" },
  },
  bypassPermissions: {
    zh: { label: "完全访问", description: "绕过权限检查，自动批准所有工具请求" },
    en: { label: "Bypass permissions", description: "Bypass permission checks and approve all tool requests" },
  },
} as const;

// ── Codex ──────────────────────────────────────────────────────
export const CODEX_PERMISSION_LOCALE = {
  default: {
    zh: { label: "请求批准", description: "编辑外部文件和使用互联网时始终询问" },
    en: { label: "Default permissions", description: "Codex can read and edit files in the current workspace and run routine local commands" },
  },
  "auto-review": {
    zh: { label: "替我审批", description: "仅对检测到的风险操作请求批准" },
    en: { label: "Auto-review", description: "Eligible approval prompts go to a reviewer agent" },
  },
  "full-access": {
    zh: { label: "完全访问", description: "可不受限制地访问互联网和您电脑上的任何文件" },
    en: { label: "Full access", description: "Codex runs without sandbox restrictions" },
  },
} as const;

// ── Effort slider (Claude) ─────────────────────────────────────
export const EFFORT_LOCALE = {
  low: { zh: "低", en: "Low" },
  medium: { zh: "中", en: "Medium" },
  high: { zh: "高", en: "High" },
  xhigh: { zh: "极高", en: "Extra high" },
} as const;
