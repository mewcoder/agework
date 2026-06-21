# Assistant UI 数据层重构设计

> 状态：已归档。当前不推进 assistant-ui 数据层替换；事件追溯与日志体系见 active docs。
>
> 记录时间：2026-06-19

本文定义 AgeWork 从单一 `useAgUiRuntime` 路径，渐进扩展到自有数据层和通用 Agent Runtime 的设计方向。`useAgUiRuntime` 不需要立即替换；它应先作为现有 live UI runtime 保留，AgeWork 自有 runtime 先以 shadow/parity 方式落地。

相关背景：

- [Agent 事件体系评审报告](../agent-event-system-review.md)
- [Agent 事件追溯与日志体系改造计划](../agent-event-trace-logging-plan.md)
- [AgeWork Agent Event Log 设计](../agework-agent-event-protocol-design.md)
- [AgeWork Agent Runtime 可行性分析](./agework-agent-runtime-feasibility.md)
- [AG-UI 替换与 AgeWork Runtime 实施计划](./ag-ui-replacement-runtime-plan.md)

## 核心判断

AgeWork 可以继续使用 assistant-ui 的 UI primitives、message rendering、composer、tool UI 和交互能力，但不应把 assistant-ui runtime 内部 state 作为系统事实源。

目标定位：

```text
AgeWork canonical events = 事实源
AgeWork projections      = 业务数据层
assistant-ui runtime     = UI context adapter
assistant-ui components  = UI / interaction layer
AG-UI                    = 当前 live wire/runtime，可逐步降级为兼容 projection
```

换句话说：

- AgeWork 管数据、事件、状态恢复、工具过程和排查。
- assistant-ui 管组件、交互上下文、消息展示、composer 行为。
- AG-UI 不是事实源；短期继续承载 live rendering，长期可降级为兼容输出。

## 目标

- 让 Agent 完整执行过程由 AgeWork canonical event log 表达。
- 让工具调用过程可以完整重放和展示，而不是只保留最终 message snapshot。
- 保留 assistant-ui 现有 UI 体验，降低前端重写成本。
- 把 `useAgUiRuntime` 的职责逐步收缩；AgeWork 自己的 runtime adapter 先 shadow，再 feature flag 切换。
- 支持刷新、切换会话、恢复进行中 run 时显示完整处理过程。
- 降低后端 fork assistant-ui aggregator 的长期维护风险。

## 非目标

- 不立即删除 assistant-ui。
- 不立即删除 AG-UI adapter 或 `useAgUiRuntime`。
- 不在第一阶段重写所有消息组件。
- 不把 canonical event payload 全部塞进 assistant-ui message content。
- 不让 `MESSAGES_SNAPSHOT` 成为新的事实源。

## 当前问题

### 数据事实源不清晰

当前 live path 是：

```text
API SSE AG-UI events -> useAgUiRuntime -> assistant-ui internal messages
```

当前 history/resume path 是：

```text
API RuntimeMessageAggregator -> assistant-ui message snapshot -> ThreadHistoryAdapter
```

这意味着同一个 run 有两种状态构造路径：

- 正常 live：assistant-ui 前端聚合 AG-UI events。
- 刷新恢复：后端 fork aggregator 输出 snapshot。

两条路径的语义不完全一致，长期会产生漂移。

### 工具过程被 message snapshot 压扁

assistant-ui message content 可以展示 tool-call part，但它表达的是“当前 tool part 状态”，不是“工具执行过程”。

缺失的信息包括：

- args chunk 到达顺序。
- tool start / args end / result 的时间点。
- result 对应的 SDK raw event。
- worker transport retry/drop/seq gap。
- 用户审批、取消、错误在工具过程中的位置。

### assistant-ui history adapter 不适合自有数据层

assistant-ui 官方 ExternalStoreRuntime 的模型是：如果应用已经有自己的 store，就由应用持有 messages 和 persistence，assistant-ui runtime 只读取外部 messages 并调用 callbacks。

因此 AgeWork 更适合使用 `useExternalStoreRuntime` 作为桥，而不是让 `useAgUiRuntime` 持有核心数据。

## 目标架构

```text
┌─────────────────────────────────────────────────────────────┐
│                         Backend                             │
│                                                             │
│  SDK raw -> Adapter events -> Worker envelope(seq)           │
│                         │                                   │
│                         v                                   │
│              AgeWork canonical event log                    │
│                         │                                   │
│         ┌───────────────┼────────────────┐                  │
│         v               v                v                  │
│  assistant message   tool process     run diagnostics        │
│  projection          projection       projection             │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          v
┌─────────────────────────────────────────────────────────────┐
│                         Frontend                            │
│                                                             │
│  AgeWork chat store                                         │
│    - thread list                                            │
│    - messages                                               │
│    - run status                                             │
│    - tool process                                           │
│    - streaming event cursor                                 │
│                         │                                   │
│                         v                                   │
│  useAgeWorkAgentRuntime                                     │
│    -> useExternalStoreRuntime                               │
│                         │                                   │
│                         v                                   │
│  assistant-ui primitives / custom AgeWork panels             │
└─────────────────────────────────────────────────────────────┘
```

