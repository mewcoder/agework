# AG-UI 替换与 AgeWork Runtime 实施计划

> 状态：已归档。当前执行路线是不替换 AG-UI，优先建设事件追溯与日志体系；本文仅作为历史方案和远期参考。
>
> 记录时间：2026-06-19

本文只讨论一种更激进的目标：AgeWork 自己实现 Runtime，并把 AG-UI 从核心链路中替换掉。结论是：**可做，但不是小改；推荐按可回退的 staged migration 做，不建议一次性拔掉 AG-UI。**

相关文档：

- [AgeWork Agent Runtime 可行性分析](./agework-agent-runtime-feasibility.md)
- [AgeWork Agent Event Log 设计](../agework-agent-event-protocol-design.md)
- [Assistant UI 数据层重构设计](./assistant-ui-data-layer-refactor-design.md)
- [Agent 事件体系评审报告](../agent-event-system-review.md)

## 1. 结论

如果目标是"前端不用 `useAgUiRuntime`，Worker 不产 AG-UI，平台不再依赖 AG-UI 聚合语义"，工程量是 **中大型重构**。

粗估：

| 范围 | 工程量 |
| --- | --- |
| 最小可用替换：Claude/Codex 文本、reasoning、tool-call、history、cancel 可跑 | 3-5 周 / 1 名熟悉代码的人 |
| 生产可替换：permission、resume、persistent worker、诊断、parity、回退完整 | 6-10 周 / 1 名熟悉代码的人 |
| 两人并行（后端/前端拆开） | 4-6 周，但前 1 周必须先锁协议和测试样本 |

风险等级：**高，但可控**。高风险不在"能不能写 Runtime"，而在 message projection、permission、resume、persistent worker multiplexing 和历史数据兼容。

## 2. 当前 AG-UI 依赖面

### 2.1 Worker

当前 worker 直接创建 `ClaudeAgentAdapter` / `CodexAgentAdapter`，adapter 输出 AG-UI events。

```text
Worker
  createAdapter()
    -> ClaudeAgentAdapter / CodexAgentAdapter
    -> adapter.run(input).subscribe(aguiEvent)
    -> emit { type: "agui.event", payload: aguiEvent }
```

涉及文件：

- `apps/worker/src/main.ts`
- `apps/worker/src/run-router.ts`
- `packages/adapters/src/claude/**`
- `packages/adapters/src/codex/**`
- `packages/shared/src/protocol/transport.ts`

### 2.2 API

API 接收 `agui.event`，做三件事：

- 原样转发 SSE 给 web。
- 用 `RuntimeMessageAggregator` 聚合 assistant-ui message snapshot。
- 记录 AG-UI 诊断摘要和 JSONL trace。

涉及文件：

- `apps/api/src/runtime/core/runtime-event-processor.ts`
- `apps/api/src/runtime/core/runtime-message-aggregator.ts`
- `apps/api/src/runtime/core/agent-event-log.service.ts`
- `apps/api/src/agent/agent-run-handler.ts`
- `apps/api/src/agent/run-agent-input.ts`

### 2.3 Web

Web 端使用 `useAgUiRuntime` 和 `HttpAgent`。

```text
ChatHttpAgent -> AG-UI SSE -> useAgUiRuntime -> assistant-ui messages
```

涉及文件：

- `apps/web/src/hooks/use-agent-chat-runtime.ts`
- `apps/web/src/lib/runtime/chat-http-agent.ts`
- `apps/web/src/lib/runtime/agent-middleware.ts`
- `apps/web/src/lib/runtime/thread-history-adapter.ts`
- `apps/web/src/lib/runtime/thread-list-adapter.ts`

### 2.4 Shared protocol

`RunConfig.input`、`ControlPayload.user_message.input`、`UpstreamMessage`、`AGUIEvent` 都带 AG-UI 边界痕迹。

涉及文件：

- `packages/shared/src/protocol/transport.ts`

## 3. 目标架构

### 3.1 替换后的链路

```text
Worker
  NativeAgentRunner
    -> Claude SDK/CLI native events
    -> Codex SDK/CLI native events
    -> permission/control bridge
  emit native.event / run.status / heartbeat

API / Platform
  native event ingest
    -> Agent Event Log
    -> AgeWork semantic projector
    -> assistant message projector
    -> tool process projector
    -> diagnostics projector
    -> optional AG-UI compatibility output

Web
  useAgeWorkAgentRuntime
    -> AgeWorkThreadController
    -> useExternalStoreRuntime
    -> assistant-ui primitives
```

### 3.2 不再由 AG-UI 承担的职责

| 当前由 AG-UI 承担 | 替换后 owner |
| --- | --- |
| live text/reasoning/tool event vocabulary | AgeWork semantic events |
| message aggregation | AssistantMessageProjector |
| frontend runtime | `useAgeWorkAgentRuntime` |
| history/resume snapshot shape | AgeWork projection API |
| tool-call status interpretation | ToolProcessProjector + AssistantMessageProjector |
| interruption / requires-action message status | AgeWork runtime state |

