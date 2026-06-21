# 权限确认"始终允许"实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给权限审批卡片加"始终允许"按钮，点了之后该 workspace 下同类工具调用永久不再询问（用 SDK 原生 `localSettings` 规则持久化）。

**Architecture:** 完全复用 Claude Agent SDK 原生权限机制——`canUseTool` 的 `opts.suggestions`（`PermissionUpdate[]`，含 `destination`）目前被丢弃，打通后由后端透传到合成事件，前端据此条件性显示"始终允许"；用户选它时后端把 `destination === "localSettings"` 的规则作为 `updatedPermissions` 返回给 SDK，SDK 自行写入 workspace 根目录 `.claude/settings.local.json`，后续同类调用在 allow 规则那一步直接放行。

**Tech Stack:** NestJS（后端 `packages/adapters`）、React + assistant-ui（前端 `apps/web`）、Claude Agent SDK、Vitest。

## Global Constraints

- 持久化粒度 = workspace 级（SDK `localSettings` 的固有语义，跨对话永久生效），不自建数据库表。
- 只新增"始终允许"，不做"始终拒绝"。
- `localSettings` 写入失败不检测、不提示。
- 新按钮只在 `suggestions` 含 `localSettings` 规则时显示，否则退回原两按钮。
- 不动普通问答 `AskUserQuestion` 的任何逻辑。
- 提交由用户主动发起，本计划的每个 task 末尾的 commit 步骤仅是建议，不要自动提交。

## 文件结构

- **Modify** `packages/adapters/src/claude/business/claude-agent.adapter.ts` — 打通 `suggestions`、新增 `PERMISSION_ALWAYS_ALLOW_LABEL`、`resolveAnswers` 分支返回 `updatedPermissions`。
- **Modify** `packages/adapters/src/claude/business/claude-agent.adapter.spec.ts` — 后端 4 个新测试。
- **Modify** `apps/web/src/components/assistant-ui/tools/ask-user-question.tsx` — `PermissionPromptUI` 渲染第三按钮、`PERMISSION_ALWAYS_ALLOW_LABEL` 导出。
- **Modify** `apps/web/src/components/assistant-ui/tools/ask-user-question.test.tsx` — 前端 3 个新测试。

---

## Task 1: 后端打通 suggestions 并按"始终允许"返回 updatedPermissions

**Files:**
- Modify: `packages/adapters/src/claude/business/claude-agent.adapter.ts:5-9`（imports）、`:208-222`（canUseTool 回调）、`:299-337`（requestToolPermission）、`:339-458`（executePermissionRequest + resolveAnswers）、`:478-479`（常量）
- Test: `packages/adapters/src/claude/business/claude-agent.adapter.spec.ts`

**Interfaces:**
- Consumes: SDK 的 `PermissionUpdate` 类型（来自 `@anthropic-ai/claude-agent-sdk`，已通过 `PermissionResult` 间接可用）。
- Produces: 合成事件 `argsText` 里 `questions[0].options` 可能含第三个选项 `{ label: "始终允许", description: "..." }`；`resolveAnswers` 在"始终允许"分支返回带 `updatedPermissions` 的 `PermissionResult`。前端 Task 2 依赖 `PERMISSION_ALWAYS_ALLOW_LABEL = "始终允许"` 这个字符串常量识别第三按钮。

**关键设计决策（写入代码注释）：**
- `suggestions` 是 SDK 在 `canUseTool` 调用时传入的，里面可能含多条 `PermissionUpdate`，只有 `destination === "localSettings"` 的会被 SDK 写盘持久化。我们只透传这一类。
- `canAlwaysAllow` 标志 = `suggestions?.some(s => s.destination === "localSettings") ?? false`。只有它为 true 时，合成的 question options 才多塞一个"始终允许"。

- [ ] **Step 1: 写失败测试 — suggestions 含 localSettings 时 emit 的 argsText 含"始终允许"选项**

在 `claude-agent.adapter.spec.ts` 末尾新增 describe block。需要先把 `requestToolPermission` 的测试 helper `callPermission` 扩展成能传 `suggestions`。先改 helper 签名：