## 分层职责

| 层 | 拥有者 | 职责 |
| --- | --- | --- |
| Canonical event log | API | 保存完整事实事件，支持重放和排查 |
| Assistant message projection | API/Web | 从事件投影 assistant-ui `ThreadMessage` |
| Tool process projection | API/Web | 从事件投影完整工具过程 |
| AgeWork chat store | Web | 持有当前 thread 的 messages、run status、tool process |
| ExternalStoreRuntime adapter | Web | 把 AgeWork store 暴露给 assistant-ui |
| assistant-ui components | Web | 展示消息、composer、actions、tool UI |
| AG-UI live runtime | API/Web | 短期保留现有 live rendering；中长期作为兼容投影 |

## 数据所有权

### Backend

Backend 是执行事实源。

必须持有：

- run lifecycle。
- runtime/worker envelope seq。
- raw SDK trace。
- AG-UI compatibility event。
- control events。
- canonical event index。
- payload refs。

Backend 可以派生：

- assistant message snapshot。
- tool process projection。
- run diagnostics timeline。

### Frontend

Frontend 是当前交互态 owner。

必须持有：

- 当前选中 thread。
- 当前 thread messages。
- 当前 run streaming 状态。
- 当前 tool process 状态。
- composer input 状态。
- optimistic user message。

Frontend 不应持有：

- 唯一事实事件。
- terminal run status 的最终权威。
- payload 完整归档。

## 核心前端模块

建议新增以下模块。

```text
apps/web/src/lib/agework-runtime/
  agework-chat-store.ts
  agework-event-stream.ts
  project-assistant-message.ts
  project-tool-process.ts
  use-agework-agent-runtime.ts
  types.ts
```

### `agework-chat-store`

持有当前 thread 的 UI store。

建议状态：

```ts
type AgeWorkChatState = {
  conversationId: string | null;
  messages: AgeWorkMessage[];
  assistantMessages: ThreadMessage[];
  toolProcesses: ToolProcessItem[];
  activeRunId: string | null;
  activeRunStatus: "idle" | "running" | "requires_action" | "cancelling" | "error";
  isLoadingHistory: boolean;
  isStreaming: boolean;
  streamCursor?: string;
  error?: string;
};
```

说明：

- `messages` 是 AgeWork 自有格式，可携带更多业务字段。
- `assistantMessages` 是给 assistant-ui 的投影。
- `toolProcesses` 不塞进 assistant-ui message content，单独给处理过程面板消费。

### `agework-event-stream`

负责连接后端 stream。

输入：

- `conversationId`
- user append payload
- selected model provider
- agent settings

输出：

- canonical event 或 compatibility event。
- stream lifecycle。
- seq gap/error 信息。

职责：

- 发起 run。
- 接收 SSE。
- 将事件写入 store。
- 处理 abort/cancel。
- 在连接断开时保留 cursor。
- 不直接操作 assistant-ui runtime。

### `project-assistant-message`

从 AgeWork event/projection 生成 assistant-ui `ThreadMessage`。

职责：

- 生成 user message。
- 生成 assistant text/reasoning/tool-call parts。
- 设置 assistant message status。
- 设置 metadata/timing。
- 兼容当前 assistant-ui message shape。

限制：

- 只做 UI message 投影。
- 不作为事实源。
- 不保存完整工具过程。

### `project-tool-process`

从 canonical events 生成工具过程。

输出：

```ts
type ToolProcessItem = {
  toolCallId: string;
  toolName: string;
  status: "running" | "complete" | "error" | "cancelled" | "requires_action";
  parentMessageId?: string;
  startedAt?: string;
  argsStartedAt?: string;
  argsCompletedAt?: string;
  resultAt?: string;
  endedAt?: string;
  durationMs?: number;
  argsText?: string;
  resultPreview?: string;
  error?: string;
  rawEventRefs: string[];
  aguiEventRefs: string[];
};
```

职责：

- 展示完整工具过程。
- 支持刷新后重建。
- 支持管理端 run detail 复用。
- 高亮缺失 result、错误、seq gap。

### `use-agework-agent-runtime`

对 assistant-ui 的唯一适配入口。

内部使用 `useExternalStoreRuntime`。

职责：

