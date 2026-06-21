# Code Review: thread → conversation 重命名重构

**分支**: dev → main
**审查日期**: 2026-06-13
**审查范围**: 未提交的工作区变更（97 files, +1310 / -1289）

本次 dev 分支改动是一个大规模的 **thread → conversation 重命名重构**，同时附带多个字段重命名：

| 旧名 | 新名 |
|------|------|
| `threadId` | `conversationId` |
| `agentResumeId` | `agentSessionId` |
| `providerType` | `runtimeType` |
| `runtimeId` | `runtimeResourceId` |
| `runStatus` | `activeRunStatus` |
| `pendingAction` | `pendingUserAction` |

---

## 🔴 需要修复的问题（3 个）

### 1. Router 缓存优化被删除

**文件**: `apps/web/src/router.tsx:107`

旧代码在对话列表已缓存时跳过 API 调用：

```ts
// 旧代码（已删除）
const cached = queryClient.getQueryData<{ threads: { threadId: string }[] }>(["threads"]);
if (cached?.threads.some((t) => t.threadId === params.threadId)) return;
```

新代码每次都发起 `GET /conversations/get?conversationId=...` 请求。

**影响**: 用户点击侧边栏对话列表时，旧代码命中缓存直接跳过（零延迟），新代码每次都发请求，增加网络延迟和服务器负载。

**建议**: 恢复缓存检查逻辑，使用当前 conversation list query key。

---

### 2. `RunStatusPayload.pendingAction` 与 API 层 `pendingUserAction` 命名不一致

**文件**: `packages/shared/src/protocol/transport.ts:15`

Wire protocol 类型用 `pendingAction`，但 API 响应和数据库列统一用 `pendingUserAction`：

- `RunStatusPayload.pendingAction` — wire protocol
- `ConversationResponse.pendingUserAction` — API 响应
- `Conversation.pendingUserAction` — Prisma schema
- `conversationService.setPendingUserAction()` — service 方法

`runtime-event-processor.ts:126` 做了映射：`payload.pendingAction` → `setPendingUserAction()`。

**影响**: 新开发者消费 `RunStatusPayload` 时按 API 层惯例访问 `payload.pendingUserAction` → 得到 `undefined`，UI 永远不显示待确认问题状态。

**建议**: 在 protocol 层将 `pendingAction` 统一为 `pendingUserAction`，或在映射处加显式注释说明差异。

---

### 3. SSE `RUN_ERROR` 事件 JSON key 仍为 `threadId`

**文件**:
- `apps/api/src/runtime/core/runtime-runner.ts:64, 96`
- `apps/api/src/runtime/core/runtime-event-processor.ts:167`

```ts
// 当前代码
res.write(`data: ${JSON.stringify({ type: "RUN_ERROR", threadId: conversationId, runId, message })}\n\n`);
```

值是 `conversationId`，但 JSON key 仍写 `threadId`。共 3 处。

**影响**: 监控工具或前端代码解析 `RUN_ERROR` 事件时查找 `event.conversationId` → `undefined`，无法关联错误与对话；未来开发者看到 `threadId` 可能反向传播旧命名。

**建议**: 要么统一 key 为 `conversationId`，要么加注释说明这是 AG-UI 协议字段（如 `run-agent-input.ts` 中的注释风格）。

---

## 🟡 建议改进（4 个）

### 4. `ControlPayload.cancel` 的 `conversationId` 应为必填

**文件**: `packages/shared/src/protocol/transport.ts:67`

```ts
{ type: "cancel"; commandId: string; runId?: string; conversationId?: string }
```

类型声明 `conversationId` 为可选，但：

- `LocalRuntimeProvider.cancel()` 和 `DockerRuntimeProvider.cancel()` 构造 cancel payload 时总是包含 `conversationId`
- Worker `runPersistent()` 模式下 `if (control.runId && control.conversationId)` — 缺失时静默跳过取消
- `RuntimeHandle` 接口本身将 `conversationId` 声明为必填

**影响**: 未来调用者按可选类型构造 `{ type: 'cancel', commandId: '...' }`（省略 `conversationId`），worker 在 persistent 模式下跳过 if 判断，取消请求被静默忽略，运行无法终止。

**建议**: 将 `conversationId` 和 `runId` 改为 `string`（必填）。

---

### 5. `setPendingUserAction(null)` 调用冗余

**文件**: `apps/api/src/runtime/core/run-recovery.service.ts:49`

```ts
// 当前代码（run-recovery.service.ts:49-55）
await this.conversationService.setPendingUserAction(run.conversationId, null);  // ← 冗余
// ...
await this.conversationService.setActiveRunStatus(run.conversationId, "error");  // 已包含 pendingUserAction: null
```

`setActiveRunStatus` 的 Prisma update 已设置 `pendingUserAction: null`：

```ts
// conversation.service.ts:159-166
async setActiveRunStatus(conversationId, activeRunStatus) {
  await this.prisma.conversation.update({
    where: { id: conversationId },
    data: { activeRunStatus, pendingUserAction: null },  // 已经清理了
  });
}
```

**影响**: 每个孤儿 run 恢复多一次无用 DB 写入；如果后续 `setActiveRunStatus` 不再清理 `pendingUserAction`，冗余调用会掩盖逻辑缺陷。