找到现有 `callPermission` 函数（约 56-71 行），改成接受可选 `suggestions`：

```typescript
function callPermission(
  adapter: ReturnType<typeof makeAdapter>,
  threadId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  signal: AbortSignal,
  subscriber: unknown,
  suggestions?: { destination: string; type: string }[],
) {
  return adapter.requestToolPermission({
    threadId,
    toolName,
    toolInput,
    options: { signal, suggestions } as never,
    subscriber,
  });
}
```

同时把 `makeAdapter` 里 `requestToolPermission` 的 `options` 类型签名扩一个 `suggestions?` 字段（约 19-27 行）：

```typescript
const adapter = new ClaudeAgentAdapter({}) as unknown as {
  requestToolPermission(input: {
    threadId: string;
    runId?: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    options: {
      signal: AbortSignal;
      suggestions?: { destination: string; type: string }[];
    };
    subscriber: unknown;
  }): Promise<PermissionResult>;
};
```

然后在文件末尾（最后一个 `});` 之前）加：

```typescript
describe("ClaudeAgentAdapter 始终允许", () => {
  it("suggestions 含 localSettings 规则时，emit 的 argsText 里 options 含'始终允许'", async () => {
    const threadId = `t-always-${Math.random().toString(36).slice(2)}`;
    const adapter = makeAdapter();
    const { emitted, subscriber } = makeSubscriber();
    const ac = new AbortController();

    const suggestions = [
      { type: "addRules", destination: "localSettings", rules: [], behavior: "allow" },
    ];
    const p = callPermission(adapter, threadId, "Write", { file_path: "/a" }, ac.signal, subscriber, suggestions);
    await flush();

    const args = emitted.find((e) => e.type === EventType.TOOL_CALL_ARGS && e.delta);
    const parsed = JSON.parse(args!.delta as string);
    const labels = parsed.questions[0].options.map((o: { label: string }) => o.label);
    expect(labels).toContain("始终允许");
    expect(labels).toContain("允许");
    expect(labels).toContain("拒绝");

    resolveQuestion(threadId, { [parsed.questions[0].question]: "允许" });
    await p;
  });

  it("suggestions 不含 localSettings 时，options 只有'允许'和'拒绝'", async () => {
    const threadId = `t-no-always-${Math.random().toString(36).slice(2)}`;
    const adapter = makeAdapter();
    const { emitted, subscriber } = makeSubscriber();
    const ac = new AbortController();

    const p = callPermission(adapter, threadId, "Write", { file_path: "/a" }, ac.signal, subscriber, undefined);
    await flush();

    const args = emitted.find((e) => e.type === EventType.TOOL_CALL_ARGS && e.delta);
    const parsed = JSON.parse(args!.delta as string);
    const labels = parsed.questions[0].options.map((o: { label: string }) => o.label);
    expect(labels).toEqual(["允许", "拒绝"]);

    resolveQuestion(threadId, { [parsed.questions[0].question]: "允许" });
    await p;
  });

  it("用户答'始终允许'且 suggestions 含 localSettings 时，返回的 PermissionResult 带 updatedPermissions", async () => {
    const threadId = `t-always-resolve-${Math.random().toString(36).slice(2)}`;
    const adapter = makeAdapter();
    const { emitted, subscriber } = makeSubscriber();
    const ac = new AbortController();

    const localRule = { type: "addRules", destination: "localSettings", rules: [{ toolName: "Write", ruleContent: "/a" }], behavior: "allow" as const };
    const p = callPermission(adapter, threadId, "Write", { file_path: "/a" }, ac.signal, subscriber, [localRule]);
    await flush();

    const args = emitted.find((e) => e.type === EventType.TOOL_CALL_ARGS && e.delta);
    const parsed = JSON.parse(args!.delta as string);
    resolveQuestion(threadId, { [parsed.questions[0].question]: "始终允许" });
    const r = await p;

    expect(r.behavior).toBe("allow");
    expect((r as { updatedPermissions?: unknown[] }).updatedPermissions).toEqual([localRule]);
  });

  it("用户答'允许'时，PermissionResult 不带 updatedPermissions（维持原行为）", async () => {
    const threadId = `t-once-${Math.random().toString(36).slice(2)}`;
    const adapter = makeAdapter();
    const { emitted, subscriber } = makeSubscriber();
    const ac = new AbortController();

    const localRule = { type: "addRules", destination: "localSettings", rules: [], behavior: "allow" as const };
    const p = callPermission(adapter, threadId, "Write", { file_path: "/a" }, ac.signal, subscriber, [localRule]);
    await flush();

    const args = emitted.find((e) => e.type === EventType.TOOL_CALL_ARGS && e.delta);
    const parsed = JSON.parse(args!.delta as string);
    resolveQuestion(threadId, { [parsed.questions[0].question]: "允许" });
    const r = await p;

    expect(r.behavior).toBe("allow");
    expect((r as { updatedPermissions?: unknown[] }).updatedPermissions).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @agework/adapters exec vitest run src/claude/business/claude-agent.adapter.spec.ts`