- 把 `assistantMessages` 暴露给 assistant-ui。
- 把 composer `onNew` 转成 AgeWork run request。
- 把 cancel/reload/edit 映射到 AgeWork API。
- 设置 `isRunning`、`isDisabled`、`isSendDisabled`。
- 继续接入 attachments/feedback/speech 等 assistant-ui adapters。

伪结构：

```ts
function useAgeWorkAgentRuntime() {
  const state = useAgeWorkChatStore();

  return useExternalStoreRuntime({
    messages: state.assistantMessages,
    isRunning: state.isStreaming,
    setMessages: ignoredOrImportOnly,
    onNew: async (message) => {
      await ageworkRunController.startFromComposer(message);
    },
    onCancel: async () => {
      await ageworkRunController.cancel();
    },
    onReload: async (parentId) => {
      await ageworkRunController.reload(parentId);
    },
    convertMessage: identityOrAgeWorkMessageConverter,
    unstable_enableToolInvocations: true,
    adapters,
  });
}
```

## 后端 API 设计

### Run stream

建议逐步从纯 AG-UI SSE 迁移到 AgeWork event SSE。

短期兼容：

```text
POST /api/v1/agent/run
Accept: text/event-stream

data: { type: "agui.event", seq, payload }
data: { type: "run.status", seq, payload }
data: { type: "tool.process.delta", seq, payload }
```

长期目标：

```text
data: {
  "type": "agework.event",
  "runId": "...",
  "conversationId": "...",
  "seq": 42,
  "source": "agui",
  "eventType": "TOOL_CALL_START",
  "messageId": "...",
  "toolCallId": "...",
  "payload": { ... }
}
```

### History load

```text
GET /api/v1/conversations/:id/messages
```

返回 assistant message projection。

```text
GET /api/v1/conversations/:id/tool-process
```

返回工具过程 projection。

```text
GET /api/v1/runs/:id/events?cursor=...
```

返回 canonical event index，用于排查和增量恢复。

### Resume

刷新后的恢复不再只依赖 assistant message snapshot。

恢复流程：

1. 加载 conversation messages projection。
2. 加载 active run status。
3. 加载 tool process projection。
4. 若 run 仍在 running，使用 `streamCursor` 续接 event stream。
5. event stream 到达后继续更新 projections。

## AG-UI 的新定位

AG-UI 保留为当前 live runtime 和 compatibility projection。

短期：

- 后端继续发 AG-UI events。
- 前端保留现有 `useAgUiRuntime` 路径，作为默认 live UI runtime。

中期：

- 后端 canonical event log 先落地。
- 前端 AgeWork store 同时消费 canonical events。
- `useAgeWorkAgentRuntime` 通过 shadow/parity 验证后，再把 assistant-ui 渲染切到 `useExternalStoreRuntime`。

长期：

- AG-UI events 只作为调试/兼容输出。
- 新功能优先基于 AgeWork canonical event。
- 不再依赖 `MESSAGES_SNAPSHOT`。

## 迁移路径

### Phase 1: 旁路数据层 / shadow runtime

目标：不破坏现有 UI，先建立 AgeWork store。

任务：

1. 新增 AgeWork canonical event 类型。
2. API stream 同时输出现有 AG-UI event 和 AgeWork event envelope。
3. 前端建立 `AgeWorkThreadController` / `agework-chat-store`，旁路消费 event。
4. 实现 `project-tool-process`。
5. UI 暂时仍由 `useAgUiRuntime` 渲染 message，AgeWork Runtime 只做 shadow/parity/tool process。

验收：

- 现有聊天不回退。
- 前端 store 能完整记录工具过程。
- 管理端或调试面板能看到 tool process projection。

### Phase 2: assistant message 投影 parity

目标：验证 assistant-ui messages 可以由 AgeWork store 提供，但不立即默认切换。

任务：

1. 实现 `project-assistant-message`。
2. 新增 `useAgeWorkAgentRuntime`，先不默认启用。
3. 用 `useExternalStoreRuntime` 驱动现有 assistant-ui components。
4. 保留现有 `useAgUiRuntime` behind feature flag。
5. 对比同一 run 下两套 message projection 是否一致。

验收：

- 普通文本、reasoning、tool-call、permission question 正常显示。
- 刷新后 message 和 tool process 均可恢复。
- cancel/user-steered/error 状态一致。

### Phase 3: 后端 projection 稳定化

目标：后端成为 projection 权威，前端只做增量应用。

任务：

1. 后端持久化 canonical event index。
2. 后端提供 assistant message projection API。
3. 后端提供 tool process projection API。
4. resume 使用 event cursor，而不是只推 message snapshot。
5. `RuntimeMessageAggregator` 改名或重定位为 `AssistantMessageProjector`。

验收：

