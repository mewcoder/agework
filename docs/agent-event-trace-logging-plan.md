# Agent 事件追溯与日志体系改造计划

> 记录时间：2026-06-19
> 当前决策：暂不替换 AG-UI；Adapter 的执行留在 Worker；事件解释、追溯、诊断、日志口径逐步收回到平台/API。

相关文档：

- [Agent 事件体系评审报告](./agent-event-system-review.md)
- [AgeWork Agent Event Log 设计（修订版）](./agework-agent-event-protocol-design.md)

历史的 Assistant UI 数据层重构、AgeWork Runtime 可行性、AG-UI 替换方案已归档到 `docs/archive/`，不属于当前执行范围。

## 当前开发入口：Logging-only MVP

当前改造只做**日志体系**，不要启动 AG-UI 替换、Agent Runtime、Assistant UI 数据层、tool process UI 等工作。

开发时只使用本文以下部分：

- 第 3 节：当前基础件
- 第 6 节：日志口径
- 第 10 节：存储策略
- 第 7 节中的 Phase 2：重新整理日志打印
- 第 7 节中的 Phase 5：关键事件可靠性中与日志失败可见性相关的部分

本轮开发目标：

```text
统一 API/Worker 日志格式
明确 DB index 与 JSONL 文件分工
让每条关键日志都能用 runId / seq / source / eventType 定位
不改变 AG-UI live 流程
不改变 assistant-ui runtime
不新增工具过程 UI
```

本轮建议任务切分：

| 任务 | 范围 | 说明 |
| --- | --- | --- |
| L1 | Worker 结构化日志 | 改 `workerLog()` 输出 JSONL 字段，保留 stdout 简洁行 |
| L2 | API 日志口径 | 统一 envelope/control/runtime 日志摘要，不打印大 payload |
| L3 | 存储开关 | 将 DB index 和 raw payload 文件开关拆开语义 |
| L4 | 关键失败可见 | emit retry/failure、terminal status failure 写入可见日志 |

优先从 L1 + L2 开始，先不动数据库 schema；等日志字段稳定后，再决定是否新增 `AgentEvent` / `RunTraceEvent` 表。

## 1. 目标

本计划只解决当前系统的事件追溯与日志问题，不做 AG-UI 替换。

目标：

- 让一个 run 的完整过程可按时间线追溯：请求、runtime 启动、control 下发、worker 执行、SDK raw、AG-UI、run.status、错误、取消、permission、tool。
- 让日志和事件有同一套定位字段：`runId`、`conversationId`、`workspaceId`、`agentType`、`runtimeType`、`runtimeResourceId`、`seq`、`source`、`eventType`、`messageId`、`toolCallId`。
- 保留 AG-UI live runtime，继续让 `useAgUiRuntime` 驱动实时聊天。
- 把 AG-UI 降级为 `source: "agui"` 的 UI 域事件，而不是系统事实源。
- 将 worker 文件日志、API 日志、JSONL trace、RunEvent 诊断统一成可查询的追溯链路。

非目标：

- 不重写 `useAgUiRuntime`。
- 不把 `ClaudeAgentAdapter` / `CodexAgentAdapter` 整体搬进 API 进程。
- 不把所有 raw payload 都塞进数据库。
- 不用 snapshot 表达完整处理过程。

## 2. 当前事件链路

### 2.1 Run 请求链路

```text
Web useAgUiRuntime
  -> ChatHttpAgent POST /agent/run
  -> AgentRunHandler
     - threadId 作为 conversationId
     - 创建 runId / RunConfig
     - 创建 RuntimeMessageAggregator
  -> RuntimeRunner
     - 写 Run
     - provider.start()
  -> RuntimeProvider
     - local: fork worker
     - docker/sandbox: 启动或复用 persistent worker
```

### 2.2 Worker 上行事件链路