Expected: 4 个新测试 FAIL（argsText 里没有"始终允许" / `updatedPermissions` 是 undefined），原有 5 个测试仍 PASS。

- [ ] **Step 3: 实现 — imports 加 PermissionUpdate 类型**

修改 `claude-agent.adapter.ts` 第 5-9 行的 import，把 `PermissionUpdate` 加进去：

```typescript
import type {
  ThinkingConfig,
  PermissionResult,
  PermissionUpdate,
} from "@anthropic-ai/claude-agent-sdk";
```

- [ ] **Step 4: 实现 — canUseTool 回调透传 suggestions**

修改 `claude-agent.adapter.ts:208-222` 的 `canUseTool` 回调。当前 `opts` 类型只有 `{ signal: AbortSignal }`，SDK 实际会传 `suggestions`。把类型扩成 SDK 的完整 `CanUseTool` options 形状，并把 `suggestions` 透传给 `requestToolPermission`：

```typescript
        canUseTool: async (
          toolName: string,
          toolInput: Record<string, unknown>,
          opts: {
            signal: AbortSignal;
            suggestions?: PermissionUpdate[];
            blockedPath?: string;
            decisionReason?: string;
            toolUseID?: string;
            agentID?: string;
            title?: string;
            displayName?: string;
            description?: string;
          }
        ): Promise<PermissionResult> => {
          if (toolName !== "AskUserQuestion") {
            return this.requestToolPermission({
              threadId,
              runId,
              toolName,
              toolInput,
              options: opts,
              subscriber,
            });
          }
```

（注意：只改 `opts` 的类型注解和保持透传 `options: opts`，`requestToolPermission` 内部类型在 Step 5 同步。）

- [ ] **Step 5: 实现 — requestToolPermission / executePermissionRequest 的 options 类型加 suggestions**

修改 `claude-agent.adapter.ts:299-315` 的 `requestToolPermission` input 类型，options 加 `suggestions?`：

```typescript
  private requestToolPermission(input: {
    threadId: string;
    runId?: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    options: {
      signal: AbortSignal;
      suggestions?: PermissionUpdate[];
      title?: string;
      displayName?: string;
      description?: string;
      decisionReason?: string;
      blockedPath?: string;
      toolUseID?: string;
    };
    subscriber: unknown;
  }): Promise<PermissionResult> {
```

同样修改 `claude-agent.adapter.ts:339-353` 的 `executePermissionRequest` input 类型，加 `suggestions?: PermissionUpdate[]`（结构和上面一致）。

- [ ] **Step 6: 实现 — 加常量 + buildToolPermissionQuestion 支持 canAlwaysAllow**

修改 `claude-agent.adapter.ts:478-515`。先导出常量（前端 Task 2 要用，所以加 `export`）：

```typescript
export const PERMISSION_ALWAYS_ALLOW_LABEL = "允许";
const TOOL_PERMISSION_ALLOW_LABEL = "允许";
const TOOL_PERMISSION_DENY_LABEL = "拒绝";
```