**建议**: 删除 `run-recovery.service.ts:49-52` 的 `setPendingUserAction` 调用。

---

### 6. Trace logger 不再过滤 meta 字段

**文件**: `apps/api/src/agent/agent-trace-logger.ts:75`

旧代码用解构白名单过滤：

```ts
// 旧代码
const { appThreadId, threadId: _internalThreadId, ...rest } = this.meta;
const entry = { ts, seq, threadId: appThreadId, ...rest, name, payload };
```

新代码全量展开：

```ts
// 新代码
const entry = { ts, seq, ...this.meta, name, payload };
```

**影响**:
- 当前 `AgentTraceMeta` 字段（`conversationId`、`agentSessionId`、`userId`、`workspaceRootPath`）均非敏感信息，无安全风险
- 但失去了防止未来敏感字段泄漏的防线 — 向 `AgentTraceMeta` 添加字段会自动写入 trace 文件
- 旧 trace 格式用 `threadId` key，新格式用 `conversationId`，外部日志解析器可能中断
- 旧测试的 `expect(log).not.toContain('"appThreadId"')` 断言被删除，不再验证字段过滤

**建议**: 恢复白名单解构或在 `AgentTraceMeta` 类型上添加注释说明所有字段都会写入 trace 文件。

---

### 7. 双路径标题生成无显式顺序保证

**文件**: `apps/api/src/agent/agent-run-handler.ts:102`

```ts
// agent-run-handler.ts:53 — await 保证 saveUserMessage 先完成
await this.conversationService.saveUserMessage(conversationId, userMessage);

// agent-run-handler.ts:102-106 — fire-and-forget
this.titleService.maybeGenerate(conversationId, agentType, modelProviderId)
  .catch(swallow(this.logger, ...));
```

`saveUserMessage` 内部调用 `ensureTitleFromMessage`（规则标题：截取前 40 字符），`maybeGenerate` 用 LLM 生成更好标题覆盖。

**影响**: 当前 `await` 在第 53 行保证了 `saveUserMessage` 先完成，但这只是偶然保证。如果未来 `saveUserMessage` 变为非 await 或 `maybeGenerate` 提前启动，两个标题写入可能竞争。`maybeGenerate` 不检查已有标题，总是覆写。

**建议**: 加注释说明顺序依赖，或将 `maybeGenerate` 改为在 `saveUserMessage` 完成后显式调用。

---

## 🔵 命名一致性问题（1 个）

### 8. 前端多个文件/导出未完成重命名

| 文件 | 旧名 | 应改为 |
|------|------|--------|
| `apps/web/src/hooks/use-thread-agent-runtime.ts` | `findCachedThread`, `useThreadAgentRuntime` | `findCachedConversation`, `useConversationAgentRuntime` |
| `apps/web/src/components/thread-context.tsx` | 文件名 `thread-context` | `conversation-context.tsx` |
| `apps/web/src/lib/runtime/thread-list-adapter.ts` | `createThreadListAdapter` | `createConversationListAdapter` |
| `apps/web/src/lib/runtime/thread-message.ts` | `ThreadMessageItem`, `toThreadMessageItem` | 待定（注意 `ThreadMessage` 是 assistant-ui 框架类型，不应改名） |
| `apps/web/src/lib/runtime/thread-history-provider.tsx` | 文件名 | `conversation-history-provider.tsx` |
| `apps/web/src/components/sidebar/thread-list-item.tsx` | `ThreadListItem` | 待定（可能对应 assistant-ui 的 ThreadListItem 概念） |
| `apps/web/src/components/assistant-ui/thread-composer.tsx:108` | 局部变量 `newThreadFocusVisible` | `newConversationFocusVisible` |

**影响**: 开发者搜索 `findCachedConversation` 找不到实现，可能重复创建；import 路径仍含 `thread`，命名搜索不完整；文件内新旧命名混用增加认知负担。

**建议**: 在本次重构中一并完成重命名，避免半迁移状态。注意区分 assistant-ui 框架概念（`Thread`、`ThreadMessage`）和 AgeWork 领域概念（`Conversation`），框架类型的引用保持 `Thread` 不变。

---

## 附：审查方法

本次审查使用 7 角度并行扫描 + 1-vote 验证流程：

| 角度 | 说明 |
|------|------|
| A — 逐行扫描 | 逐行检查每个 hunk，寻找条件反转、空值解引用、缺少 await 等 |
| B — 行为审计 | 检查被删除的代码所执行的约束是否在新代码中重建 |
| C — 跨文件追踪 | 追踪函数签名变更对调用方的影响，检查 API 契约变更 |
| D — 复用检查 | 标记重复实现已有功能的代码 |
| E — 简化检查 | 标记不必要的复杂度、死代码、冗余状态 |
| F — 效率检查 | 标记冗余计算、重复 I/O、顺序执行可并行化等 |
| G — 深度检查 | 检查变更是否在正确的抽象层次实现，是否为脆弱的补丁 |

每个角度产出 ≤6 个候选，经去重和独立验证后保留 CONFIRMED 和 PLAUSIBLE 级别发现。
