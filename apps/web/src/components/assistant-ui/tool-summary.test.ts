import { describe, it, expect } from "vitest";
import { getToolDisplayName, getToolSummary, __test } from "./tool-summary";

const { truncate, basename, MAX_LEN } = __test;

describe("getToolSummary — Claude 工具", () => {
  it("Bash 优先用 description", () => {
    expect(
      getToolSummary("Bash", {
        command: "pnpm typecheck",
        description: "Run typecheck and filter errors",
      }),
    ).toBe("Run typecheck and filter errors");
  });

  it("Bash 缺 description 时回退 command", () => {
    expect(getToolSummary("Bash", { command: "node --version" })).toBe(
      "node --version",
    );
  });

  it("Task 用 description", () => {
    expect(getToolSummary("Task", { description: "搜索认证模块" })).toBe(
      "搜索认证模块",
    );
  });

  it("Read 显示 file_path basename", () => {
    expect(getToolSummary("Read", { file_path: "apps/web/src/index.ts" })).toBe(
      "index.ts",
    );
  });

  it("Read 处理 Windows 反斜杠路径", () => {
    expect(getToolSummary("Read", { file_path: "C:\\proj\\a.ts" })).toBe("a.ts");
  });

  it("Edit 显示 file_path basename", () => {
    expect(
      getToolSummary("Edit", { file_path: "packages/adapters/src/x.ts" }),
    ).toBe("x.ts");
  });

  it("MultiEdit 显示 basename + 操作数", () => {
    expect(
      getToolSummary("MultiEdit", {
        file_path: "a.ts",
        operations: [{}, {}, {}],
      }),
    ).toBe("a.ts (+3)");
  });

  it("MultiEdit 无 operations 时只显 basename", () => {
    expect(getToolSummary("MultiEdit", { file_path: "a.ts" })).toBe("a.ts");
  });

  it("Grep 显示 pattern + path", () => {
    expect(getToolSummary("Grep", { pattern: "TODO", path: "src/" })).toBe(
      "TODO in src/",
    );
  });

  it("Grep 无 path 时只显 pattern", () => {
    expect(getToolSummary("Grep", { pattern: "TODO" })).toBe("TODO");
  });

  it("Glob 显示 pattern", () => {
    expect(getToolSummary("Glob", { pattern: "**/*.ts" })).toBe("**/*.ts");
  });

  it("WebFetch 显示 url", () => {
    expect(getToolSummary("WebFetch", { url: "https://example.com" })).toBe(
      "https://example.com",
    );
  });

  it("WebSearch 显示 query", () => {
    expect(getToolSummary("WebSearch", { query: "vite 7 release" })).toBe(
      "vite 7 release",
    );
  });

  it("TodoWrite 显示待办项数", () => {
    expect(
      getToolSummary("TodoWrite", { todos: [{}, {}] }),
    ).toBe("2 项待办");
  });
});

describe("getToolSummary — Codex 工具", () => {
  it("command_execution 显示 command（无 description）", () => {
    expect(
      getToolSummary("command_execution", { command: "npm --version" }),
    ).toBe("npm --version");
  });

  it("file_change（changes 为对象）显示首个 path basename", () => {
    expect(
      getToolSummary("file_change", {
        changes: { "src/a.ts": { type: "edit" } },
      }),
    ).toBe("a.ts");
  });

  it("file_change（changes 为数组）显示首个 path basename", () => {
    expect(
      getToolSummary("file_change", {
        changes: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
      }),
    ).toBe("a.ts");
  });

  it("web_search 显示 query", () => {
    expect(getToolSummary("web_search", { query: "rust async" })).toBe(
      "rust async",
    );
  });

  it("todo_list 显示项数", () => {
    expect(getToolSummary("todo_list", { items: [{}, {}, {}] })).toBe(
      "3 项待办",
    );
  });

  it("codex_error 显示 message", () => {
    expect(
      getToolSummary("codex_error", { message: "boom" }),
    ).toBe("boom");
  });
});

// ACP 的协议名是 kind（标题位已显示），agent 的真实工具名在 args.title —
// 摘要要把 title 和关键参数都带出来，否则 UI 上只剩一个 "search"。
describe("getToolSummary — ACP 工具", () => {
  it("other kind uses the ACP title as the visible tool name", () => {
    expect(getToolDisplayName("other", { title: "bash" })).toBe("bash");
    expect(getToolDisplayName("other", {})).toBe("other");
  });

  it("title + 参数一起显示", () => {
    expect(
      getToolSummary("search", { title: "glob", kind: "search", pattern: ".agework/.env*" }),
    ).toBe("glob · .agework/.env*");
  });

  it("按工具取各自的关键参数", () => {
    expect(
      getToolSummary("execute", { title: "bash", command: "ls -la" }),
    ).toBe("bash · ls -la");
    expect(
      getToolSummary("fetch", { title: "webfetch", url: "https://example.com" }),
    ).toBe("webfetch · https://example.com");
    expect(
      getToolSummary("read", { title: "read", filePath: "/tmp/a.ts" }),
    ).toBe("read · /tmp/a.ts");
  });

  it("只有 title 时单显 title（pending 阶段 rawInput 常为空）", () => {
    expect(getToolSummary("search", { title: "glob", kind: "search" })).toBe("glob");
  });

  it("只有参数没有 title 时单显参数", () => {
    expect(getToolSummary("search", { pattern: "*.ts" })).toBe("*.ts");
  });

  it("kind 未知时走 acp_tool，规则一致", () => {
    expect(getToolSummary("acp_tool", { title: "custom", command: "x" })).toBe(
      "custom · x",
    );
  });

  it("title/参数都没有时返回 undefined（不显示空摘要）", () => {
    expect(getToolSummary("search", { kind: "search" })).toBeUndefined();
  });
});

describe("getToolSummary — 降级与边界", () => {
  it("AskUserQuestion / AskUserPermission 返回 undefined（有专属 UI）", () => {
    expect(getToolSummary("AskUserQuestion", { questions: [] })).toBeUndefined();
    expect(getToolSummary("AskUserPermission", {})).toBeUndefined();
  });

  it("未知 toolName 返回 undefined", () => {
    expect(getToolSummary("SomeRandomTool", { foo: "bar" })).toBeUndefined();
  });

  it("args 为 undefined 返回 undefined（不崩）", () => {
    expect(getToolSummary("Bash", undefined)).toBeUndefined();
  });

  it("缺关键字段返回 undefined", () => {
    expect(getToolSummary("Bash", {})).toBeUndefined();
    expect(getToolSummary("Read", {})).toBeUndefined();
  });

  it("流式期间 partial args：已有字段能用就用", () => {
    // 模拟流式中途：command 已到，description 还没到
    expect(getToolSummary("Bash", { command: "ls" })).toBe("ls");
  });

  it("长文本截断到 MAX_LEN 并加省略号", () => {
    const long = "x".repeat(MAX_LEN + 50);
    const result = getToolSummary("Bash", { command: long });
    expect(result?.length).toBe(MAX_LEN);
    expect(result?.endsWith("…")).toBe(true);
  });

  it("多空白折叠为单空格", () => {
    expect(
      getToolSummary("Bash", { command: "a   b\n\tc" }),
    ).toBe("a b c");
  });
});

describe("辅助函数", () => {
  it("basename 处理正斜杠与反斜杠", () => {
    expect(basename("a/b/c.ts")).toBe("c.ts");
    expect(basename("a\\b\\c.ts")).toBe("c.ts");
    expect(basename("c.ts")).toBe("c.ts");
  });

  it("truncate 不超长时原样返回", () => {
    expect(truncate("short")).toBe("short");
  });
});
