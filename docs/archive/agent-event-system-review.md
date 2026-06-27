# Agent 事件体系评审报告

> 记录时间：2026-06-19

本文评审 AgeWork 当前 Agent 事件体系，重点覆盖 Claude/Codex adapter、worker transport、API runtime event processor、assistant-ui / AG-UI 渲染链路、历史消息持久化与排查诊断能力。

实施计划见：[Agent 事件追溯与日志体系改造计划](./agent-event-trace-logging-plan.md)。

核心结论：

- AG-UI 适合做实时 UI 事件协议，不适合作为系统审计事实源。
- assistant-ui message snapshot 适合做消息历史和刷新恢复，不适合表达完整 Agent 执行过程。
- AgeWork 需要自己的 canonical event log，作为完整排查、工具过程重放、状态恢复和跨 runtime 诊断的事实源。
- 工具调用过程必须保留细粒度事件，不能只依赖 snapshot。

## 术语边界

| 概念 | 作用 | 是否作为事实源 |
| --- | --- | --- |
| SDK raw event | Claude Code / Codex SDK 原始输出或业务 adapter 内部 trace | 是，排查需要 |
| AG-UI event | `RUN_STARTED`、`TEXT_MESSAGE_*`、`TOOL_CALL_*` 等 UI 协议事件 | 否，只是 UI 投影输入 |
| assistant-ui message snapshot | 聚合后的 assistant message content/status | 否，只是消息投影 |
| RunEvent | 当前数据库诊断摘要事件 | 目前不是完整事实源 |
| JSONL trace | 当前 raw/agui 文件日志 | 接近事实源，但未统一索引 |
| canonical event log | AgeWork 应定义的完整事件日志 | 是，目标事实源 |

## 当前事件链路

```text
Claude/Codex SDK
  -> adapter raw trace
  -> adapter 转 AG-UI events
  -> worker message(seq)
  -> API RuntimeEventProcessor
     -> SSE: 原始 AG-UI events 给 live UI
     -> RuntimeMessageAggregator: assistant-ui message snapshot
     -> RunEvent: 诊断摘要
     -> JSONL: raw/agui trace（可选）
  -> web useAgUiRuntime
     -> assistant-ui 聚合渲染文本、推理、工具调用
```

正常实时 run 下，前端接收的是原始 AG-UI event。工具调用显示依赖：

```text
TOOL_CALL_START
  -> TOOL_CALL_ARGS / TOOL_CALL_CHUNK
  -> TOOL_CALL_END
  -> TOOL_CALL_RESULT
```

这条 live 渲染路径是正确的。问题在于刷新恢复、历史消息和排查诊断现在逐渐退化成 snapshot 或摘要，无法完整表达工具调用过程。

## 当前实现位置

| 模块 | 文件 | 作用 |
| --- | --- | --- |
| adapter 转换 | `packages/adapters/src/claude/base/adapter.ts` | Claude SDK 输出转 AG-UI |
| adapter 转换 | `packages/adapters/src/codex/base/adapter.ts` | Codex SDK 输出转 AG-UI |
| worker 单 run | `apps/worker/src/main.ts` | adapter event 转 upstream message |
| worker persistent | `apps/worker/src/persistent-http-client.ts` | persistent worker 上报事件，按 runId 串行化 |
| API event processor | `apps/api/src/runtime/core/runtime-event-processor.ts` | seq 去重、转发 SSE、聚合、诊断入库 |
| message 聚合 | `apps/api/src/runtime/core/runtime-message-aggregator.ts` | AG-UI events 聚合为 assistant-ui message |
| 诊断摘要 | `apps/api/src/runtime/core/run-event-record.service.ts` | RunEvent 批量写库 |
| JSONL trace | `apps/api/src/runtime/core/agent-event-log.service.ts` | raw/agui 文件日志 |
| live runtime | `apps/web/src/hooks/use-agent-chat-runtime.ts` | `useAgUiRuntime` 接入 |
| frontend interceptor | `apps/web/src/lib/runtime/agent-run-interceptor.ts` | run settings、RUN_ERROR 可见化、gap loading |
| history/resume | `apps/web/src/lib/runtime/thread-history-adapter.ts` | 加载历史和进行中 run 快照续接 |

## 主要发现

### 1. Live 渲染方向正确

正常 run 时，API 转发原始 AG-UI events 给前端，assistant-ui 官方 runtime 负责聚合渲染。这个设计能支持流式文本、推理内容和工具调用过程。

应继续保持：

- live SSE 使用原始 AG-UI events。
- 工具调用使用 `TOOL_CALL_*` 细粒度事件。
- `MESSAGES_SNAPSHOT` 不参与 live UI 渲染。

### 2. Snapshot 不能表达完整处理过程

`MESSAGES_SNAPSHOT` 和 assistant-ui message snapshot 都只能表达某个时刻的消息状态。它们无法稳定表达：

- 工具从 start 到 args streaming 的完整过程。
- 每个 args chunk 的到达顺序和时间。
- 工具执行耗时。
- 工具结果对应哪个 SDK raw event。
- adapter 是否做过补偿、清理或错误转换。
- worker transport 是否出现 seq gap、retry、drop。