```text
Worker
  -> createAdapter()
     - ClaudeAgentAdapter / CodexAgentAdapter
     - trace sink 产生 sdk.raw
     - adapter observable 产生 agui.event
     - pendingAction sink 产生 run.status
  -> RuntimeTransport
     - IPC / HTTP / Persistent HTTP 分配 seq
  -> API RuntimeEventProcessor
     - seq 去重 / gap 检测
     - run.status 更新 Run / Conversation
     - agui.event 写 JSONL、写诊断、喂 RuntimeMessageAggregator、转 SSE
     - sdk.raw 写 JSONL、写诊断
  -> Web useAgUiRuntime
     - assistant-ui live 聚合渲染
```

### 2.3 Control 下行链路

```text
API
  -> RuntimeRunner.stop() / sendApprovalResolved()
  -> RuntimeProvider.sendControl()
     - local: child.send(control)
     - docker/sandbox: RuntimeControlQueue
  -> Worker poll / IPC receive
  -> adapter.interrupt() / resolveQuestion() / cancelQuestion()
```

当前 control 有 seq 和队列，但缺少闭环追踪：只能看到下发和部分 worker log，不能稳定回答"是否被拉取、是否被处理、处理是否生效"。

## 3. 当前基础件

| 能力 | 现状 | 问题 |
| --- | --- | --- |
| `RunEvent` 表 | 存摘要诊断事件 | 字段少，最多 detail 取 200 条，不是完整事实源 |
| `RunEventRecordService` | 批量写诊断 | 队列满会丢 debug，payload 截断，适合摘要不适合事实 |
| `AgentEventLogService` | raw/agui JSONL | 可选开启，和 DB 索引弱关联 |
| `AgentEventTraceWriter` | Worker raw trace | 主要覆盖 SDK raw，不覆盖完整 worker/control 生命周期 |
| `workerLog()` | Worker 文件日志 | 文本行，和事件索引没有 eventId/payloadRef 关联 |
| `RuntimeEventProcessor` | 上行事件中心 | 是统一入口，但目前同时承担转发、聚合、诊断，缺少明确 trace 层 |
| 管理端 run detail | 展示诊断事件 | 不支持完整事件分页、过滤、payloadRef 查看 |

## 4. 目标模型

不要把日志体系做成第 4 套东西。目标是一条追溯脊柱，旁边挂不同视图。

```text
RuntimeEventProcessor / ControlQueue / Worker
        |
        v
Agent Trace Index              <- 小字段、可查、可分页、可筛选
        |
        +-- payloadRef --------> JSONL/blob/raw file
        |
        +-- Summary View ------> RunEvent timeline / 管理端摘要
        |
        +-- Tool Process ------> 工具过程视图
        |
        +-- Assistant Message -> 现有 RuntimeMessageAggregator 派生历史消息
```

建议实现上分两层：

| 层 | 作用 | 是否可丢 |
| --- | --- | --- |
| Agent Trace Index | 事实索引，记录每个关键事件和可定位字段 | Critical/Important 不可丢 |
| RunEvent Summary | 管理端摘要和概览 | 可由 Trace Index 派生或降级 |

数据库有两个选择：

| 选项 | 说明 | 建议 |
| --- | --- | --- |
| 扩展现有 `RunEvent` | 加 `conversationId/workspaceId/agentType/messageId/toolCallId/payloadPreview/reliability` 等字段，并调整丢弃策略 | 改动少，但会混合"事实"与"摘要" |
| 新增 `AgentEvent` / `RunTraceEvent` | `RunEvent` 保持摘要，新增表做完整事实索引 | 更清晰，推荐 |

推荐：**新增事实索引表，保留 `RunEvent` 做摘要视图**。如果想先快跑，Phase 1 可以先扩展 `RunEventRecordService` 的入参和查询 API，后续再迁移到独立表。

## 5. 统一事件字段

第一版不要定义大而全的 Agent Runtime 协议，只定义追溯必需字段。