⚠️ 注意：`PERMISSION_ALWAYS_ALLOW_LABEL` 的值应该是 `"始终允许"`，不是 `"允许"`。修正：

```typescript
export const PERMISSION_ALWAYS_ALLOW_LABEL = "始终允许";
const TOOL_PERMISSION_ALLOW_LABEL = "允许";
const TOOL_PERMISSION_DENY_LABEL = "拒绝";
```

然后改 `buildToolPermissionQuestion` 签名加 `canAlwaysAllow` 参数：

```typescript
function buildToolPermissionQuestion(input: {
  toolName: string;
  toolInput: Record<string, unknown>;
  title?: string;
  displayName?: string;
  description?: string;
  decisionReason?: string;
  blockedPath?: string;
  canAlwaysAllow: boolean;
}) {
  const title =
    input.title ??
    `允许 Claude 使用 ${input.displayName ?? input.toolName}？`;
  const details = [
    input.description,
    input.decisionReason ? `原因：${input.decisionReason}` : undefined,
    input.blockedPath ? `路径：${input.blockedPath}` : undefined,
    input.description ? undefined : summarizeToolInput(input.toolInput),
  ]
    .filter(Boolean)
    .join("\n");

  const options: Array<{ label: string; description: string }> = [];
  if (input.canAlwaysAllow) {
    options.push({
      label: PERMISSION_ALWAYS_ALLOW_LABEL,
      description: "本次及后续同类工具调用均自动放行（写入 workspace 设置）。",
    });
  }
  options.push({
    label: TOOL_PERMISSION_ALLOW_LABEL,
    description: details || "允许本次工具调用继续执行。",
  });
  options.push({
    label: TOOL_PERMISSION_DENY_LABEL,
    description: "拒绝本次工具调用。",
  });

  return {
    question: title,
    header: "权限请求",
    options,
  };
}
```

- [ ] **Step 7: 实现 — executePermissionRequest 计算 canAlwaysAllow 并传入**

修改 `claude-agent.adapter.ts:369-378`（`executePermissionRequest` 内 buildToolPermissionQuestion 调用处）。在调用前计算标志，并保留 suggestions 供 resolveAnswers 用：

```typescript
    const suggestions = options.suggestions ?? [];
    const canAlwaysAllow = suggestions.some(
      (s) => s.destination === "localSettings"
    );
    const question = buildToolPermissionQuestion({
      toolName,
      toolInput,
      title: options.title,
      displayName: options.displayName,
      description: options.description,
      decisionReason: options.decisionReason,
      blockedPath: options.blockedPath,
      canAlwaysAllow,
    });
    const questions = [question];
    // 仅保留会被 SDK 写盘持久化的 localSettings 规则；其它 destination 不持久化，丢弃。
    const persistableSuggestions = suggestions.filter(
      (s) => s.destination === "localSettings"
    );
```

- [ ] **Step 8: 实现 — resolveAnswers 按"始终允许"分支返回 updatedPermissions**

修改 `claude-agent.adapter.ts:426-442`（`pending.resolveAnswers`）。把 `persistableSuggestions` 闭包捕获进来，新增"始终允许"分支：

```typescript
      const pending: PendingQuestion = {
        questions,
        resolveAnswers: (answers) => {
          const answer = answers[question.question];
          const value = Array.isArray(answer) ? answer[0] : answer;
          if (value === PERMISSION_ALWAYS_ALLOW_LABEL && persistableSuggestions.length > 0) {
            resolvePending({
              behavior: "allow",
              updatedInput: toolInput,
              updatedPermissions: persistableSuggestions,
            });
            return;
          }
          if (value === TOOL_PERMISSION_ALLOW_LABEL) {
            resolvePending({ behavior: "allow", updatedInput: toolInput });
            return;
          }
          resolvePending({
            behavior: "deny",
            message: "用户拒绝了该工具请求。",
          });
        },
        reject: rejectPending,
        rejectWithoutCleanup: reject,
      };
```

- [ ] **Step 9: 跑测试确认通过**

