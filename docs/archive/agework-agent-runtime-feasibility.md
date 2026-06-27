# AgeWork Agent Runtime 可行性分析

> 状态：已归档。当前不建设自有 live Runtime 替换 `useAgUiRuntime`；本文仅作为历史方案和远期参考。
>
> 记录时间：2026-06-19

本文分析是否可以参考 assistant-ui 的 `react-opencode`、`react-pi` 和 `react-ag-ui` 实现，建设一个 AgeWork 通用 Agent Runtime。结论：**可行，而且适合渐进落地；但不应作为替换 AG-UI 的开局动作。**

相关文档：

- [AgeWork Agent Event Log 设计](./agework-agent-event-protocol-design.md)
- [Assistant UI 数据层重构设计](./assistant-ui-data-layer-refactor-design.md)
- [Agent 事件体系评审报告](./agent-event-system-review.md)
- [AG-UI 替换与 AgeWork Runtime 实施计划](./ag-ui-replacement-runtime-plan.md)

## 1. 结论

AgeWork 可以实现一个类似 `useOpenCodeRuntime` / `usePiRuntime` / `useAgUiRuntime` 的 `useAgeWorkAgentRuntime`。

推荐定位：

```text
assistant-ui primitives
        │
        v
useAgeWorkAgentRuntime
        │
        ├─ useExternalStoreRuntime
        ├─ useRemoteThreadListRuntime
        │
        v
AgeWorkThreadController
        │
        ├─ AgeWorkThreadState
        ├─ AssistantMessageProjection
        ├─ ToolProcessProjection
        ├─ RuntimeDiagnosticsProjection
        └─ AgentRuntimeExtras
        │
        v
AgeWork API / Event Stream / Event Log
```

这不是"不用 AG-UI"，而是把 AG-UI 从唯一 runtime path 降成可被兼容、可被替换、可被旁路验证的一种输入/输出。

推荐策略：

- 短期继续保留 `useAgUiRuntime`，不破坏现有聊天。
- 同时实现 AgeWork controller/store/projection，先做 shadow mode。
- 先让 AgeWork Runtime 消费现有 AG-UI live stream + Agent Event Log，不要求 adapter 立刻输出全新协议。
- 等 message projection parity 足够稳定，再用 feature flag 切到 `useAgeWorkAgentRuntime`。

## 2. 参考实现结论

### 2.1 `react-opencode`

参考文件：

- `reference-source-code/assistant-ui/packages/react-opencode/src/useOpenCodeRuntime.ts`
- `reference-source-code/assistant-ui/packages/react-opencode/src/OpenCodeThreadController.ts`
- `reference-source-code/assistant-ui/packages/react-opencode/src/openCodeThreadState.ts`
- `reference-source-code/assistant-ui/packages/react-opencode/src/openCodeMessageProjection.ts`

结构特点：

| 模块 | 职责 |
| --- | --- |
| `useOpenCodeRuntime` | 组合 `useRemoteThreadListRuntime` 和 `useExternalStoreRuntime` |
| `OpenCodeThreadController` | 管理 session、订阅 server events、提供 send/cancel/revert/fork 等命令 |
| `OpenCodeThreadState` | 保存 session、message、part、permission、question、pending user message |
| `openCodeMessageProjection` | 把 provider 原生 message/part 投影成 assistant-ui `ThreadMessage` |
| `openCodeExtras` | 暴露 permission/question/fork/revert 等 provider-specific 能力 |

关键启发：

- Runtime hook 不直接处理 provider event；它依赖 controller 的 state。
- Controller 负责 load、subscribe、send、cancel 和事件 reducer。
- Message projection 是纯函数，可测试，可和 controller 分开演进。
- Permission/question 不强塞进普通 message；pending interactions 单独存在 state/extras 中。

### 2.2 `react-pi`

参考文件：

- `reference-source-code/assistant-ui/packages/react-pi/src/runtime/usePiRuntime.ts`
- `reference-source-code/assistant-ui/packages/react-pi/src/runtime/ThreadController.ts`
- `reference-source-code/assistant-ui/packages/react-pi/src/runtime/threadState.ts`
- `reference-source-code/assistant-ui/packages/react-pi/src/runtime/messageProjection.ts`

结构特点：

| 模块 | 职责 |
| --- | --- |
| `usePiRuntime` | 每个 thread 拿 controller，使用 `useExternalStoreRuntime` 暴露给 assistant-ui |
| `PiThreadController` | 冷启动 `getThread`，运行时 `subscribe`，按事件 reducer 更新 state |
| `PiThreadState` | 保存 transcript、toolExecutions、hostUiRequests、queue、compaction、retry、contextUsage |
| `messageProjection` | 把 Pi transcript 合并成 assistant-ui message，工具结果按 `toolCallId` 配对 |
| `PiRuntimeExtras` | 暴露 queue、host UI、model/thinking setting、tool approval/resume |

关键启发：