```ts
type AgentTraceRecord = {
  eventId: string;
  runId: string;
  conversationId: string;
  workspaceId: string;
  agentType: string;

  seq?: number;
  direction: "upstream" | "downstream" | "internal";
  source: "agui" | "sdk" | "worker" | "runtime" | "control" | "system";
  eventType: string;
  level: "debug" | "info" | "warn" | "error";
  reliability: "critical" | "important" | "normal" | "debug";

  messageId?: string;
  toolCallId?: string;
  parentMessageId?: string;
  commandId?: string;

  occurredAt?: string;
  observedAt: string;

  title?: string;
  summary?: string;
  payloadPreview?: string;
  payloadRef?: string;
};
```

字段原则：

- `seq` 使用 transport envelope seq；control seq 和 upstream seq 要通过 `direction` 区分。
- 大 payload 走 `payloadRef`，DB 只存摘要和短预览。
- `messageId/toolCallId/commandId` 是排查关键字段，必须从 AG-UI/control payload 中提取。
- 所有 API/worker 日志都尽量带 `eventId` 或至少带 `runId + seq + source + eventType`。

## 6. 日志口径

### 6.1 日志分层

| 类型 | 用途 | 载体 |
| --- | --- | --- |
| App log | 给开发者看系统运行状态 | Nest logger / worker stdout |
| Worker log | Worker 本地诊断，容器/本机均可落文件 | JSONL worker log |
| Agent trace | 给用户和管理端追溯 run 过程 | DB index + payloadRef |
| Raw payload | 大对象、SDK 原始消息、完整 AG-UI payload | JSONL/blob/file |

### 6.2 规则

- App log 不打印大 payload，只打印摘要。
- Agent trace 负责可查询事实，不依赖 console log。
- Worker log 改为结构化 JSONL，保留人类可读 message，但字段固定。
- 所有日志统一走 redaction：`apiKey`、`authorization`、`token`、`cookie`、`password`、`secret` 必须脱敏。
- `debug` 可以抽样或截断；`critical/important` 不能静默丢。
- `RUN_ERROR`、terminal `run.status`、`permission.*`、control ack 必须同时进入 trace 和普通日志。

### 6.3 推荐事件命名

使用 `source + eventType`：

```text
runtime.starting
runtime.ready
runtime.start_failed
worker.started
worker.emit.retry
worker.emit.failed
worker.seq_gap
control.enqueued
control.delivered
control.received
control.handled
control.failed
agui.RUN_STARTED
agui.TOOL_CALL_START
sdk.raw
```

AG-UI 事件名保留原始大写作为域内 type，便于和现有 adapter/debug 对齐。

## 7. 分阶段计划

### Phase 0: 链路合同和字段冻结

周期：2-3 天。

任务：

1. 冻结 `AgentTraceRecord` 最小字段。
2. 明确 source/direction/reliability 枚举。
3. 明确 payload 存储策略：DB preview + JSONL/blob payloadRef。
4. 定义 trace 进入顺序：API 收到上行 envelope 后，先写 trace index，再做 SSE / aggregator / RunEvent summary。
5. 定义哪些事件必须记录，哪些可抽样。

验收：

- 文档中能按字段回答：一个 tool call 如何从 AG-UI 事件定位到 raw SDK 事件和 worker log。
- 不改 AG-UI live 行为。

### Phase 1: 统一上行事件索引

周期：1-1.5 周。

任务：

1. 新增 `AgentTraceRecordService`，或先扩展 `RunEventRecordService` 作为临时实现。
2. 在 `RuntimeEventProcessor.publish()` 入口统一记录 `run.status`、`agui.event`、`sdk.raw`、`heartbeat` 的 trace index。
3. 提取 AG-UI payload 里的 `messageId`、`toolCallId`、`parentMessageId`。
4. JSONL raw/agui 写入时带 `eventId`、`seq`、`source`、`eventType`。
5. `seq gap` 不只写 logger，还写 `worker.seq_gap` trace。
6. 管理端 run detail 增加分页接口，不再只取前 200 条。

验收：