Run: `pnpm --filter @agework/adapters exec vitest run src/claude/business/claude-agent.adapter.spec.ts`
Expected: 9 个测试全 PASS（原 5 + 新 4）。

- [ ] **Step 10: typecheck**

Run: `pnpm --filter @agework/adapters exec tsc --noEmit`
Expected: 无输出（干净）。

- [ ] **Step 11: Commit（建议，由用户确认）**

```bash
git add packages/adapters/src/claude/business/claude-agent.adapter.ts packages/adapters/src/claude/business/claude-agent.adapter.spec.ts
```
提示用户是否提交。

---

## Task 2: 前端 PermissionPromptUI 渲染"始终允许"按钮

**Files:**
- Modify: `apps/web/src/components/assistant-ui/tools/ask-user-question.tsx:58-61`（常量导出）、`:267-371`（PermissionPromptUI）
- Test: `apps/web/src/components/assistant-ui/tools/ask-user-question.test.tsx`

**Interfaces:**
- Consumes: Task 1 后端 emit 的 `argsText` 里 `questions[0].options` 可能含 `{ label: "始终允许", ... }`；`PERMISSION_ALWAYS_ALLOW_LABEL` 常量（从 `@/components/assistant-ui/tools/ask-user-question` 导出，Task 2 自己定义，与后端字符串值保持一致 `"始终允许"`）。
- Produces: 用户点"始终允许"时调 `submitQuestionAnswer(convId, { [question]: "始终允许" })`，后端 Task 1 的 resolveAnswers 据此返回 updatedPermissions。

**关键设计决策：**
- `PermissionPromptUI` 从 props 里拿 `allowOption`/`denyOption`（现有逻辑），新增从 options 数组里找 `label === PERMISSION_ALWAYS_ALLOW_LABEL` 的 `alwaysAllowOption`。存在才渲染第三按钮。
- 第三按钮放在"允许"左边（视觉上"始终允许"是更强的放行，放最前）。

- [ ] **Step 1: 写失败测试 — options 含"始终允许"时渲染三个按钮**

在 `ask-user-question.test.tsx` 里。先在文件顶部 import 加 `PERMISSION_ALWAYS_ALLOW_LABEL`：

找到现有 import（约 1-11 行），改成：

```typescript
import {
  AskUserQuestionUI,
  PERMISSION_ALLOW_LABEL,
  PERMISSION_DENY_LABEL,
  PERMISSION_ALWAYS_ALLOW_LABEL,
  type AskUserQuestionItem,
  type AskUserQuestionInput,
} from "./ask-user-question";
```

然后在文件末尾（最后一个 `});` 之前）加新 describe：

```typescript
describe("AskUserQuestionUI 始终允许按钮", () => {
  it("options 含'始终允许'时渲染三个按钮", () => {
    const input: AskUserQuestionInput = {
      questions: [
        {
          question: "允许 Claude 使用 Write？",
          header: "权限请求",
          options: [
            { label: PERMISSION_ALWAYS_ALLOW_LABEL, description: "本次及后续同类工具调用均自动放行。" },
            { label: PERMISSION_ALLOW_LABEL, description: "允许本次工具调用继续执行。" },
            { label: PERMISSION_DENY_LABEL, description: "拒绝本次工具调用。" },
          ],
        },
      ],
    };
    render(<AskUserQuestionUI part={makePermissionPart(input)} />);

    expect(screen.getByRole("button", { name: /始终允许/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^允许$/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /拒绝/ })).toBeTruthy();
  });

  it("options 不含'始终允许'时仍只渲染允许/拒绝两个按钮", () => {
    const input: AskUserQuestionInput = {
      questions: [
        {
          question: "允许 Claude 使用 Write？",
          header: "权限请求",
          options: [
            { label: PERMISSION_ALLOW_LABEL, description: "允许本次工具调用继续执行。" },
            { label: PERMISSION_DENY_LABEL, description: "拒绝本次工具调用。" },
          ],
        },
      ],
    };
    render(<AskUserQuestionUI part={makePermissionPart(input)} />);

    expect(screen.queryByRole("button", { name: /始终允许/ })).toBeNull();
    expect(screen.getByRole("button", { name: /允许/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /拒绝/ })).toBeTruthy();
  });

  it("点'始终允许'提交 answers[question]=始终允许", async () => {
    const input: AskUserQuestionInput = {
      questions: [
        {
          question: "允许 Claude 使用 Write？",
          header: "权限请求",
          options: [
            { label: PERMISSION_ALWAYS_ALLOW_LABEL, description: "本次及后续同类工具调用均自动放行。" },
            { label: PERMISSION_ALLOW_LABEL, description: "允许本次工具调用继续执行。" },
            { label: PERMISSION_DENY_LABEL, description: "拒绝本次工具调用。" },
          ],
        },
      ],
    };
    render(<AskUserQuestionUI part={makePermissionPart(input)} />);

    fireEvent.click(screen.getByRole("button", { name: /始终允许/ }));

    await waitFor(() => {
      expect(mockApiPost).toHaveBeenCalledWith("/api/v1/agent/reply", {
        id: "conv-1",
        answers: { "允许 Claude 使用 Write？": PERMISSION_ALWAYS_ALLOW_LABEL },
      });
    });
  });
});
```

