# Conversation / Runtime 命名重构实施计划

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking. 本计划按“不兼容历史、一次性改完整”设计；不保留旧 API/旧路由兼容层。

**Goal:** 将 AgeWork 业务会话从 `Thread/threadId` 统一重命名为 `Conversation/conversationId`，将运行资源字段从 `providerType/runtimeId` 统一为 `runtimeType/runtimeResourceId`，将 `agentResumeId` 统一为 `agentSessionId`，并把 assistant-ui 的 `threadId/remoteId` 限制在适配层。

**Architecture:** AgeWork 领域层使用 `Workspace -> Conversation -> Run`。AG-UI/assistant-ui 边界仍使用框架要求的 `threadId` 和 `runId`，但进入 AgeWork API、Prisma、runtime domain 后统一映射为 `conversationId` 和 `runId`。`runId` 保持全链路同值，不重命名。

**Tech Stack:** Prisma, NestJS 11, React 19, TanStack Router, assistant-ui, AG-UI, Vitest, TypeScript

---

## Final Naming

| 当前命名 | 目标命名 | 说明 |
|---|---|---|
| `Thread` | `Conversation` | AgeWork 业务会话 |
| `threadId` | `conversationId` | AgeWork 业务会话 ID |
| `Message.threadId` | `Message.conversationId` | 消息归属会话 |
| `Run.threadId` | `Run.conversationId` | Run 归属会话 |
| `Thread.runStatus` | `Conversation.activeRunStatus` | 会话当前活跃执行状态 |
| `Thread.pendingAction` | `Conversation.pendingUserAction` | 会话等待用户操作 |
| `Thread.agentResumeId` | `Conversation.agentSessionId` | agent/provider 内部会话 ID |
| `Run.providerType` | `Run.runtimeType` | 运行环境类型 |
| `Run.runtimeId` | `Run.runtimeResourceId` | 底层运行资源标识 |
| `RuntimeHandle.providerType` | `RuntimeHandle.runtimeType` | runtime handle 对齐 Run |
| `RuntimeHandle.runtimeId` | `RuntimeHandle.runtimeResourceId` | runtime handle 对齐 Run |

保留：

| 命名 | 原因 |
|---|---|
| `Run/runId` | 与 AG-UI `input.runId` / `event.runId` 对齐，表示一次 agent 执行 |
| assistant-ui `threadId/remoteId` | 框架内部命名，只允许存在于 adapter/runtime bridge 层 |

---

## File Structure

### 后端命名目标

| 当前文件/模块 | 目标 |
|---|---|
| `apps/api/src/threads/` | `apps/api/src/conversations/` |
| `ThreadController` | `ConversationController` |
| `ThreadService` | `ConversationService` |
| `CreateThreadDto` | `CreateConversationDto` |
| `UpdateThreadDto` | `UpdateConversationDto` |
| `ThreadIdDto` | `ConversationIdDto` |

### 前端命名目标

| 当前文件/模块 | 目标 |
|---|---|
| `apps/web/src/api/threads.ts` | `apps/web/src/api/conversations.ts` |
| `useThreads` | `useConversations` |
| `useThreadRunStatusMonitor` | `useConversationRunStatusMonitor` |
| `useThreadAgentRuntime` | 可保留或改为 `useConversationAgentRuntime`，但函数内部在 AG-UI 边界映射 `conversationId -> threadId` |
| `/t/$threadId` | `/c/$conversationId` |

---

## Tasks

### Task 1: Prisma schema 一次性重命名

**Files:**
- `apps/api/prisma/schema.prisma`

- [ ] 将 `model Thread` 改为 `model Conversation`
- [ ] 将 `Message.threadId` 改为 `Message.conversationId`
- [ ] 将 `Run.threadId` 改为 `Run.conversationId`
- [ ] 将 `Thread.runStatus` 改为 `Conversation.activeRunStatus`
- [ ] 将 `Thread.pendingAction` 改为 `Conversation.pendingUserAction`
- [ ] 将 `Thread.agentResumeId` 改为 `Conversation.agentSessionId`
- [ ] 将 `Run.providerType` 改为 `Run.runtimeType`
- [ ] 将 `Run.runtimeId` 改为 `Run.runtimeResourceId`
- [ ] 更新 relation 字段：`Workspace.threads` -> `Workspace.conversations`，`Message.thread` -> `Message.conversation`
- [ ] 更新索引：`@@index([threadId])` -> `@@index([conversationId])`
- [ ] 因不需要兼容历史，清空重建 Prisma client / dev DB 时不做数据迁移兼容