因此 snapshot 可以作为派生数据，但不能作为核心事件数据。

### 3. 后端 message aggregator 有上游漂移风险

`RuntimeMessageAggregator` 是 assistant-ui AG-UI 聚合器的后端改写版。它现在能聚合文本、推理、工具调用和 result，但它本质上是 UI message projection。

风险：

- assistant-ui 上游聚合逻辑变化时，后端 fork 可能不同步。
- 当前后端 aggregator 不覆盖所有 AG-UI 事件能力，例如 activity snapshot、部分 state delta、unknown/raw 事件等。
- 它只保留最终 tool part，不保留工具调用阶段事件。

建议定位：

- 保留它用于生成 assistant-ui 历史消息。
- 不再把它作为事件体系核心。
- 后续可以把它变成 canonical event log 的一个 projector。

### 4. RunEvent 是摘要时间线，不是完整事件日志

当前 `RunEvent` 更像管理端诊断摘要：

- payload 有截断。
- queue 满时会优先丢 debug。
- 管理端 detail 只取有限事件。
- 只记录挑选后的 AG-UI 事件，不记录每个 chunk。

这适合做管理端概览，但不适合“完整排查过程”。

### 5. JSONL trace 接近事实源，但未和系统事件统一

当前 raw/agui JSONL 的优点：

- 可保存较完整 payload。
- 对排查 SDK raw 和 AG-UI 转换有价值。
- 能避免大 payload 全进数据库。

问题：

- 需要 `AGEWORK_AGENT_EVENT_TRACE_ENABLED` 开启。
- agui JSONL 没有统一写入 transport message seq。
- 管理端没有直接按 run 展示完整 trace。
- DB `RunEvent.payloadRef` 没有成为 trace 文件索引入口。

建议保留 JSONL 或 blob 存储完整 payload，但需要用数据库事件索引统一串起来。

### 6. persistent worker 关键事件可靠性偏弱

persistent worker 已经按 runId 串行 emit，避免并发 POST 乱序，这是正确的。

但上报失败后，对部分场景只是写 worker log 后继续。对于以下事件，应该有更强保证：

- terminal `run.status.finished`
- terminal `run.status.error`
- terminal `run.status.cancelled`
- `RUN_ERROR`
- `TOOL_CALL_START`
- `TOOL_CALL_RESULT`
- control ack / approval resolved

这些事件丢失会直接导致状态卡住、工具过程断裂或排查链缺失。

## 目标架构

建议把事件体系拆成四层。

```text
                +------------------------+
SDK / Worker -> | Canonical Event Log    | <- control / runtime status
                +------------------------+
                         |
          +--------------+--------------+
          |              |              |
          v              v              v
   AG-UI Live      Tool Process     Assistant Message
   Stream          Projection       Projection
   实时渲染         工具过程视图       历史消息 / resume
```

### 1. Canonical Event Log

AgeWork 自己定义完整事件日志，作为事实源。

每条事件建议包含：

| 字段 | 说明 |
| --- | --- |
| `id` | 事件 ID |
| `runId` | run ID |
| `conversationId` | conversation ID |
| `workspaceId` | workspace ID |
| `agentType` | `claude` / `codex` |
| `seq` | transport message seq，按 run 单调递增 |
| `source` | `sdk` / `adapter` / `agui` / `runtime` / `control` / `worker` |
| `eventType` | 事件类型 |
| `level` | `debug` / `info` / `warn` / `error` |
| `messageId` | AG-UI/assistant message ID，可空 |
| `toolCallId` | 工具调用 ID，可空 |
| `parentMessageId` | 父消息 ID，可空 |
| `ts` | worker 或 API 观察时间 |
| `summary` | 管理端摘要 |
| `payloadRef` | 完整 payload 文件/blob 引用 |
| `payloadPreview` | 可选短预览 |

原则：

- DB 存索引、摘要和小 payload。
- 大 payload 写 JSONL/blob，用 `payloadRef` 关联。
- 所有投影都能从 canonical event log 重建。
- UI snapshot 不是事实源。

### 2. AG-UI Live Stream

继续作为实时渲染协议。

规则：

- 正常 live SSE 转发原始 AG-UI events。
- 不用 `MESSAGES_SNAPSHOT` 驱动 live UI。
- 允许 API 过滤只会导致重复渲染的 snapshot 类事件。
- 事件进入 SSE 前必须已经进入 canonical event log。

### 3. Tool Process Projection

新增工具过程投影，用于“处理过程”面板和排查。

输入：canonical events。

输出示例：

```ts
type ToolProcessItem = {
  toolCallId: string;
  toolName: string;
  status: "running" | "complete" | "error" | "cancelled" | "requires_action";
  parentMessageId?: string;
  startedAt?: string;
  argsCompletedAt?: string;
  endedAt?: string;
  resultAt?: string;
  durationMs?: number;
  argsText?: string;
  resultPreview?: string;
  rawEventRefs: string[];
  aguiEventRefs: string[];
};
```

这个 projection 应该能回答：