（`makePermissionPart` helper 在文件里已存在，复用即可——它默认 toolName 是 AskUserPermission。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter web exec vitest run src/components/assistant-ui/tools/ask-user-question.test.tsx`
Expected: 3 个新测试 FAIL（`PERMISSION_ALWAYS_ALLOW_LABEL` 未导出 / 第三个按钮没渲染 / 提交值不对），原有测试仍 PASS。

- [ ] **Step 3: 实现 — 导出 PERMISSION_ALWAYS_ALLOW_LABEL 常量**

修改 `ask-user-question.tsx:55-61`。当前是：

```typescript
// ── Permission prompt ─────────────────────────────────────────────────────────
// 后端拦截工具权限时合成的工具调用名是 "AskUserPermission"（跟模型自己真实调用的
// "AskUserQuestion" 是两个不同的 toolName），靠 part.toolName 直接区分即可，
// 不用再嗅探 header/options 文案。
export const PERMISSION_ALLOW_LABEL = "允许";
export const PERMISSION_DENY_LABEL = "拒绝";
```

改成：

```typescript
// ── Permission prompt ─────────────────────────────────────────────────────────
// 后端拦截工具权限时合成的工具调用名是 "AskUserPermission"（跟模型自己真实调用的
// "AskUserQuestion" 是两个不同的 toolName），靠 part.toolName 直接区分即可，
// 不用再嗅探 header/options 文案。
// "始终允许"：后端只在 canUseTool 传回了 localSettings suggestion 时才会把这个
// option 塞进 argsText，前端据此条件渲染第三按钮；点了之后后端把规则作为
// updatedPermissions 返回给 SDK，SDK 写入 workspace 的 .claude/settings.local.json。
export const PERMISSION_ALLOW_LABEL = "允许";
export const PERMISSION_DENY_LABEL = "拒绝";
export const PERMISSION_ALWAYS_ALLOW_LABEL = "始终允许";
```

- [ ] **Step 4: 实现 — PermissionPromptUI 找 alwaysAllowOption 并渲染第三按钮**

修改 `ask-user-question.tsx:267-371`（`PermissionPromptUI`）。当前开头是：

```typescript
function PermissionPromptUI({
  item,
  conversationId,
  statusType,
  toolCallId,
}: {
  item: AskUserQuestionItem;
  conversationId: string | null;
  statusType: ToolCallMessagePartStatus["type"];
  toolCallId?: string;
}) {
  const allowOption = item.options[0];
  const denyOption = item.options[1];
  const description = allowOption.description;
```

改成（用 label 查找，不依赖 options 顺序）：

```typescript
function PermissionPromptUI({
  item,
  conversationId,
  statusType,
  toolCallId,
}: {
  item: AskUserQuestionItem;
  conversationId: string | null;
  statusType: ToolCallMessagePartStatus["type"];
  toolCallId?: string;
}) {
  const allowOption = item.options.find((o) => o.label === PERMISSION_ALLOW_LABEL) ?? item.options[0];
  const denyOption = item.options.find((o) => o.label === PERMISSION_DENY_LABEL) ?? item.options[item.options.length - 1];
  const alwaysAllowOption = item.options.find((o) => o.label === PERMISSION_ALWAYS_ALLOW_LABEL);
  const description = allowOption.description;
```

然后找到渲染按钮的 JSX（约 336-368 行，两个 `<Button>`）。在"允许"按钮**之前**插入"始终允许"按钮。当前结构是：

```tsx
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            size="sm"
            onClick={() => void handleSubmit(PERMISSION_ALLOW_LABEL)}
            disabled={submitting}
            className="h-7 px-3 text-xs"
          >
            {submitting ? (
              <span className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
            ) : (
              <CheckIcon className="size-3.5" />
            )}
            {allowOption.label}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void handleSubmit(PERMISSION_DENY_LABEL)}
            disabled={submitting}
            className="h-7 px-3 text-xs"
          >
            {denyOption.label}
          </Button>
        </div>
```

改成（在允许按钮前加 alwaysAllow 按钮，用 `alwaysAllowOption &&` 条件渲染）：

```tsx
        <div className="flex shrink-0 items-center gap-1.5">
          {alwaysAllowOption && (
            <Button
              size="sm"
              onClick={() => void handleSubmit(PERMISSION_ALWAYS_ALLOW_LABEL)}
              disabled={submitting}
              className="h-7 px-3 text-xs"
            >
              {alwaysAllowOption.label}
            </Button>
          )}
          <Button
            size="sm"
            onClick={() => void handleSubmit(PERMISSION_ALLOW_LABEL)}
            disabled={submitting}
            className="h-7 px-3 text-xs"
          >
            {submitting ? (
              <span className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
            ) : (
              <CheckIcon className="size-3.5" />
            )}
            {allowOption.label}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void handleSubmit(PERMISSION_DENY_LABEL)}
            disabled={submitting}
            className="h-7 px-3 text-xs"
          >
            {denyOption.label}
          </Button>
        </div>