### Task 2: shared API 类型重命名

**Files:**
- `packages/shared/src/api/threads.ts`
- `packages/shared/src/api/runs.ts`
- `packages/shared/src/api/index.ts`
- 相关测试

- [ ] `threads.ts` 改为 `conversations.ts`
- [ ] `ThreadResponse` -> `ConversationResponse`
- [ ] `ThreadListResponse` -> `ConversationListResponse`
- [ ] `CreateThreadRequest` -> `CreateConversationRequest`
- [ ] `UpdateThreadRequest` -> `UpdateConversationRequest`
- [ ] `ThreadIdRequest` -> `ConversationIdRequest`
- [ ] 字段 `threadId` -> `conversationId`
- [ ] 字段 `runStatus` -> `activeRunStatus`
- [ ] 字段 `pendingAction` -> `pendingUserAction`
- [ ] 字段 `agentResumeId` -> `agentSessionId`
- [ ] `AdminRunResponse.threadId` -> `conversationId`
- [ ] `AdminRunResponse.runtimeId` -> `runtimeResourceId`
- [ ] 如暴露 `providerType`，改为 `runtimeType`

### Task 3: shared protocol/runtime 类型重命名

**Files:**
- `packages/shared/src/protocol/transport.ts`
- `packages/shared/src/protocol/envelope.ts`
- `packages/shared/src/protocol/*.spec.ts`

- [ ] `RunConfig.threadId` -> `RunConfig.conversationId`
- [ ] `RuntimeHandle.threadId` -> `RuntimeHandle.conversationId`
- [ ] `RuntimeHandle.providerType` -> `RuntimeHandle.runtimeType`
- [ ] `RuntimeHandle.runtimeId` -> `RuntimeHandle.runtimeResourceId`
- [ ] `ControlPayload.cancel.threadId` -> `conversationId`
- [ ] `ControlPayload.approval_resolved.threadId` -> `conversationId`
- [ ] 保留 `Envelope.runId`，但确认只承载真实 runId
- [ ] 处理 workspace 级 control envelope：不得再把 `workspaceId` 写入 `Envelope.runId`

### Task 4: 后端 threads 模块改为 conversations 模块

**Files:**
- `apps/api/src/threads/**`
- `apps/api/src/app.module.ts`
- `apps/api/src/agent/**`
- `apps/api/src/runtime/**`
- `apps/api/src/workspaces/**`

- [ ] `apps/api/src/threads` 目录重命名为 `conversations`
- [ ] `ThreadService` -> `ConversationService`
- [ ] `ThreadController` -> `ConversationController`
- [ ] 路由 `/threads/*` -> `/conversations/*`
- [ ] controller query/body/path 参数 `threadId` -> `conversationId`
- [ ] service 方法参数 `threadId` -> `conversationId`
- [ ] `toThreadDto` -> `toConversationDto`
- [ ] `setRunStatus` -> `setActiveRunStatus`
- [ ] `setPendingAction` -> `setPendingUserAction`
- [ ] `setAgentResumeId` -> `setAgentSessionId`
- [ ] 日志文案中 `thread` 改为 `conversation`
- [ ] `TitleService` 内部查询 `thread` 改为 `conversation`

### Task 5: runtime / worker 链路同步

**Files:**
- `apps/api/src/runtime/**`
- `apps/worker/src/**`
- `packages/adapters/src/**`

- [ ] `RunRecordService.create({ threadId })` -> `{ conversationId }`
- [ ] `findActiveByThreadId` -> `findActiveByConversationId`
- [ ] `RuntimeActiveStore.RunHandle.threadId` -> `conversationId`
- [ ] `RuntimeRunner.start(params.threadId)` -> `conversationId`
- [ ] `sendApprovalResolved(threadId)` -> `conversationId`
- [ ] `stop(threadId)` -> `conversationId`
- [ ] Runtime provider handle 字段同步为 `runtimeType/runtimeResourceId/conversationId`
- [ ] Worker 内部 adapter 调用 AG-UI 时，在边界映射：`conversationId` -> AG-UI `threadId`
- [ ] Adapter 内部仍可用 AG-UI `threadId`，但注释说明它等于 AgeWork `conversationId`
- [ ] `agentSessionId` 捕获逻辑替换旧 `agentResumeId` 命名

### Task 6: 前端 API、状态、路由重命名