- 任意 run 可按 `seq asc` 查询完整上行事件索引。
- `TOOL_CALL_START/ARGS/END/RESULT` 可以按 `toolCallId` 过滤。
- raw/agui JSONL 中的 payload 能通过 `payloadRef` 找到。

### Phase 2: 重新整理日志打印

周期：4-7 天。

任务：

1. 把 `workerLog()` 输出改为结构化 JSONL，同时保留 stdout/stderr 简洁行。
2. 固定 worker log 字段：`time/level/message/runId/conversationId/workspaceId/agentType/runtimeType/runtimeResourceId/seq/eventType/commandId/error`。
3. API 日志统一使用小摘要，禁止直接打印完整 envelope payload。
4. 将 `PersistentHttpClient` 的 emit retry/failure 记录为 `worker.emit.retry` / `worker.emit.failed` trace。
5. 为日志增加明确分类：`runtime`、`transport`、`control`、`adapter`、`trace`。
6. 把 `AGEWORK_AGENT_EVENT_TRACE_ENABLED` 的语义调整为"是否保留大 payload/raw 文件"，而不是"是否有事件索引"。

验收：

- 关闭 raw trace 时，DB trace index 仍存在。
- 开启 raw trace 时，可从管理端事件详情跳到 payloadRef。
- worker log 和 API trace 能用 `runId + seq` 对上。

### Phase 3: Control 闭环追踪

周期：1 周。

任务：

1. API 下发 control 时写 `control.enqueued`。
2. Worker poll 到 control 时写 `control.received`。
3. Worker 开始处理时写 `control.handling`。
4. `adapter.interrupt()`、`resolveQuestion()`、`cancelQuestion()` 完成后写 `control.handled`。
5. 处理失败写 `control.failed`，带 `commandId`。
6. 对 persistent worker 的 workspace 级 control，记录 scope：`workspaceId/runtimeResourceId/runId`。

验收：

- 一次取消能看到：UI 请求 -> control.enqueued -> control.received -> control.handled -> run.status.cancelled/error。
- 一次 approval 能看到：permission/request question -> approval_resolved enqueued -> received -> handled -> pendingAction cleared。
- control 重复命令能看到去重事件，而不是静默忽略。

### Phase 4: Tool Process 和 Diagnostics 视图

周期：1.5-2 周。

任务：

1. 实现 `ToolProcessProjector`，输入 trace index 中的 AG-UI/tool 事件。
2. 输出 `ToolProcessItem`：工具名、状态、argsText、resultPreview、开始/结束时间、duration、关联 eventIds。
3. 管理端 run detail 增加 tabs：`摘要事件`、`完整事件`、`工具过程`、`payload`。
4. 会话页可以先不改 live UI，只在需要时读取 tool process 历史。
5. Diagnostics 视图高亮：seq gap、emit failed、worker heartbeat timeout、RUN_ERROR、control failed。

验收：

- 刷新后仍能看到工具调用过程，而不是只有最终 assistant message。
- 工具 args JSON 解析失败时仍保留原始 `argsText`。
- 工具 result 缺失时能标记 `requires_action` 或 `incomplete`。

### Phase 5: 关键事件可靠性

周期：1 周。

任务：

1. 定义 reliability 等级并落到 trace。
2. terminal `run.status` 上报失败时，不允许只写 worker log 后继续清理。
3. persistent worker 对 critical event 失败增加本地 spool 或明确 run error。
4. HTTP transport 4xx/5xx 行为统一：critical 失败必须抛出并触发终态。
5. API `RuntimeEventProcessor` 检测 seq gap 后，管理端可见 warn。
6. `RunEventRecordService` 的丢弃策略不能影响 critical/important 事件。

验收：

- 网络短暂失败后，critical event 可重试成功或产生可见失败 trace。
- 终态事件丢失不会导致 run 永久 running。
- seq gap 在管理端明显可见。

### Phase 6: 收敛文档和测试

周期：3-5 天。

任务：