```

`handleSubmit` 已经是 `async (answer: string)` 接受任意 label，不用改——传 `"始终允许"` 进去，`submitQuestionAnswer` 会把它原样发给后端。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter web exec vitest run src/components/assistant-ui/tools/ask-user-question.test.tsx`
Expected: 全部 PASS（原有 + 新 3）。

- [ ] **Step 6: typecheck + lint**

Run: `pnpm --filter web run typecheck`
Expected: 无输出（干净）。

Run: `pnpm --filter web exec eslint src/components/assistant-ui/tools/ask-user-question.tsx src/components/assistant-ui/tools/ask-user-question.test.tsx`
Expected: 无 error（warning 可接受）。

- [ ] **Step 7: Commit（建议，由用户确认）**

```bash
git add apps/web/src/components/assistant-ui/tools/ask-user-question.tsx apps/web/src/components/assistant-ui/tools/ask-user-question.test.tsx
```
提示用户是否提交。

---

## Task 3: 全量回归验证

**Files:** 无修改，仅验证。

- [ ] **Step 1: 后端全量测试 + typecheck**

Run: `pnpm --filter @agework/adapters exec vitest run && pnpm --filter @agework/adapters exec tsc --noEmit`
Expected: 全 PASS，typecheck 干净。

- [ ] **Step 2: 前端全量测试 + typecheck**

Run: `pnpm --filter web exec vitest run && pnpm --filter web run typecheck`
Expected: 全 PASS，typecheck 干净。

- [ ] **Step 3: 手动验证（可选，需起 dev 环境）**

提示用户：`pnpm dev` 起服务，新建一个会话让 Claude 调一个需要权限的工具（如 Write），确认卡片出现"始终允许"按钮；点它后，同一会话再触发同类工具，确认不再弹卡片（被 allow 规则放行）。检查 workspace 根目录下 `.claude/settings.local.json` 是否新增了对应 allow 规则。