- Controller 可以分 metadata/message subscriptions，降低高频 delta 对 UI 的压力。
- Snapshot 和 live event 可以共存：snapshot 用于恢复，live event 用于增量。
- 中途输入、steer/follow-up、host UI request 可以作为 runtime extras，而不是硬塞进通用 message。
- Projection 可以做结构共享，避免 streaming 时每个 chunk 都让整个 message tree 失去引用稳定性。

### 2.3 `react-ag-ui`

参考文件：

- `reference-source-code/assistant-ui/packages/react-ag-ui/src/useAgUiRuntime.ts`
- `reference-source-code/assistant-ui/packages/react-ag-ui/src/runtime/AgUiThreadRuntimeCore.ts`
- `reference-source-code/assistant-ui/packages/react-ag-ui/src/runtime/adapter/run-aggregator.ts`

结构特点：

| 模块 | 职责 |
| --- | --- |
| `useAgUiRuntime` | 用 `useExternalStoreRuntime` 暴露 AG-UI runtime core 的 messages/state |
| `AgUiThreadRuntimeCore` | 调 AG-UI `AbstractAgent`，处理 append/reload/cancel/resume/history |
| `RunAggregator` | 把 AG-UI events 聚合成 assistant-ui assistant message parts |

关键启发：

- AG-UI runtime 本身也是一个 external store runtime。
- `RunAggregator` 的价值在于 message projection，不等于系统事实源。
- 保留 `useAgUiRuntime` 能继续吃到上游维护的事件聚合能力。
- 如果 AgeWork 自己做 runtime，应该吸收这种聚合思想，但不要复制一份长期漂移的 fork。

## 3. AgeWork 当前现状

当前链路：

```text
Claude/Codex SDK
  -> packages/adapters 转 AG-UI events
  -> worker envelope(seq)
  -> API RuntimeEventProcessor
     -> SSE 原样转发 AG-UI events
     -> RuntimeMessageAggregator 后端聚合 message snapshot
     -> RunEvent 诊断摘要
     -> raw/agui JSONL trace
  -> web useAgUiRuntime
     -> assistant-ui live rendering
```

现状判断：

- `useAgUiRuntime` 在 live rendering 上工作正常，不需要为了架构洁癖立刻换掉。
- API 侧已经 fork 了一份 `RuntimeMessageAggregator`，这是长期漂移风险。
- raw SDK trace 和 AG-UI trace 已存在，但还没有统一成可查询、可恢复的 Agent Event Log。
- 工具过程、permission、worker retry、sandbox/runtime 状态不适合继续只依赖 AG-UI message snapshot。

## 4. 可行性判断

### 4.1 技术可行

assistant-ui 已经给了稳定接入点：

- `useExternalStoreRuntime`：应用持有 state/message，assistant-ui 只作为 UI runtime。
- `useRemoteThreadListRuntime`：远端 thread list + per-thread runtime。
- `extras`：暴露 AgeWork 自有能力，例如 permission、tool process、runtime status、retry、queue。
- `ThreadMessageLike` / `ExportedMessageRepository`：把自有 projection 交给 assistant-ui。

AgeWork 当前已经具备对应后端能力：

- conversation/thread 概念已有。
- run 状态和 active run 已有。
- worker envelope seq 已有。
- AG-UI live event 已有。
- raw SDK trace 已有。
- 只缺统一 controller/state/projection 和 Agent Event Log 索引。

### 4.2 产品上有意义

AgeWork 的差异不是再做一个普通 chat runtime，而是 Agent 运行系统：

- 要显示完整工具过程。
- 要支持 Docker/local/sandbox runtime 排查。
- 要支持 Claude/Codex 多 provider 统一。
- 要支持 permission/human-in-the-loop 恢复。
- 要支持 run detail、debug、raw event 链路。

这些能力不是 AG-UI runtime 的目标范围。AgeWork Runtime 有明确产品价值。

### 4.3 不适合一次性替换

不建议现在替换 AG-UI，原因：

- 当前 live chat 已经依赖 `useAgUiRuntime`，替换风险集中在消息聚合、history、resume、cancel、permission。
- AG-UI 事件已经覆盖 text/reasoning/tool 的核心 UI streaming，短期没有必要重写。
- 更紧迫的问题是事实源和排查链路，不是 wire protocol 名字。
- 替换 AG-UI 前需要 shadow compare，否则会引入大量 UI 行为回归。

## 5. 推荐设计

### 5.1 模块划分

建议新增前端模块：

```text
apps/web/src/lib/agework-agent-runtime/
  use-agework-agent-runtime.ts
  agework-thread-controller.ts
  agework-thread-state.ts
  reduce-agework-thread-state.ts
  project-assistant-messages.ts
  project-tool-process.ts
  agework-runtime-extras.ts
  agework-client.ts
  types.ts
```

职责：

