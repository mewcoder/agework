/**
 * 工具调用收起态标题摘要。
 *
 * 仿 Claude Code / Codex 官方渲染：按 toolName 分派，各取最能代表意图的字段，
 * 而不是统一指望 `description`（只有 Claude 的 Bash/Task schema 有该字段）。
 *
 * 纯函数，只读协议层已交付的 `args`（对象）+ `argsText`（原始 JSON 字符串）。
 * 流式期间 `args` 是 partial parse（字段可能缺失/不完整），缺字段时返回
 * `undefined`（不显示摘要，等 args 填上再显示），不崩、不空白。
 */

const MAX_LEN = 60;

function truncate(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= MAX_LEN) return collapsed;
  return `${collapsed.slice(0, MAX_LEN - 1)}…`;
}

function basename(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * 取 changes 的首个 path（Codex file_change: changes 可能是数组或对象）。
 * - 数组：取首个元素的 path/file_path
 * - 对象：取首个 key（{ [path]: change } 结构，见 Codex patch-item-content）
 */
function firstChangePath(changes: unknown): string | undefined {
  if (Array.isArray(changes)) {
    const first = changes[0];
    if (first && typeof first === "object") {
      const obj = first as Record<string, unknown>;
      return asString(obj.path) ?? asString(obj.file_path);
    }
    return undefined;
  }
  if (changes && typeof changes === "object") {
    const keys = Object.keys(changes as Record<string, unknown>);
    return keys.length > 0 ? keys[0] : undefined;
  }
  return undefined;
}

/**
 * 按 toolName 提取一行摘要。返回 `undefined` 表示无摘要（标题只显 toolName）。
 *
 * 优先读 `args`（协议层已解析的对象，省去重复 JSON.parse）；`args` 缺字段时
 * 不再回退解析 `argsText`——半截 JSON 反正解析不出，且协议层已尽力。
 */
export function getToolSummary(
  toolName: string,
  args: Record<string, unknown> | undefined,
): string | undefined {
  const a = (args ?? {}) as Record<string, unknown>;

  switch (toolName) {
    // ── Claude 内置工具 ──────────────────────────────────────────────
    case "Bash":
    case "Task": {
      const desc = asString(a.description);
      if (desc) return truncate(desc);
      const cmd = asString(a.command);
      return cmd ? truncate(cmd) : undefined;
    }

    case "Read":
    case "Write":
      return asString(a.file_path) ? basename(a.file_path as string) : undefined;

    case "Edit":
      return asString(a.file_path) ? basename(a.file_path as string) : undefined;

    case "MultiEdit": {
      const fp = asString(a.file_path);
      const ops = Array.isArray(a.operations) ? a.operations.length : undefined;
      if (!fp) return undefined;
      return ops ? `${basename(fp)} (+${ops})` : basename(fp);
    }

    case "Grep": {
      const pattern = asString(a.pattern);
      if (!pattern) return undefined;
      const path = asString(a.path);
      return path ? `${truncate(pattern)} in ${path}` : truncate(pattern);
    }

    case "Glob":
      return asString(a.pattern) ? truncate(a.pattern as string) : undefined;

    case "WebFetch":
      return asString(a.url) ? truncate(a.url as string) : undefined;

    case "WebSearch":
      return asString(a.query) ? truncate(a.query as string) : undefined;

    case "TodoWrite": {
      const todos = Array.isArray(a.todos) ? a.todos.length : undefined;
      return todos ? `${todos} 项待办` : "更新待办";
    }

    // ── Codex 工具 ───────────────────────────────────────────────────
    case "command_execution":
      return asString(a.command) ? truncate(a.command as string) : undefined;

    case "file_change": {
      const path = firstChangePath(a.changes);
      return path ? basename(path) : undefined;
    }

    case "web_search":
      return asString(a.query) ? truncate(a.query as string) : undefined;

    case "todo_list": {
      const items = Array.isArray(a.items) ? a.items.length : undefined;
      return items ? `${items} 项待办` : "更新待办";
    }

    case "codex_error":
      return asString(a.message) ? truncate(a.message as string) : undefined;

    // ── 后端合成 / 专属 UI 不走 ToolFallback 标题 ──────────────────────
    case "AskUserQuestion":
    case "AskUserPermission":
      return undefined;

    default:
      return undefined;
  }
}

// ── 仅用于测试：导出辅助函数 ─────────────────────────────────────────
export const __test = { truncate, basename, firstChangePath, MAX_LEN };