**Files:**
- `apps/web/src/router.tsx`
- `apps/web/src/api/threads.ts`
- `apps/web/src/stores/selection-store.ts`
- `apps/web/src/stores/runtime-ui-store.ts`
- `apps/web/src/hooks/**`
- `apps/web/src/components/**`

- [ ] `api/threads.ts` -> `api/conversations.ts`
- [ ] `threadsApi` -> `conversationsApi`
- [ ] `/api/v1/threads/*` -> `/api/v1/conversations/*`
- [ ] `/t/$threadId` -> `/c/$conversationId`
- [ ] `selectedThreadId` -> `selectedConversationId`
- [ ] `activeThreadId` -> `activeConversationId`
- [ ] `urlThreadId` -> `routeConversationId`
- [ ] `ThreadContext` -> `ConversationContext`
- [ ] `useThreads` -> `useConversations`
- [ ] `completedRunThreadIds` -> `completedRunConversationIds`
- [ ] `failedRunThreadIds` -> `failedRunConversationIds`
- [ ] `cancelledThreads` -> `cancelledConversations`
- [ ] 只在 `thread-list-adapter.ts` / assistant-ui runtime bridge 保留 `threadId` / `remoteId`

### Task 7: assistant-ui 适配层边界收口

**Files:**
- `apps/web/src/lib/runtime/thread-list-adapter.ts`
- `apps/web/src/components/ConversationRuntimeProvider.tsx`
- `apps/web/src/hooks/use-thread-agent-runtime.ts`
- `apps/web/src/lib/runtime/agent-run-interceptor.ts`

- [ ] 在 adapter 层显式转换：`ConversationResponse.conversationId` -> assistant-ui `remoteId`
- [ ] `withRunSettings(params, conversationId, ...)` 内部写入 AG-UI `threadId: conversationId`
- [ ] `useRemoteThreadListRuntime({ threadId })` 的入参只在调用处命名为 framework thread id，外层变量叫 `routeConversationId`
- [ ] `aui.threadListItem().getState().remoteId` 读取后立即命名为 `conversationId`
- [ ] `RUN_ERROR` 可见化中 `input.threadId` 在本地变量中改名为 `conversationId`

### Task 8: 测试、文档和搜索清理

**Files:**
- `docs/runtime-id-naming-conventions.md`
- `CLAUDE.md`
- `ARCHITECTURE.md`
- `README.md`
- `apps/**/*.spec.ts`
- `packages/**/*.spec.ts`

- [ ] 更新文档中的 `Thread/threadId` 业务表述为 `Conversation/conversationId`
- [ ] 明确 assistant-ui 边界仍可出现 `threadId`
- [ ] 更新 `providerType/runtimeId` 为 `runtimeType/runtimeResourceId`
- [ ] 更新 `agentResumeId` 为 `agentSessionId`
- [ ] 更新测试 fixture 字段名
- [ ] 全仓搜索确认业务层无残留旧名：

```bash
rg -n "Thread|threadId|threadsApi|selectedThreadId|runStatus|pendingAction|agentResumeId|providerType|runtimeId" \
  --glob '!reference-source-code/**'
```

残留允许范围：

- assistant-ui / AG-UI adapter bridge 中的框架字段 `threadId`
- 上游协议 payload 原字段，例如 Claude `session_id`
- 历史文档中明确标注为旧名的说明

### Task 9: 验证

- [ ] 运行 Prisma generate
- [ ] 运行必要 type check：

```bash
pnpm typecheck
```

- [ ] 运行聚焦测试：

```bash
pnpm test:api -- runtime
pnpm test:web -- thread
```

- [ ] 手动检查关键链路：
  - 新建 Conversation
  - 发送消息生成 Run
  - Run 事件落到正确 Conversation
  - Stop 当前 Conversation 的 active Run
  - AskUserQuestion 能按 Conversation 回答
  - Docker runtimeResourceId 能持久化并用于 orphan recovery

---

## Guardrails

- 不做历史兼容，不保留旧 `/threads/*` API 或 `/t/$threadId` 路由。
- 不把 AG-UI 的 `threadId` 扩散到 AgeWork 领域层。
- 不重命名 `runId`，但必须保证它全链路同值。
- 不把 workspace scope 写入 `runId` 字段。
- `agentSessionId` 只表示 agent/provider 内部会话 ID，不表示登录 session。
- `runtimeResourceId` 只由 runtimeType 对应的 runtime 实现解释，业务层不解析其格式。