- 哪个工具开始了？
- 参数是如何流式生成的？
- 参数什么时候结束？
- 工具有没有 result？
- result 是成功、错误还是等待用户？
- 关联了哪些 SDK raw event？
- 哪个阶段耗时最长？

### 4. Assistant Message Projection

保留 assistant-ui message projection，用于：

- conversation 历史消息。
- 刷新后的当前渲染态恢复。
- assistant-ui runtime 兼容。

但它必须被视为派生数据：

- 可以从 canonical event log 重建。
- 不能作为完整排查依据。
- 不能替代 tool process projection。

## `MESSAGES_SNAPSHOT` 的建议定位

当前 adapter 会发 `MESSAGES_SNAPSHOT`，API 会过滤，不转发给 SSE。注释里提到 server-side aggregation/persistence，但后端 aggregator 实际不消费它。

建议明确策略：

| 选项 | 建议 |
| --- | --- |
| 作为 live UI 输入 | 不建议 |
| 作为历史消息事实源 | 不建议 |
| 作为 adapter 调试事件 | 可以保留，但标为 debug |
| 彻底删除 | 可在 canonical event log 稳定后考虑 |

近期建议：

- 不让 `MESSAGES_SNAPSHOT` 进入核心链路。
- 如果保留，写入 canonical log，标记为 `source=adapter`、`eventType=MESSAGES_SNAPSHOT`。
- 文档中明确它不是 AgeWork 的执行过程事实源。

## 重构路线

### Phase 1: 统一事件索引

目标：让每个 run 都有可分页、可查询、可关联 payload 的完整事件索引。

建议任务：

1. 扩展 `RunEvent` 或新增 `RunTraceEvent`。
2. 统一记录 `seq`、`source`、`eventType`、`messageId`、`toolCallId`、`payloadRef`。
3. API 收到 upstream message 后，先写 canonical index，再做 SSE 转发和 projection。
4. agui JSONL 写入时带上 envelope seq。
5. 管理端 run detail 支持分页加载完整事件，不只取前 200 条。

### Phase 2: 工具过程 projection

目标：刷新后也能看到完整工具过程，而不是只看到当前 tool part。

建议任务：

1. 实现 `ToolProcessProjector`。
2. 从 canonical events 聚合 tool process items。
3. 管理端 run detail 增加工具过程视图。
4. 会话页“处理过程”面板可以从 projection 恢复历史过程。
5. 覆盖 Claude / Codex 两种 adapter 的工具事件。

### Phase 3: message projection 降级为派生数据

目标：把 assistant-ui message snapshot 从核心链路中降级。

建议任务：

1. 保留 `RuntimeMessageAggregator`，但文档上定义为 `AssistantMessageProjector`。
2. 增加从 canonical events 重建 assistant message 的能力。
3. 刷新 resume 仍可用 snapshot 恢复当前状态，但完整过程从 canonical log 加载。
4. RUN_ERROR 可见消息由后端 projection 或 canonical error event 稳定生成，不只依赖前端 interceptor。

### Phase 4: 关键事件可靠性

目标：关键事件不能静默丢失。

建议任务：

1. 给 upstream event 定义可靠性等级。
2. terminal run.status 上报失败时，worker 必须进入明确失败路径。
3. persistent worker 对关键事件失败应保留本地 spool 或触发 run error。
4. API 检测 seq gap 后记录 warn 事件，并在管理端高亮。
5. control 下发、poll、处理、ack 形成闭环事件。

## 事件可靠性分级

| 等级 | 事件 | 策略 |
| --- | --- | --- |
| Critical | terminal `run.status`、`RUN_ERROR`、control ack | 失败不能静默，必须重试或进入错误态 |
| Important | `TOOL_CALL_START`、`TOOL_CALL_RESULT`、permission question | 尽量可靠，失败要能在 trace 中看到 |
| Normal | text/reasoning chunks | 可压缩、可抽样，但 live UI 仍需要流式 |
| Debug | SDK raw 大 payload、snapshot debug | 可落文件，可截断 |

## 测试建议

需要补的关键测试：

- 工具完整事件顺序：start -> args chunks -> end -> result。
- 工具 args JSON 解析失败时仍保留 `argsText`。
- 工具 result 晚到或缺失时的状态。
- permission question 没有 `TOOL_CALL_RESULT` 时的 pending UI。
- RUN_ERROR 可见消息刷新后仍可恢复。
- cancel / user_steered 后工具过程状态正确。
- persistent worker emit retry 后 seq 不乱序。
- API 检测 seq gap 并写入诊断事件。
- canonical events 能重建 assistant message projection。
- canonical events 能重建 tool process projection。

## 当前建议

近期不要把精力放在 `MESSAGES_SNAPSHOT` 上。它不是 AgeWork 需要的核心能力。

更有价值的方向是：

1. 先定义 AgeWork canonical event schema。
2. 把 raw/agui/runtime/control 统一成可查询事件索引。
3. 在这个事实源上做 tool process projection。
4. 再把 assistant-ui message snapshot 变成纯派生投影。

一句话原则：

```text
AG-UI 负责“实时怎么显示”，assistant-ui snapshot 负责“消息当前状态”，AgeWork canonical events 负责“事实到底发生了什么”。
```