1. 更新事件体系文档，标记 AG-UI 保留路线。
2. 补充测试 fixtures：Claude text、Claude tool、Codex text、Codex tool、cancel、approval、worker emit retry。
3. 补 API 单测：trace index、payloadRef、seq gap、control lifecycle。
4. 补 worker 单测：structured workerLog、critical emit failure。
5. 补前端管理端测试：事件分页、过滤、tool process 显示。

验收：

- 任意一个新事件 source 都有文档和测试。
- live UI 行为与改造前一致。
- 管理端能定位到一次 run 的完整执行链路。

## 8. 优先级

建议优先顺序：

```text
1. Phase 0 字段冻结
2. Phase 1 上行事件索引
3. Phase 2 日志打印重整
4. Phase 3 control 闭环
5. Phase 5 critical 可靠性
6. Phase 4 tool process / diagnostics UI
7. Phase 6 测试和文档收敛
```

Phase 4 可以和 Phase 3/5 部分并行，但前提是 Phase 1 的 trace index 已稳定。

## 9. 风险和取舍

| 风险 | 说明 | 处理 |
| --- | --- | --- |
| 事件量变大 | text/reasoning/tool args delta 很多 | DB 只存索引，payloadRef 指向 JSONL/blob |
| 和现有 RunEvent 混淆 | 现在 RunEvent 是摘要，不是事实源 | 命名上区分 AgentTrace/RunEventSummary |
| Worker 日志过多 | persistent worker 长期运行 | log level + size limit + critical only 默认入文件 |
| control ack 需要 worker 改造 | 现在控制处理没有上行 ack | 先记录 received/handled，后续再做强 ack 协议 |
| raw trace 默认开启成本 | payload 可能大 | 默认开索引，不默认保留全部 raw payload |

## 10. 存储策略：数据库还是日志文件

结论：**混合存储**。数据库存"可查询索引和小摘要"，日志文件/blob 存"大 payload 和原始证据"。

不要二选一：

- 全入库：查询体验最好，但 text delta、tool args、SDK raw 会让 SQLite 快速膨胀，写入压力和清理成本高。
- 全入文件：写入便宜、保真好，但管理端无法高效筛选、分页、按 `toolCallId`/`commandId` 查，也难做权限控制。

### 10.1 数据库适合存什么

数据库应该存稳定、短小、常查的字段：

| 字段 | 原因 |
| --- | --- |
| `eventId` | 管理端详情、payloadRef、日志关联入口 |
| `runId/conversationId/workspaceId/agentType` | 权限、查询、关联 |
| `seq/direction/source/eventType` | 时间线排序和过滤 |
| `level/reliability` | 错误高亮和关键事件保护 |
| `messageId/toolCallId/commandId` | 定位消息、工具、控制命令 |
| `summary/payloadPreview` | 管理端列表不用打开大 payload |
| `payloadRef` | 指向文件/blob 中的完整内容 |
| `observedAt/occurredAt` | 计算耗时、排查乱序 |

默认入库事件：

- `run.status.*`
- `runtime.*`
- `worker.*`
- `control.*`
- `agui.RUN_*`
- `agui.TOOL_CALL_START/ARGS/END/RESULT`
- `agui.TEXT_MESSAGE_START/END`
- `agui.REASONING_* START/END`
- `sdk.raw` 的索引和摘要

可采样或合并的事件：

- 高频 `TEXT_MESSAGE_CONTENT`
- 高频 `REASONING_MESSAGE_CONTENT`
- 高频 `TOOL_CALL_ARGS` delta

这些事件至少保留索引策略要可配置：开发环境可全量，生产环境可按 run 开关、抽样或只写 payloadRef。

### 10.2 文件/blob 适合存什么

文件/blob 应该存大而完整、偶尔查看的内容：

| 内容 | 原因 |
| --- | --- |
| `sdk.raw` 完整 payload | 最大、最保真，排查时才打开 |
| 完整 AG-UI payload | 事件回放和 adapter debug |
| 大 tool args/result | 可能很长，不适合塞 DB |
| worker structured log JSONL | 长期运行 worker 的本地证据 |
| 截断前原文 | DB preview 只保存短摘要 |