- 断线重连不丢工具过程。
- 管理端和会话页看到同一套 run/tool projection。
- projection 可通过 event log 重建。

### Phase 4: AG-UI 降级

目标：AG-UI 不再是核心链路。

任务：

1. 删除对 `MESSAGES_SNAPSHOT` 的核心依赖。
2. AG-UI output 变为 optional compatibility stream。
3. 精简前端 AG-UI middleware。
4. 清理重复 aggregator。

验收：

- 关闭 AG-UI runtime/compatibility 后，AgeWork chat 仍可正常运行。
- assistant-ui 组件仍通过 ExternalStoreRuntime 正常展示。
- 新 Agent provider 不必实现 AG-UI，只需输出 AgeWork canonical events。

## UI 结构调整

当前 assistant message 中的处理过程建议拆为两层：

```text
Thread
  Message list
    User message
    Assistant message
      Text / markdown
      Reasoning block
      Tool part summary
      AgeWork Process Panel
        Tool process timeline
        Tool args/result
        Runtime warnings
        Raw event links
  Composer
```

说明：

- assistant-ui `ToolFallback` 可以继续显示 tool part summary。
- AgeWork Process Panel 显示完整过程。
- tool process 不需要强行塞进 assistant-ui content。
- 管理端 run detail 与会话页可以复用同一个 process projection。

## 状态规则

| 场景 | AgeWork store | assistant-ui runtime |
| --- | --- | --- |
| 新消息发送 | 立即写 optimistic user message | `onNew` callback 触发 |
| run started | `activeRunStatus=running` | `isRunning=true` |
| text chunk | 更新 assistant message projection | messages prop 更新 |
| tool start | 更新 tool process + assistant tool part | messages prop 更新 |
| tool args chunk | 更新 tool process argsText | messages prop 更新或只更新 process panel |
| tool result | tool process complete + assistant tool result | messages prop 更新 |
| requires action | `activeRunStatus=requires_action` | message status running/requires-action 按 UI 需要投影 |
| cancel | 标记 cancelling/cancelled | `isRunning=false` after terminal |
| error | canonical error event + visible error projection | assistant message status incomplete/error |

## 风险与处理

### Runtime API 变化

assistant-ui 的 ExternalStoreRuntime API 可能随版本变化。

处理：

- 只在 `useAgeWorkAgentRuntime` 一个文件里依赖 assistant-ui runtime API。
- AgeWork store 和 projections 不 import assistant-ui runtime internals。
- `ThreadMessage` shape 变化时只改 message projector。

### 双 projection 不一致

迁移期 `useAgUiRuntime` 和 AgeWork projector 可能生成不同 message。

处理：

- Phase 2 增加 shadow compare。
- 对同一 run 记录 projection diff。
- 先覆盖核心事件：text、reasoning、tool、error、cancel、permission。

### 性能

完整 canonical events 可能很大。

处理：

- 大 payload 用 `payloadRef`。
- 前端默认只加载 projection，不加载全部 raw events。
- raw trace 按需分页加载。
- text chunk 可以在 projection 层合并。

### 工具过程和 assistant message 重复

工具信息会同时出现在 assistant message 和 process panel。

处理：

- assistant message 只显示简要 tool summary。
- process panel 显示完整过程。
- 两者共用 `toolCallId` 关联。

## 测试计划

### Unit

- canonical event -> assistant message projection。
- canonical event -> tool process projection。
- tool args chunk 合并。
- result 缺失状态。
- cancel/user-steered 状态。
- RUN_ERROR visible message projection。

### Integration

- `useAgeWorkAgentRuntime` onNew/cancel/reload callbacks。
- stream event 应用到 store。
- history load + active run resume。
- permission question 刷新后恢复。

### Regression

- Claude text/reasoning/tool run。
- Codex text/reasoning/tool run。
- worker heartbeat timeout。
- persistent worker seq gap。
- frontend thread switch。

## 决策摘要

| 问题 | 决策 |
| --- | --- |
| 是否保留 assistant-ui | 保留 UI 和 ExternalStoreRuntime |
| 是否继续用 assistant-ui 数据层做事实源 | 不继续 |
| 是否保留 AG-UI | 短期保留，长期降级为兼容 projection |
| 工具过程放在哪里 | AgeWork tool process projection |
| 历史消息事实源是什么 | canonical event log + message projection |
| 刷新恢复靠什么 | messages projection + tool process projection + event cursor |

## 最终原则

```text
assistant-ui 是 UI 组件系统，不是 AgeWork 的 Agent runtime 数据层。

AG-UI 是 UI 协议兼容层，不是 AgeWork 的执行事实源。

AgeWork canonical events 才是 agent 执行、工具过程、排查诊断和恢复的核心。
```