| 模块 | 职责 |
| --- | --- |
| `useAgeWorkAgentRuntime` | 对 assistant-ui 暴露 `AssistantRuntime` |
| `AgeWorkThreadController` | load/subscribe/send/cancel/reload/resume，维护 per-thread state |
| `AgeWorkThreadState` | 保存 message projection、tool process、run status、pending action、diagnostics |
| `reduceAgeWorkThreadState` | 应用 AG-UI event / AgentEvent / snapshot |
| `projectAssistantMessages` | 生成 assistant-ui `ThreadMessage` |
| `projectToolProcess` | 生成完整工具过程 timeline |
| `ageworkRuntimeExtras` | 暴露 permission、debug、runtime status、raw links |
| `AgeWorkClient` | 封装 API / SSE / event cursor |

### 5.2 Runtime 输入

第一阶段 Runtime 可以同时接受两类事件：

```ts
type AgeWorkRuntimeInputEvent =
  | {
      kind: "agui";
      seq: number;
      event: unknown;
    }
  | {
      kind: "agent-event";
      event: AgentEvent;
    }
  | {
      kind: "snapshot";
      messages: ThreadMessage[];
      toolProcesses?: ToolProcessItem[];
      cursor?: string;
    };
```

这样能兼容现有 AG-UI stream，又能为 Agent Event Log 做准备。

### 5.3 Runtime state

```ts
type AgeWorkThreadState = {
  conversationId: string;
  runId?: string;
  loadState: "idle" | "loading" | "ready" | "error";
  runState: "idle" | "running" | "requires_action" | "cancelling" | "error";

  assistantMessages: readonly ThreadMessage[];
  toolProcesses: readonly ToolProcessItem[];
  diagnostics: readonly RunDiagnosticItem[];

  pendingActions: {
    permissions: Record<string, PermissionRequest>;
    questions: Record<string, QuestionRequest>;
  };

  eventCursor?: string;
  lastSeq?: number;
  lastError?: string;
};
```

### 5.4 与 AG-UI 的关系

短期：

```text
API SSE AG-UI events
        ├─ useAgUiRuntime       -> 当前 UI 渲染
        └─ AgeWork shadow store -> tool process / diagnostics / parity compare
```

中期：

```text
API SSE AG-UI events + AgentEvent
        -> AgeWorkThreadController
        -> useAgeWorkAgentRuntime
        -> assistant-ui UI
```

长期：

```text
Provider native events
        -> Agent Event Log
        -> AgeWork projections
        -> useAgeWorkAgentRuntime
        -> optional AG-UI compatibility output
```

关键原则：

- 不删除 AG-UI，先旁路验证。
- 不要求新 provider 一定实现 AG-UI，最终只需要输出 AgentEvent。
- 不让 AG-UI 的 `MESSAGES_SNAPSHOT` 成为事实源。
- 不让后端和前端长期维护两套 message aggregator。

## 6. 迁移计划

### Phase 0：保持现状，补 Event Log

- `useAgUiRuntime` 继续作为 live UI runtime。
- API 将 raw/agui/worker/runtime/control 统一写入 Agent Event Log。
- 前端 UI 行为不变。

验收：

- 每个 run 可查完整事件序列。
- `seq`、`messageId`、`toolCallId` 能关联 raw/agui/worker 事件。

### Phase 1：AgeWork shadow runtime

- 新增 `AgeWorkThreadController` 和 `AgeWorkThreadState`。
- 旁路消费现有 AG-UI stream 或 run events API。
- 实现 `projectToolProcess` 和 diagnostics。
- 不接管 assistant-ui message rendering。

验收：

- 工具过程面板可从 AgeWork state 展示完整过程。
- 刷新后可从 Event Log 恢复 tool process。
- 不影响当前 chat。

### Phase 2：message projection parity

- 实现 `projectAssistantMessages`。
- 与 `useAgUiRuntime` 同 run 输出做 shadow compare。
- 覆盖 text、reasoning、tool-call、tool result、RUN_ERROR、cancel、requires_action。

验收：

- parity 差异可解释、可记录。
- 主要路径差异为 0 或可接受。

### Phase 3：feature flag 切换

- 新增 `useAgeWorkAgentRuntime`。
- 使用 `useExternalStoreRuntime` 对 assistant-ui 提供 messages/isRunning/onNew/onCancel/onReload。
- 通过 feature flag 选择 `useAgUiRuntime` 或 `useAgeWorkAgentRuntime`。

验收：

- 关闭 AG-UI runtime 后，聊天、历史、resume、工具展示正常。
- 出问题可以立即回退到 `useAgUiRuntime`。

### Phase 4：收敛重复聚合器

- 后端 `RuntimeMessageAggregator` 改名/重定位为 `AssistantMessageProjector`。
- live/history/resume 尽量共用同一 projection 语义。
- AG-UI 只保留为兼容输入/输出。

## 7. 总体建议

最终建议：

- **不替换 AG-UI 作为当前 live runtime。**
- **要做 AgeWork 通用 Agent Runtime，但从 shadow runtime 开始。**
- **先建 Agent Event Log，再做 tool process，再做 assistant message parity。**
- **AG-UI 是现有 UI wire/projection，AgeWork Runtime 是长期统一入口。**

这条路径能保留现有可用性，同时把系统核心逐步移到 AgeWork 自己能控制、能排查、能恢复的 runtime/data layer 上。