## 4. 新协议最小集合

替换 AG-UI 不需要一开始设计 50 个事件。最小可用集合：

```ts
type AgeWorkRunStreamEvent =
  | { type: "run.started"; runId: string }
  | { type: "run.completed"; runId: string; usage?: unknown }
  | { type: "run.failed"; runId: string; error: string }
  | { type: "run.cancelled"; runId: string }
  | { type: "message.started"; messageId: string; role: "assistant" }
  | { type: "message.delta"; messageId: string; delta: string }
  | { type: "message.completed"; messageId: string }
  | { type: "reasoning.started"; messageId: string; blockId: string }
  | { type: "reasoning.delta"; messageId: string; blockId: string; delta: string }
  | { type: "reasoning.completed"; messageId: string; blockId: string }
  | { type: "tool.started"; messageId: string; toolCallId: string; toolName: string }
  | { type: "tool.args.delta"; toolCallId: string; delta: string }
  | { type: "tool.args.completed"; toolCallId: string }
  | { type: "tool.result"; toolCallId: string; result: unknown; isError?: boolean }
  | { type: "tool.completed"; toolCallId: string }
  | { type: "permission.requested"; requestId: string; toolCallId?: string; payload: unknown }
  | { type: "permission.resolved"; requestId: string; decision: unknown }
  | { type: "runtime.status"; status: string; payload?: unknown }
  | { type: "native.raw"; provider: "claude" | "codex"; payloadRef?: string; payload?: unknown };
```

所有事件进入 transport envelope：

```ts
type AgeWorkEventEnvelope = {
  runId: string;
  conversationId: string;
  workspaceId: string;
  seq: number;
  ts: string;
  event: AgeWorkRunStreamEvent;
};
```

## 5. 分阶段实施

### Phase 0：协议和样本冻结

目标：先定义"替换后必须一致"的行为样本。

任务：

1. 保存 Claude/Codex 典型 raw event fixtures。
2. 保存当前 AG-UI runtime 输出的 assistant-ui message fixtures。
3. 定义 AgeWork event envelope 和最小 event union。
4. 定义 projection parity 标准。

验收：

- 有文本、reasoning、tool、tool error、RUN_ERROR、cancel、permission、resume 的 fixtures。
- 可以离线跑 projector 测试，不依赖真实 CLI。

估时：2-4 天。

### Phase 1：平台侧 projector 先行

目标：先不动 Worker，不动 Web 默认 runtime，只在 API 旁路生成 AgeWork projection。

任务：

1. `agui.event -> AgeWorkRunStreamEvent` 兼容转换器。
2. `AgeWorkRunStreamEvent -> assistant-ui ThreadMessage` projector。
3. `AgeWorkRunStreamEvent -> ToolProcessItem` projector。
4. API 存 Agent Event Log 索引。
5. 与当前 `RuntimeMessageAggregator` 做输出对比。

验收：

- 当前 AG-UI live stream 仍正常。
- 后端能用 AgeWork projector 重建 assistant message。
- tool process 可以从 event log 重建。

估时：1-2 周。

### Phase 2：Web `useAgeWorkAgentRuntime`

目标：实现自己的 Runtime，但先 feature flag，不默认替换。

任务：

1. `AgeWorkThreadController`：load/subscribe/send/cancel/reload/resume。
2. `AgeWorkThreadState` reducer。
3. `projectAssistantMessages` 接 assistant-ui `ThreadMessage`。
4. `projectToolProcess` 接处理过程面板。
5. `useAgeWorkAgentRuntime` 基于 `useExternalStoreRuntime`。
6. 复用现有 thread list adapter / conversation APIs。

验收：

- feature flag 开启后，普通聊天可用。
- 文本、reasoning、tool-call、RUN_ERROR、cancel 显示正确。
- 关闭 flag 可回到 `useAgUiRuntime`。

估时：1.5-3 周。

### Phase 3：Worker 改为 native runner

目标：Worker 不再创建 AG-UI adapter，而是只跑 Claude/Codex native runner。

任务：

1. 抽 `NativeAgentRunner` 接口。
2. 实现 `ClaudeSdkRunner`：输出 Claude `SDKMessage` / stream event。
3. 实现 `CodexSdkRunner`：输出 Codex `ThreadEvent`。
4. Worker transport 新增 `native.event`。
5. 保留 permission/control bridge。
6. API 实现 `native.event -> AgeWorkRunStreamEvent`。

验收：

- Worker 不 import `@ag-ui/client` / `@ag-ui/core`。
- Claude/Codex 都能跑完整 run。
- cancel / permission / terminal status 不回退。

估时：1.5-3 周。

### Phase 4：平台替代 AG-UI SSE

目标：前端默认走 AgeWork SSE，不再消费 AG-UI SSE。