第一版继续使用 JSONL 文件即可：

```text
runtime-log-dir/
  {conversationId}.raw.jsonl
  {conversationId}.agui.jsonl
  {conversationId}.worker.jsonl
```

后续如果要多机部署或对象存储，再把 `payloadRef` 从本地路径升级成 `blob://...` / `s3://...` / `storage://...`。

### 10.3 推荐写入规则

```text
每个事件先写 DB index
  - 小 payload 直接放 payloadPreview/payload
  - 大 payload 写 JSONL/blob，DB 只放 payloadRef
  - critical/important 写失败不能静默

raw payload 是否落文件由配置控制
  - DB index 默认开启
  - raw/agui full payload 可按环境或 run 开关开启
```

推荐配置语义：

| 配置 | 作用 |
| --- | --- |
| `AGENT_TRACE_INDEX_ENABLED` | 是否写 DB trace index，默认开启 |
| `AGENT_TRACE_PAYLOAD_ENABLED` | 是否保留完整 raw/agui payload，默认开发开、生产可关 |
| `AGENT_TRACE_PAYLOAD_MAX_FILE_MB` | 单文件大小限制 |
| `AGENT_TRACE_PAYLOAD_RETENTION_DAYS` | payload 文件保留天数 |

现有 `AGEWORK_AGENT_EVENT_TRACE_ENABLED` 建议逐步改名或重新解释为 `AGENT_TRACE_PAYLOAD_ENABLED`，避免误解成"关闭后连事件索引都没有"。

> Logging-only MVP 落地决定（L3）：保留 `AGEWORK_AGENT_EVENT_TRACE_ENABLED` 旧名，不改名。已在
> `agent-run-config-builder.ts` 的 `buildAgentEventTraceConfig` 与 `.env.example` 注释中重新解释语义：
> 该开关只控制 raw/agui 大 payload 是否落 JSONL 文件，DB 诊断索引（`RunEventRecordService` / `RunEvent`）
> 与本开关无关，始终记录。

### 10.4 管理端读取方式

管理端默认只读 DB index：

```text
GET /admin/runs/:id/events?source=agui&toolCallId=...
```

点击某条事件详情时，再通过 API 读取 payload：

```text
GET /admin/runs/:id/events/:eventId/payload
```

API 根据 `payloadRef` 读取 JSONL/blob，并做：

- 用户/管理员权限校验。
- payload 脱敏。
- 大小限制。
- 不直接暴露宿主文件绝对路径。

### 10.5 清理策略

数据库 index 保留时间应长于 payload 文件。

建议：

| 数据 | 保留策略 |
| --- | --- |
| DB critical/important index | 跟 Run 一起保留 |
| DB normal/debug index | 可按 workspace 或时间清理 |
| raw/agui payload file | 默认 7-30 天，或按大小滚动 |
| worker log file | 默认 7-30 天，超过大小截断/轮转 |

这样即使原始 payload 被清理，管理端仍能看到这个 run 发生过什么；只是无法打开完整原文。

## 11. 需要拍板的问题

1. 事实索引是新增 `AgentEvent`/`RunTraceEvent` 表，还是扩展现有 `RunEvent` 表？
2. 大 payload 存哪里：继续 JSONL 文件、SQLite blob/path、还是后续对象存储？
3. 管理端事件详情是否允许直接读取本机 JSONL payloadRef？
4. control 是否需要强 ack 协议，还是第一版只做 worker 上报 `control.handled`？
5. 会话页是否第一阶段就展示工具过程，还是先只在管理端展示？

推荐默认答案：

- 新增事实索引表，保留 `RunEvent` 做摘要。
- 第一版继续 JSONL 文件 + payloadRef。
- 管理端先读 API 返回的 payload preview，不直接暴露文件路径。
- 第一版做 `control.handled` 事件，不做强 ack 阻塞。
- 工具过程先在管理端落地，会话页后接。
