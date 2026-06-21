# 权限确认"始终允许"设计

## 背景

当前权限审批（后端拦截 Write/Bash 等工具时合成的 `AskUserPermission` 工具调用）
只提供"允许 / 拒绝"两个选项，每次同类工具调用都要用户重复确认。用户希望
"同一种工具的调用，确认一次就不再问"。

## 范围

- 只针对权限审批（`AskUserPermission`），不动普通问答（`AskUserQuestion`）。
- 只新增"始终允许"，不做"始终拒绝"。
- 持久化粒度：workspace 级（同一 workspace 下所有对话永久生效，直到手动改
  workspace 根目录的 `.claude/settings.local.json`）。这是 SDK 原生 `localSettings`
  destination 的固有行为，跨对话、跨消息持续生效，符合"同一个项目下不再重复问"
  的直觉，且无需自建数据库表。

## 机制：完全使用 SDK 原生机制

### 数据流

```
SDK canUseTool(toolName, input, opts)
  ├─ opts.suggestions: PermissionUpdate[]  ← 目前被丢弃，需打通
  └─ 调用 requestToolPermission → executePermissionRequest
       ├─ emit TOOL_CALL_START/ARGS（AskUserPermission，argsText 带 suggestions 标记）
       └─ 等用户答复
            ├─ "允许"        → { behavior:"allow", updatedInput }
            └─ "始终允许"     → { behavior:"allow", updatedInput, updatedPermissions: persist }
                                persist = suggestions.filter(d => d.destination === "localSettings")
```

SDK 在调用 `canUseTool` 之前会先检查 allow 规则。`updatedPermissions` 返回后，
SDK 自行把 `localSettings` 规则写入 workspace 根目录 `.claude/settings.local.json`；
此后同一 workspace 下所有对话的同类工具调用，会在 allow 规则那一步直接放行，
不再进入 `requestToolPermission`。

### 后端改动（packages/adapters/src/claude/business/claude-agent.adapter.ts）

1. **打通 `suggestions`**：`canUseTool` 回调（约 208-222 行）目前没有读取
   `opts.suggestions`。`requestToolPermission`/`executePermissionRequest` 的 input
   类型要加 `suggestions?: PermissionUpdate[]` 字段并一路透传。

2. **判定是否可"始终允许"**：`executePermissionRequest` 里根据
   `suggestions.some(s => s.destination === "localSettings")` 计算一个布尔标志
   `canAlwaysAllow`，写进 `AskUserPermission` 的 `argsText`（questions[0].options
   里条件性多一个 `{ label: "始终允许", description: "..." }` 选项）。

3. **按答案分支返回**：`PendingQuestion.resolveAnswers`（约 426-443 行）目前只
   根据 `value === "允许"` 判定 allow/deny。新增分支：当 `value === "始终允许"`
   且 `suggestions` 含 `localSettings` 规则时，返回
   `{ behavior:"allow", updatedInput: toolInput, updatedPermissions: persist }`；
   否则（未带 suggestions 或用户选的是普通"允许"）维持原 `{ behavior:"allow",
   updatedInput }`。

### 前端改动

1. **`PermissionPromptUI`（ask-user-question.tsx）**：从两个按钮变最多三个
   （始终允许 / 允许 / 拒绝）。新按钮只在 `options` 里存在 `label === "始终允许"`
   时渲染。

2. **`PERMISSION_ALWAYS_ALLOW_LABEL`**：新增导出常量 `"始终允许"`，供前后端统一
   识别。`isPermissionQuestion` 之类的判定不动（已删除，改按 toolName 分发）。

3. **提交路径复用**：点"始终允许"走跟"允许"完全一样的 `submitQuestionAnswer`
   接口，只是 `answers[question]` 的值是 `"始终允许"`。

## 边界处理

- **写入失败不检查**：点"始终允许"后不验证 `.claude/settings.local.json` 是否
  真写入成功。极端情况（只读挂载、磁盘满）下用户以为记住了实则没记住，下次会
  再被问一次——可接受，不做额外检测/提示。
- **无 `localSettings` suggestion 时不显示按钮**：避免点了却没有任何持久化
  效果。`canAlwaysAllow=false` 时 UI 退回原来的两按钮形态。
- **不做"始终拒绝"**：deny 规则会让该工具直接从 Claude 上下文消失，重新启用
  需手动改设置文件，体验差，本期不提供。

## 测试范围

### 后端（claude-agent.adapter.spec.ts）

1. `suggestions` 含 `localSettings` 规则时，emit 的 `AskUserPermission` argsText
   里 questions[0].options 包含"始终允许"选项。
2. `suggestions` 不含 `localSettings` 时，options 只有"允许 / 拒绝"两个。
3. 用户答"始终允许"且 suggestions 含 `localSettings` 时，`resolveAnswers` 返回的
   `PermissionResult` 带 `updatedPermissions`（过滤后的 `localSettings` 规则）。
4. 用户答"允许"时，`PermissionResult` 不带 `updatedPermissions`（维持原行为）。

### 前端（ask-user-question.test.tsx）

1. `PermissionPromptUI` 在 options 含"始终允许"时渲染三个按钮。
2. options 不含"始终允许"时仍渲染两个按钮（回归）。
3. 点"始终允许"提交 `answers[question] = "始终允许"`。

## 不在本期范围

- `localSettings` 写入失败检测 / 提示。
- "始终拒绝"。
- 按 conversation 维度的细粒度持久化（当前依赖 SDK `localSettings` 的 workspace
  级语义，不自建表）。
- 普通问答 `AskUserQuestion` 的任何改动。