任务：

1. `POST /api/v1/agent/run` 输出 AgeWork event stream。
2. history/resume 统一用 AgeWork projection。
3. 删除/降级 `ChatHttpAgent`、`agent-middleware` 的 AG-UI 依赖。
4. `RuntimeMessageAggregator` 改名为 `AssistantMessageProjector` 或删除。
5. 保留 `agui` compatibility endpoint/flag 一段时间。

验收：

- 默认路径不需要 `useAgUiRuntime`。
- 刷新后 running run 可续接。
- requires_action 可恢复。
- 关闭 AG-UI compatibility 后核心聊天可用。

估时：1-2 周。

### Phase 5：清理和降级 AG-UI

目标：AG-UI 不在核心链路，只保留兼容输出或完全删除。

任务：

1. 清理 shared protocol 里的 `AGUIEvent` 核心依赖。
2. 清理 adapters package 中 AG-UI adapter 或移动到 compatibility 包。
3. 清理 web `@assistant-ui/react-ag-ui` 使用。
4. 更新测试、文档和诊断 UI。

验收：

- `rg "@ag-ui|agui.event|useAgUiRuntime"` 只出现在 compatibility 和历史文档中。
- 新 provider 只需实现 native runner 或 AgeWork event runner。

估时：3-7 天。

## 6. 工程量拆分

| 模块 | 难度 | 估时 | 风险 |
| --- | --- | --- | --- |
| Event envelope / shared protocol | 中 | 2-4 天 | 命名和兼容 |
| Agent Event Log DB/索引/payloadRef | 中 | 4-7 天 | 大 payload 和分页 |
| native -> AgeWork projector | 高 | 1-2 周 | Claude/Codex 差异 |
| assistant message projector | 高 | 1-2 周 | 与 assistant-ui 行为 parity |
| tool process projector | 中高 | 4-8 天 | 状态缺口和错误恢复 |
| Web `AgeWorkThreadController` | 高 | 1-2 周 | streaming、resume、feature flag |
| `useAgeWorkAgentRuntime` | 中 | 3-6 天 | assistant-ui API 变化 |
| Worker native runner | 高 | 1-2 周 | persistent worker、permission、cancel |
| history/resume 改造 | 高 | 4-8 天 | active run 恢复 |
| AG-UI cleanup | 中 | 3-7 天 | 隐式依赖残留 |

## 7. 最大风险

### 7.1 Message projection parity

AG-UI runtime 的 `RunAggregator` 已经处理了文本分段、reasoning、tool args、tool result、status。自研后必须重建这些细节。

缓解：

- 用 fixtures 做 snapshot test。
- 先 shadow compare，不默认切换。
- 先覆盖核心路径，少量展示差异可接受。

### 7.2 Permission / human-in-the-loop

Claude `canUseTool` 是 runner 执行边界，不是普通 stream event。Worker 变薄后仍要保留 control bridge。

缓解：

- `permission.requested` 必须先入 Event Log。
- control response 必须有超时、取消、worker 退出处理。
- pending action 恢复必须单测覆盖。

### 7.3 Persistent worker multiplexing

当前 persistent worker 复用 adapter，并通过 `RunRouter` 复用 AG-UI threadId/conversationId 关系。换成 native runner 后要重新处理 runId/conversationId/sessionId 映射。

缓解：

- 先 single run 跑通，再 persistent。
- session map 和 run map 明确分开。
- terminal status 可靠上报必须保留强保证。

### 7.4 History / resume

现在刷新后通过后端 aggregator 的 streaming snapshot 续接。替换后需要 event cursor 或 projection snapshot。

缓解：

- 第一版保留 snapshot resume，不急着做完整 replay。
- active run 时先推当前 projection snapshot，再接后续 event。

## 8. 推荐路线

不要从"删 AG-UI import"开始。推荐顺序：

```text
1. Event fixtures + projector parity
2. API 旁路 AgeWork projection
3. Web shadow AgeWork runtime
4. Feature flag 切 useAgeWorkAgentRuntime
5. Worker native runner
6. 平台 native -> AgeWork 成为默认
7. AG-UI cleanup
```

这样替换是可回退的：

- Phase 1/2 出问题，不影响当前 AG-UI live runtime。
- Phase 3 出问题，可以让 Worker 继续发 AG-UI。
- Phase 4 出问题，可以 feature flag 回到 `useAgUiRuntime`。

## 9. 是否值得做

值得，但要把收益说清楚：

- 不是因为当前完全不能排查。
- 是为了减少 AG-UI 黑盒和双聚合路径。
- 是为了把 Worker 变成 native runner，把平台变成统一解释层。
- 是为了让 Claude/Codex/后续 provider 都进 AgeWork 自己的运行模型。

如果只是为了"事件追溯更完整"，优先做 Agent Event Log 即可；如果目标是"系统主控权回到 AgeWork"，那替换 AG-UI 是合理的中长期工程。
