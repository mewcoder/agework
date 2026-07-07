# RunEvent v2 大爆炸重构设计

> 日期：2026-06-22  
> 决策：不兼容历史 `RunEvent` 数据。允许直接重建 schema、类型、writer、查询和管理端展示语义。  
> 目标：把事件体系从“诊断摘要 + 模糊 raw trace”重构为清晰的 `RunEvent + Message + Raw JSONL` 三层，服务 run 回溯、审计、恢复和后续投影。

---

## 0. 落地进度与剩余计划（2026-07-07 盘点，交接看这里）

设计主体已在 6-7 月的重构中落地，本节是对照代码的销账表 + 剩余工作计划。下文 §1-§19 是原始设计，**与本节冲突时以本节为准**（差异见 0.3）。

### 0.1 已落地（不再重复做）

| 设计章节 | 现状 |
| --- | --- |
| §5 Prisma schema v2 | 已落地，`apps/server/prisma/schema.prisma` `RunEvent` 与设计逐字段一致（runSeq/eventKey/type/origin/target/chain/refs + 全部索引） |
| §6 TypeScript 类型 | 已落地，`packages/shared/src/protocol`（`RecordRunEventInput`/`RunEventRefs`/`RunEventRecord` 等） |
| §10.2 runSeq 分配 | 已落地，`run-event/seq/run-event-seq.store.ts` per-run 串行 + 内存计数器 + DB max 回退 |
| §5.3 eventKey 幂等 | 已落地，`run-event.repository.ts` `insertOrGetByEventKey`（P2002 幂等返回） |
| §11 Processor 拆分 | 已落地：`WorkerEventService`（seq 闸门+分发）、`RunStatusService`、`WorkerAgUiEventHandler`、`WorkerSeqStore`。命名与设计不同（无 `RunEventRecorder`/`StateUpdater` 后缀），职责边界一致，不再 rename |
| §8 事件 type（大部分） | 已落地：run.created / run.status_changed / runtime.status_changed / message.accepted/started/completed / tool.started/completed/failed / command.sent/handled/failed/result / system.issue（builder 全在 `run-event.service.ts`） |
| §9 Raw JSONL 写入 | **已存在**（worker 侧）：`packages/worker/src/logging/trace.ts` `TraceLogWriter` 写 sdk.raw 全量 + AG-UI 全量 JSONL，带 envelope/脱敏/单文件上限；路径 `{conversationId}.raw.jsonl`/`{conversationId}.agui.jsonl`，落在 `runtimeLogDir`（sandbox 场景 bind mount 到宿主机，`docker-runtime.provider.ts`；local 场景本就是宿主机目录），容器销毁文件仍在 |
| §15.1 Admin RunEvent list | 已落地，`run-event.repository.ts` `listAdminEvents`（type/typePrefix/origin/target/chain/refs/runSeq range 过滤） |
| §16 时间线 UI（基础） | 已落地，`apps/web/src/pages/admin/run/run-event-timeline.tsx` |

### 0.2 剩余工作

**决策项：trace 默认开关 — 已定案，2026-07-07 落地。** `getAgentEventTraceConfig()` 默认改为开启，靠 `maxFileMb` 上限兜底磁盘；env 设为 `false`/`0`/`no`/`off` 才关闭。

**Phase A：补审计事件 — 已完成，2026-07-07。**

| 事件 | emit 点 | 备注 |
| --- | --- | --- |
| `permission.requested` | `run-status.service.ts apply()`，`effect.persistenceAction === "markRequiresAction"` 时 | 无独立 `permissionRequestId`（域内本无该概念）；用 `chainId=runId` 串联，符合"单 run 同一时刻只有一个 pending action"的现状不变量 |
| `permission.resolved` | `RunService.reply()`，下发 `approval_resolved` 命令后 | 未记录具体 answers 内容（避免把用户自由文本答案写进审计 data） |
| `message.failed` | `run-status.service.ts applyTerminalEffects()`，`effect.terminalMessageComplete !== true` 且 `handle.aggregator.build().messageId` 有值时 | 用真实存在的 in-flight messageId 信号，没有就不产生事件（不是每次 error/cancelled 都有未完成消息） |
| `worker.status_changed` | `WorkerEventService.notifyWorkerLost()` | 只做心跳超时 fence 这一个信号；"worker ready" 与 runtime.status_changed(ready) 重复，未重复记录 |

落地文件：`run-event.service.ts`（4 个新 builder）、`run-status.service.ts`、`run.service.ts`、`worker-event.service.ts`、`config.service.ts`（trace 默认开）。测试：`run-event.service.spec.ts`、`run-status.service.spec.ts`、`run.service.spec.ts`、`worker-event.service.spec.ts` 均补了对应用例。

**Phase B：raw 数据可查 — 已完成，2026-07-07。**

- `RawJsonlReader`（`run-event/raw/raw-jsonl-reader.ts`，internal provider，不 export）：按 conversationId 定位 jsonl 文件，线性扫描 + 按 runId/channel 过滤 + 分页；单行 JSON 解析失败跳过不中断。
- `RunEventService.listRawForAdmin()` 薄转发；`RunRepository.findConversationId()` 补的 runId→conversationId 查询；`RunService.listRawEventsForAdmin()` 编排（run 无 conversation 时返回空列表，不是错误）。
- **修过一个真 bug（2026-07-07）**：多 channel 合并最初是 `channels.flatMap(c => readChannel(c))`——只是把每个 channel 整份文件依次拼接（先全部 sdk.raw，再全部 agui.event），不是按时间合并成一条真正的时间线。补了 `.sort((a, b) => a.ts.localeCompare(b.ts))`，并在 `raw-jsonl-reader.spec.ts` 加了一条显式的跨 channel 交叉排序用例（避免下次改动又退化成"看起来对、其实只是巧合"）。
- 路由：`GET /api/v1/admin/runs/raw-events/list?runId=...`（`AdminRunController.listRawEvents` + `AdminRunRawEventsQueryDto`）。
- **前端已接（2026-07-07，最终定稿版：`run-detail-sheet.tsx` 第三个 tab）**：迭代了三版。
  1. 最初每条事件旁一个"查看原始日志"按钮、点击预填该事件关联 id 自动 narrow——用户反馈体验差（某些 id 如 commandId 根本不出现在原始日志里，narrow 完是空的）。
  2. 改成顶部工具栏一个入口 + `Dialog` 弹窗，全量展示 + 手动搜索框——用户反馈"还不如看完整时间线"，且弹窗内滚动实际不生效（`scrollHeight === clientHeight`，内容被 `overflow-hidden` 硬裁掉，翻不到后面的行）。
  3. **最终版**：接受用户建议，去掉 `Dialog`，改成跟"事件"“工具调用”平级的**第三个 tab**"原始事件"（新文件 `run-raw-events-view.tsx`，导出 `RunRawEventsView`，删除 `run-raw-events-dialog.tsx`）。挪进 `Tabs`/`TabsContent` 后 `ScrollArea + flex-1 + min-h-0` 这套写法才真正生效（`ToolCallProcessView` 早就是这么写、且工作正常的证据在先——问题出在 `Dialog` 的 `max-height` 不是"确定高度"，flex 子元素撑不满，Tabs 容器则是确定高度上下文）。每行日志默认收起只显示 `source`/`name`/时间戳 + "展开"按钮，点了才渲染完整 JSON（避免一次性渲染 32 条大 JSON 拖垮布局）。数据不分 channel，`sdk.raw` 和 `agui.event` 按时间顺序混排，标签区分来源。
  共享类型 `AdminRunRawEvent*` 加在 `packages/shared/src/api/runs.ts`。用 Playwright 反复验证：直接量 `scrollHeight`/`clientHeight` 和真实 `scrollTop` 变化确认滚动生效（而不是只看截图），控制台全程无报错。
- **§0 原计划提到的"remote runtime 不覆盖"是过时假设**：核实后当前只有 `local/docker/opensandbox` 三种 runtimeType，没有 remote；docker/opensandbox 场景 trace 文件本就 bind mount 回宿主机，接口对现有全部 runtimeType 都可用，未加任何"不可用"分支。

测试：`raw-jsonl-reader.spec.ts`（新增，临时目录真实文件 I/O）、`run.repository.spec.ts`、`run.service.spec.ts`、`admin-run.controller.spec.ts` 补了对应用例；前端无单测，靠上面的 Playwright 手工验证。

**Phase C：收尾 — 部分完成，`swallow → system.issue` 那条特意搁置。**

- ~~关键事实落库失败从纯 swallow 改为补记 system.issue~~ **搁置，不要在没有具体触发场景前实现**：`append()` 失败后再调 `append()` 写 `system.issue` 是同一条写路径的自调用，DB 系统性故障（连接池耗尽等）时会形成"失败→补记失败→再补记"的放大而非降级；要做的话需要一条独立于 seqStore 串行分配的旁路写入（或直接判定"不重试"），这是一个需要单独确认的设计决策，不是顺手能力所及的小改动。见 [[confirm-before-refactor]]。
- 本文档销账：本节（§0）已更新；§17 原改造清单仍描述"大爆炸"整体设想，不逐条对照勾选（那本来就是历史 6-22 版本的 checklist，销账口径以本节为准）。

### 0.3 与原设计的差异定案（不按原文做）

- **命名**：`control.*` 按代码现状定为 `command.*`；`RunEventRecorder`/`RawJsonlWriter`/`StateUpdater` 等设计名不落地，保留现有 `RunEventService`/`TraceLogWriter` 等实现名。
- **Raw JSONL 形态**：保留 per-conversation 文件 + 现有 envelope，不改成 §9.3 的 per-run 目录、不加 `rawSeq`（行内 ts + runId 已够定位）、不拆 tool/runtime/system 等 channel。
- **不做**：stream chunk 单独落盘策略调整、Raw JSONL 独立索引、remote runtime raw 拉取。

---

## 1. 核心结论

AgeWork 不再引入独立 `AgentEvent` 概念。事件体系统一为：

```text
RunEvent
  run-scoped structured key event log
  关键事件事实源，按 runSeq 排序，可查询、可过滤

Message
  assistant-ui conversation history read model
  UI 回显投影，高频读取，不承担完整事实源职责

Raw JSONL
  provider raw / AG-UI stream / runtime/worker/system records / large tool output
  原始流水账，按 run 追加写文件；不是结构化事件模型
```

`RunEvent` 是“这个 run 的关键事实是什么”的结构化事实源；`Message` 是“UI 应该怎么回显”的读模型；`Raw JSONL` 是“需要保留原始流水时，原文按行放在哪里”的文件日志。

---

## 2. 为什么大爆炸

当前事件体系的概念边界混在一起：

| 当前对象 | 当前问题 |
| --- | --- |
| `RunEvent` | 更像诊断摘要，字段少，data 截断，queue 会丢低价值日志，不适合作为事实源 |
| `AgentEventLogService` | 名字像事实源，实际职责是写 raw/agui JSONL |
| `RuntimeEventProcessor` | 同时负责 seq 去重、状态更新、SSE、message 聚合、RunEvent、raw trace |
| `Message` | 必备 UI 投影，但容易被误用成事实源 |
| AG-UI event | 适合 live UI wire protocol，不适合表达 worker/control/runtime/raw 全部事实 |

不兼容历史数据后，v2 可以直接改成正确形态，不保留旧 `seq/source/type/data` 的歧义。

---

## 3. OpenHands 可吸收机制

OpenHands 值得吸收的是机制，不是字段照搬：

1. **Append-only**：事件只追加，不回改。修正状态靠追加新事件。
2. **Event -> State/View**：状态和 UI 是投影，不是事实源。
3. **Action / Observation 配对**：工具调用有请求和结果，用 id 串起来。
4. **Callback chain**：agent 只 emit event，持久化、广播、可视化由外层消费者接上。
5. **Streaming delta 分离**：流式 token 不进结构化事件表，直接写 Raw JSONL 或只走实时通道。
6. **SQL 存关键事件，JSONL 存原始流水**：关键事件进 DB，大 data / provider raw / stream 进 JSONL。

AgeWork 的落地方式：

```text
Worker / Runtime envelope
  -> RuntimeEventProcessor normalize
  -> RunEventRecorder append structured event
  -> RawJsonlWriter append raw/stream lines when needed
  -> internal state writers update Run / Conversation / Message / SSE
```

---

## 4. 模型边界

### 4.1 `RunEvent`

职责：

- run 内关键执行链路的结构化事实源。
- 覆盖从用户请求被接受、run 创建、runtime 准备、agent 执行、tool/permission/control、直到 terminal status 的关键边界。
- 支持按 run 时间线回溯。
- 支持按 tool/message/control/permission/session 定位。
- 支持后续视图：diagnostics、tool timeline、message timeline、callback。

不负责：

- 不保存所有 provider 原始 data。
- 不保存每个 token delta 的完整内容。
- 不直接作为 assistant-ui message。

### 4.2 `Message`

职责：

- conversation history / assistant-ui 回显。
- 刷新页面后快速恢复消息列表。
- 保存最终或阶段性 assistant-ui content parts。

不负责：

- 不表达完整工具生命周期。
- 不表达 worker/control/runtime 诊断。
- 不作为审计事实源。

### 4.3 `Raw JSONL`

职责：

- 按 run 追加写原始 SDK event。
- 按 run 追加写 AG-UI stream/chunk event。
- 按 run 追加写大 tool output、完整 reasoning data。
- 每行带标准索引字段，方便按 ID 回查。

不负责：

- 不提供高频查询。
- 不作为管理端默认列表数据源。
- 不要求普通用户可见。

这里没有独立的 data store。只有两条硬规则：

```text
关键事件    存 RunEvent
流/原始事件  直接追加 Raw JSONL
```

Raw JSONL 不是裸写任意 JSON。每一行外面都有标准 envelope，至少带 `runId/channel/recordType/rawSeq/createdAt`，能带就带 `transportSeq/target/chainId/refs`。因此回查原文主要靠同一套 ID 搜索，不在 `RunEvent` 主表里存文件行号。

### 4.4 RunEvent 是否覆盖完整链路

是，但这里的“完整”指关键执行链路完整，不是所有字节完整。

`RunEvent` 至少覆盖这些阶段：

| 阶段 | 必须进入 RunEvent 的关键事件 |
| --- | --- |
| 用户输入被接受 | `run.created` + `message.accepted`，关联 user message（见下方说明） |
| run 状态 | `run.status_changed`，具体状态放 `data.status` |
| runtime 准备 | `runtime.status_changed`，具体状态放 `data.status` |
| worker/transport | `worker.status_changed`；异常统一 `system.issue` |
| agent/message | `message.started`、`message.completed`、`message.failed` |
| tool | `tool.started`、`tool.completed`、`tool.failed` |
| permission | `permission.requested`、`permission.resolved`，结果放 `data.decision` |
| control | `control.sent`、`control.handled`、`control.failed` |
| message 写入/同步 | 只在失败或不一致时写 `message.write_failed` 或 `system.issue` |
| terminal | `run.status_changed`，`data.status` 为 `finished/error/cancelled` |

不进入 `RunEvent` 的内容：

- 每个 token/text delta。
- 每个 tool args chunk。
- provider 原始 raw event 全量。
- 大 tool output 全文。

这些进入 Raw JSONL 或只走 live SSE。`RunEvent` 保存的是能解释“这个 run 为什么走到现在这个状态”的骨架。

`run.created` 与 `message.accepted` 的分工（避免和 §12.0 读起来矛盾）：

- 两条都写，不是二选一。`run.created` 是 run 这个对象的诞生（target=`run`），`message.accepted` 是这次输入被接受（target=`message`）。
- **时间线起点统一认 `run.created`**（runSeq 最小那条）。`message.accepted` 只是补出“输入是哪条 user message”，不单独当起点。
- 如果某条 run 没有 user message 输入（例如系统触发的 run），可以只有 `run.created`，没有 `message.accepted`。

---

## 5. Prisma schema v2

直接替换当前 `RunEvent` 字段。不兼容旧数据。

```prisma
model RunEvent {
  id                  String   @id @default(cuid())

  runId               String
  run                 Run      @relation(fields: [runId], references: [id], onDelete: Cascade)

  /// AgeWork 分配，run 内严格单调递增。所有 RunEvent 必须有。
  runSeq              Int

  /// 幂等键，用于抵抗 retry/重复写入。可空。
  eventKey           String?

  /// AgeWork 归一化后的关键事件类型。不要直接塞 AG-UI/SDK 原始类型。
  type                String

  /// 事件来源责任边界：platform/agent/worker。
  origin              String

  /// 这条事件主要描述的对象。大多数事件只需要一个 primary target。
  targetType          String?
  targetId           String?

  /// 用于把一组相关事件串起来，如同一次 tool call/control command/request chain。
  chainId             String?

  /// 次要关联 ID，如 messageId/toolCallId/commandId/sessionId/providerRequestId。
  refs                Json?

  summary             String?
  data                Json?

  /// AgeWork 创建并持久化这条关键事件的时间。
  createdAt          DateTime @default(now())

  @@unique([runId, runSeq])
  @@unique([runId, eventKey])
  @@index([runId, runSeq])
  @@index([runId, type, runSeq])
  @@index([runId, origin, runSeq])
  @@index([runId, targetType, targetId, runSeq])
  @@index([runId, chainId, runSeq])
  @@index([type, createdAt])
}
```

### 5.1 字段语义

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `runSeq` | 是 | AgeWork 自己的 run 内顺序，所有事件统一排序用它 |
| `eventKey` | 否 | 幂等键，用于抵抗 retry/重复写入 |
| `type` | 是 | AgeWork 归一化事件类型，点号命名 |
| `origin` | 是 | 事件来源责任边界：`platform/agent/worker` |
| `targetType` | 否 | 事件主要对象类型，如 `message/tool_call/command/permission_request/session` |
| `targetId` | 否 | 事件主要对象 ID，和 `targetType` 一起用于通用过滤 |
| `chainId` | 否 | 把一组因果相关事件串起来的 ID |
| `refs` | 否 | 次要关联 ID 容器，不把每种 ID 都升格成列 |
| `data` | 否 | 小结构化 data，写入前脱敏和限长。大内容不进这里 |
| `createdAt` | 是 | AgeWork 创建并持久化事件的时间 |

### 5.2 字段分组

`RunEvent` 字段按职责分成四组：

| 分组 | 字段 | 用途 |
| --- | --- | --- |
| 顺序/幂等 | `runSeq`、`eventKey` | 保证时间线稳定，避免重复写 |
| 分类/责任 | `type`、`origin` | 说明发生了什么、来自哪条责任边界 |
| 关联/定位 | `targetType`、`targetId`、`chainId`、`refs` | 串起 message/tool/control/permission/session |
| 展示/细节 | `summary`、`data` | 管理端列表、诊断、轻量详情 |
| 时间 | `createdAt` | 统一按 AgeWork 落库时间解释 |

`type` 和 `origin` 不混用：

```text
type    这条事件是什么事实，例如 tool.completed、permission.resolved。
origin  这条事实来自哪条责任边界，例如 platform、agent、worker。
```

### 5.3 字段评审结论

保留：

| 字段 | 结论 |
| --- | --- |
| `runSeq` | 必须保留。RunEvent 时间线只认它排序。 |
| `eventKey` | 保留但可空。可重试场景必须填；普通内部事件可不填。 |
| `type` | 保留。一个字段表达事件事实，领域由前缀推导。 |
| `origin` | 保留。回答“这条事件来自哪条责任边界”。 |
| `targetType` + `targetId` | 保留。回答“这条事件主要关于谁”。 |
| `chainId` | 保留。串起同一次 tool/control/permission/request 链路。 |
| `refs` | 保留。放次要关联 ID，避免一堆 nullable ID 列。 |
| `summary` | 保留。管理端列表可读文本。 |
| `data` | 保留。只放小结构化事实，大内容去 Raw JSONL。 |
| `createdAt` | 保留。只保留 AgeWork 侧时间，避免多个时间字段互相打架。 |

删除：

| 字段 | 原因 |
| --- | --- |
| `level` | 日志等级，不属于关键链路模型。 |
| `importance` | 还是等级概念，容易把 RunEvent 变回日志表。 |
| `payloadPreview` | 和 `summary` 重复。需要 preview 时放进 `summary` 或小 `data`。 |
| `rawRef` / `payloadRef` | 原始流水靠 Raw JSONL 的标准 envelope + ID 查询，不塞进 RunEvent。 |
| `schemaVersion` | DB schema 由迁移管理；单行版本没有必要。Raw JSONL 将来需要版本时可在 raw envelope 加。 |
| `domain` | 可由 `type` 前缀推导，不单独占列。 |
| `meta` | 和 `data` 边界容易变模糊，第一版不设。 |
| `eventTime` | provider/native 时间进 Raw JSONL；RunEvent 只用 `createdAt`。 |
| `originId` | 具体实例 ID 放 `refs` 或 `data`，避免再造一套来源维度。 |

`eventKey` 的唯一约束只在有值时有意义。SQLite/Postgres 都允许多个 `NULL`，所以内部事件可以不填；可重试事件必须生成稳定 key，例如：

```text
control:{commandId}:{type}
permission:{permissionRequestId}:{type}
tool:{toolCallId}:{type}
```

`eventKey` 冲突的语义必须明确，否则会和 §10.2 的 seq 分配打架：

- **冲突 = 幂等成功，不是错误。** 命中 `@@unique([runId, eventKey])` 时不得抛错，不触发 §10.3 的“写入失败”路径。实现可以二选一：用 no-op upsert（例如 `ON CONFLICT (...) DO UPDATE SET eventKey = excluded.eventKey RETURNING *`）直接返回现有记录；或 `ON CONFLICT DO NOTHING` 后再按 `(runId, eventKey)` 查询已存在记录。
- **冲突会留下 runSeq 空洞。** seq 在 await 前已分配，插入被忽略后这个 seq 就废了。这是预期行为，对应 §10.2 第 3 条“gap 允许”，不要回收、不要补。

### 5.4 为什么不用一排 nullable ID 列

不建议把 `messageId/toolCallId/commandId/permissionRequestId/sessionId/...` 全部铺成列。它们本质是关联关系，不是所有事件都拥有的核心属性。列太多会带来三个问题：

1. schema 变稀疏，绝大多数事件只有少数列有值。
2. 新增一种关联对象就要迁移表结构。
3. 命名会越来越不稳定，例如 `parentMessageId`、`parentToolCallId`、`requestId`、`providerRequestId` 容易混在一起。

v2 改成三层：

```text
targetType + targetId
  这条事件“主要关于谁”，用于最常见过滤和时间线定位。

chainId
  这条事件属于哪条链路，如同一次 tool call、control command 或 provider request。

refs
  次要关联 ID map，如 messageId/toolCallId/commandId/sessionId。
```

只有长期高频查询、语义非常稳定的关联，才从 `refs` 升级成独立列。第一版只保留 `targetType/targetId/chainId` 三个通用索引点。

`data` 只放小型业务细节和少量标签，例如 provider/model/toolName/durationMs/reason。raw 原文、stream chunk 和大对象如果决定保留，就直接写 Raw JSONL。关键事件和原始流水通过 `runId + target/chainId/refs` 关联，不把文件路径或行号塞进 `RunEvent`。

### 5.4 常见事件的关联写法

| 事件 | target | chainId | refs | data |
| --- | --- | --- | --- | --- |
| `run.status_changed` | `run:{runId}` | 空 | 空 | status/from/to/provider/runtime |
| `message.completed` | `message:{messageId}` | messageId | toolCallId/sessionId if any | role/model |
| `tool.started` | `tool_call:{toolCallId}` | toolCallId | messageId/parentMessageId | toolName |
| `tool.completed` | `tool_call:{toolCallId}` | toolCallId | messageId | toolName/durationMs |
| `control.sent` | `command:{commandId}` | commandId | sessionId | commandType |
| `permission.requested` | `permission_request:{permissionRequestId}` | permissionRequestId | toolCallId/messageId | permissionKind |
| `system.issue` | 具体问题对象 | 可空 | providerRequestId/sessionId | code/message/severity |

这套规则的直觉是：列表里先看 `target`，排查链路时查 `chainId`，需要反查关系时再展开 `refs`。

### 5.5 为什么 `runSeq` 和 `transportSeq` 分开

当前 `seq` 来自 worker message。它只能表达上行/下行 transport 顺序，不能覆盖 API 内部事件，例如：

- `run.created`
- `runtime.status_changed`
- `control.sent`
- `message.completed`
- `system.issue`

因此 v2 必须新增 `runSeq`：

```text
runSeq       = AgeWork event log order, all RunEvent records have it
transportSeq = transport message seq, only Raw JSONL transport records have it
```

---

## 6. TypeScript 类型

放在 `packages/shared/src/api/runs.ts` 或 `packages/shared/src/protocol/run-events.ts`。推荐新建 `protocol/run-events.ts`，API response 再复用。

```ts
export type RunEventOrigin =
  | "platform"
  | "agent"
  | "worker";

export type CoreRunEventType =
  | "run.created"
  | "run.status_changed"
  | "runtime.status_changed"
  | "worker.status_changed"
  | "message.accepted"
  | "message.started"
  | "message.completed"
  | "message.failed"
  | "message.write_failed"
  | "tool.started"
  | "tool.completed"
  | "tool.failed"
  | "permission.requested"
  | "permission.resolved"
  | "control.sent"
  | "control.handled"
  | "control.failed"
  | "system.issue";

export type RunEventType = CoreRunEventType | (string & {});

export type RunEventTargetType =
  | "run"
  | "message"
  | "tool_call"
  | "command"
  | "permission_request"
  | "session"
  | "runtime"
  | "worker";

// 严格 typed，不再 `& Record<string, string | undefined>`：
// 那个交叉会把整体塌成开放 map，typed key 失去补全，也重新放开 §5.4 警告的
// 随意命名。要加新关联 ID 就在这里显式加一个字段（这正是“稳定关联才进 refs”的门槛）。
export type RunEventRefs = Partial<{
  messageId: string;
  toolCallId: string;
  parentMessageId: string;
  parentToolCallId: string;
  commandId: string;
  permissionRequestId: string;
  sessionId: string;
  conversationId: string;
  userId: string;
  agentId: string;
  workerId: string;
  providerRequestId: string;
}>;

export type RunEventDataValue =
  | string
  | number
  | boolean
  | null
  | RunEventDataValue[]
  | { [key: string]: RunEventDataValue };

export type RunEventData = Record<string, RunEventDataValue>;

export type RunEventRecord = {
  id: string;
  runId: string;
  runSeq: number;
  eventKey: string | null;
  type: RunEventType;
  origin: RunEventOrigin;
  targetType: RunEventTargetType | null;
  targetId: string | null;
  chainId: string | null;
  refs: RunEventRefs | null;
  summary: string | null;
  data: RunEventData | null;
  createdAt: string;
};

export type RecordRunEventInput = {
  runId: string;
  eventKey?: string;
  type: RunEventType;
  origin: RunEventOrigin;
  targetType?: RunEventTargetType;
  targetId?: string;
  chainId?: string;
  refs?: RunEventRefs;
  summary?: string;
  data?: RunEventData;
};

export type RunFact = RecordRunEventInput;
```

### 6.1 命名替换

| 当前名字 | v2 名字 | 说明 |
| --- | --- | --- |
| `RunTraceEventInput` | `RecordRunEventInput` | trace 不是正式概念 |
| `RunTraceEventSource` | 删除 | 不再保留 `source/domain` 双概念 |
| `RunTraceEventLevel` | 删除 | RunEvent 不再使用 debug/info/warn/error 日志级别 |
| `RunEventRecordService` | `RunEventRecorder` | 事件写入入口 |
| `AgentEventLogService` | `RawJsonlWriter` | 只负责按 run 写原始 JSONL |
| `seq` | 删除 | 旧 seq 语义收窄 |
| 新增 | `runSeq` | 结构化事件总顺序 |

---

## 7. 枚举收敛规则

### 7.1 `origin`

`origin` 只表达大责任边界，不表达组件细节。

| origin | 说明 |
| --- | --- |
| `platform` | AgeWork 平台侧：API、UI 输入接收、DB 状态写入、内部保护逻辑 |
| `agent` | agent/model 决策侧：模型响应、assistant message、tool call 意图、provider 边界错误 |
| `worker` | worker/runtime 执行侧：runtime 状态、工具执行、control 回执、transport 异常 |

不再继续细分来源：

- `user` 是业务参与者，不是事件生产边界；需要时放 `refs.userId` 或 `data.initiator`。
- `api/system` 都属于 `platform`，细节放 `data.component`。
- `provider` 属于 agent/model 边界，具体 provider 放 `data.provider`。
- `runtime` 是对象或领域，放 `targetType`、`type` 或 `data.runtime`。
- Message 写入组件是实现细节，成功写 Message 不需要单独事件；失败或不一致统一用 `message.write_failed` 或 `system.issue`。

### 7.2 不设日志等级

`RunEvent` 不设 `debug/info/warn/error`，也不设 `importance`。它不是日志表，而是关键执行链路表。

失败、取消、拒绝、超时等语义体现在 `type + data`：

```text
run.status_changed data.status=error
tool.failed data.reason=denied
permission.resolved data.decision=denied
system.issue data.code=worker_seq_gap
```

debug/info/warn/error 这种日志语义进入 Raw JSONL 的 `channel/recordType/body`，不进入 `RunEvent`。

---

## 8. 事件 type 命名

统一点号命名：`<area>.<fact>`。`type` 只放 AgeWork 归一化后的关键事实，不放 AG-UI/SDK 原始类型。

第一版核心 type 控制在少量边界事件：

| type | 说明 |
| --- | --- |
| `run.created` | run 记录创建 |
| `run.status_changed` | run 状态变化，具体状态放 `data.status/from/to` |
| `runtime.status_changed` | runtime 准备、可用、失败、清理等状态变化 |
| `worker.status_changed` | worker 启动、停止、心跳等状态变化 |
| `message.accepted` | user message 被接受为 run 输入 |
| `message.started` | assistant message 开始生成 |
| `message.completed` | assistant message 完成 |
| `message.failed` | assistant message 失败 |
| `message.write_failed` | Message 表写入失败 |
| `tool.started` | tool call 开始 |
| `tool.completed` | tool call 完成 |
| `tool.failed` | tool call 失败、拒绝、超时 |
| `permission.requested` | approval/question requested |
| `permission.resolved` | 用户同意、拒绝、取消，具体结果放 `data.decision` |
| `control.sent` | API 下发 control |
| `control.handled` | worker 已处理 control |
| `control.failed` | control 处理失败 |
| `system.issue` | 归一化后的系统问题，如 seq gap、raw 写失败、状态不一致 |

新增 type 的门槛：

- 这个事实是否会出现在 Run 排查时间线首页。
- 是否需要按它过滤一批 run event。
- 是否不能用现有 `*.status_changed`、`*.failed`、`system.issue + data.code` 清晰表达。

不满足这三条，默认写 Raw JSONL 或放进现有 type 的 `data`。

不进入 RunEvent type 的内容：

- `agui.RUN_STARTED`、`agui.TEXT_MESSAGE_CONTENT` 等协议原名。
- `sdk.raw`、provider raw event name。
- `worker.emit.retry`、`worker.duplicate_dropped` 这类实现细节。
- token delta、tool args chunk、reasoning chunk。

这些内容进入 Raw JSONL 的 `channel/recordType/body`。需要升格时，统一归一化成上面的少数 type，例如 `worker.seq_gap` 升格为 `system.issue`，`data.code = "worker_seq_gap"`。

---

## 9. Raw JSONL 设计

### 9.1 服务命名

`AgentEventLogService` 改名为 `RawJsonlWriter`。

职责：

- 按 run 写 raw SDK event JSONL。
- 按 run 写 AG-UI stream/chunk JSONL。
- 按 run 写大 tool output / reasoning JSONL。
- 按 run 写 runtime/worker/system JSONL：内部诊断、性能计时、重试、异常上下文、配置快照。
- 为每行分配 `rawSeq`。

不职责：

- 不写结构化 `RunEvent`。
- 不决定哪些事件进入 `RunEvent`。
- 不做管理端列表查询。

### 9.2 Raw JSONL 行格式

Raw JSONL 不是裸 data。每一行必须是标准 envelope：

```ts
export type RawJsonlChannel =
  | "sdk"
  | "agui"
  | "stream"
  | "tool"
  | "runtime"
  | "worker"
  | "system";

export type RawJsonlLine = {
  id: string;
  runId: string;
  rawSeq: number;
  channel: RawJsonlChannel;
  recordType: string;
  transportSeq?: number;
  targetType?: RunEventTargetType;
  targetId?: string;
  chainId?: string;
  refs?: RunEventRefs;
  eventTime?: string;
  createdAt: string;
  body: unknown;
};
```

命名语义：

```text
channel     粗粒度写入管道/文件分组，如 sdk、agui、stream、tool、runtime。
recordType  这一行具体是什么记录，如 text_delta、tool_output、retry、startup_timing。
```

不用 `source` 是为了避免和 `RunEvent.origin` 混淆；不用 `type` 是为了避免把 raw 行误认为关键链路事件。

`rawSeq` 是 run 内 raw 流水顺序，和 `RunEvent.runSeq` 不是一回事。`runSeq` 排关键事件，`rawSeq` 排原始流水。

### 9.3 Raw JSONL 路径

路径可以保持简单：

```text
runs/{runId}/raw/sdk.jsonl
runs/{runId}/raw/agui.jsonl
runs/{runId}/raw/stream.jsonl
runs/{runId}/raw/tool.jsonl
runs/{runId}/raw/runtime.jsonl
runs/{runId}/raw/worker.jsonl
runs/{runId}/raw/system.jsonl
```

这些路径是内部实现细节，不进入 `RunEvent` schema。

### 9.4 写入规则

关键事件和原始流水分开写：

| 内容 | 写入位置 | 说明 |
| --- | --- | --- |
| run status / control status | `RunEvent` | 小、结构稳定、回溯常用 |
| message/tool/control/permission 边界 | `RunEvent` | 关键事实，必须可查询 |
| SDK raw event | Raw JSONL | 原始流水，不默认进入 RunEvent |
| AG-UI stream/chunk | Raw JSONL 或只走 live | 不为每个 chunk 写 RunEvent |
| tool 大结果 | Raw JSONL；RunEvent 写 summary/preview | 通过 toolCallId/chainId 回查完整结果 |
| error | `RunEvent`，必要时 Raw JSONL | 错误摘要必须可查，原始堆栈可写 JSONL |

默认策略：

- Raw JSONL 默认开启，至少记录 SDK raw、AG-UI boundary、tool output/error。
- stream 和内部运行流水可以按环境配置开启，但即使开启也不把 chunk 或内部诊断提升为 RunEvent。
- Raw JSONL 必须做脱敏、大小限制、文件轮转和保留周期。
- 如果 Raw JSONL 写失败，不应阻塞 RunEvent；但要追加一条 `system.issue`，`data.code = "raw_jsonl_write_failed"`。

### 9.5 怎么定位原始流水

默认靠 ID 查，不靠 `RunEvent` 存文件行号：

| 想查什么 | 查询条件 |
| --- | --- |
| 某次 tool call 的完整原始过程 | `runId + chainId=toolCallId` |
| 某条 message 的 stream/chunk | `runId + targetType=message + targetId=messageId` |
| 某个 control command 的 worker 回执 | `runId + chainId=commandId` |
| 某个 transport message 的原文 | `runId ` |
| 一段时间内的 SDK 原始事件 | `runId + channel=sdk + rawSeq range` |

只有在两个场景才需要额外做“精确定位优化”：

1. Raw JSONL 巨大，扫描成本不可接受。
2. 需要从某条 `RunEvent` 一键打开“唯一原始行”，而不是一组相关流水。

这时可以在 Raw JSONL 层增加独立索引，例如 `{ runId, channel, rawSeq, file, offset }`，但这仍然是 raw 层实现细节，不进入 `RunEvent` 主表。

---

## 10. DDD / 六边形调用机制

### 10.1 领域语言

`RunEvent` 在这里不是完整 Event Sourcing，也不是日志平台。它是 `Run` bounded context 内的 troubleshooting timeline。

采用 DDD 的语言：

| 名字 | 定位 |
| --- | --- |
| `RunFact` | 应用层要记录的一条关键事实，还没有分配 `runSeq/id/createdAt` |
| `RunEvent` | 已持久化的关键事实记录 |
| `RunEventRecorder` | 应用服务，统一校验、脱敏、分配 `runSeq`、落库 |
| `RunEventStore` | driven port，负责持久化 `RunEvent` |
| `RawJsonlWriter` | driven adapter/port，负责原始流水 |
| `RunEventNormalizer` | adapter，把 AG-UI/SDK/worker message 转成 `RunFact` |

实现形态：

- `RunEventRecorder` 是 NestJS `@Injectable()` application service / facade，所有结构化关键事件只从这里写入。
- `RunEventStore` 是 `RunEventRecorder` 依赖的持久化 port，第一版可以由 Prisma adapter 实现。
- `RunEventNormalizer` 可以是独立 service，也可以先是纯函数模块；它只负责把外部 envelope 映射成 `RunFact`，不直接写 DB。
- 这里不引入通用 event bus。v2 只是统一结构化事件写入口，不把 Raw JSONL、SSE、Message 写入混成一个总线。

统一调用入口：

```ts
export interface RunEventRecorder {
  append(fact: RecordRunEventInput): Promise<RunEventRecord>;
}
```

为了调用方便，可以提供少量 typed factory，但最终都走 `append()`：

```ts
await runEvents.append(
  RunFacts.runStatusChanged({
    runId,
    origin: "worker",
    status: "running",
    targetId: runId,
  }),
);
```

不建议在业务代码里到处拼裸对象。建议只有 normalizer/use case 调用 `RunFacts.*`，再统一交给 `RunEventRecorder.append()`。

### 10.2 runSeq 分配

这是整个 v2 最容易翻车的地方，必须把并发模型钉死，不能只写“内存计数器 + DB 回退”一句话。

第一阶段方案：**内存计数器 + DB 回退 + per-run 串行 + 持久化前同步分配**。

```text
append(fact):
  withRunLock(fact.runId):
    if memory counter missing:
      max = await store.maxRunSeq(runId) // 仅首次/重启后回退一次，且必须在锁内
      counter = max

    runSeq = ++counter                   // 持久化 await 前同步分配
    await store.insertOrGetByEventKey({ ...fact, runSeq })
```

四条硬约束，缺一不可：

1. **先进入 per-run 串行临界区，再分配。**
   `append()` 是 async（要 await DB）。如果没有 per-run 串行保护，两个并发 append 可能同时初始化 counter 或同时读到同一个 max，撞 `@@unique([runId, runSeq])`。
   首次/重启后允许在锁内 `await max(runSeq)` 初始化 counter；初始化完成后，`runSeq` 必须在 insert/upsert 这类持久化 await 之前从内存计数器同步取出。

2. **同一 run 串行化。**
   对同一 `runId` 的 `append()` 必须排队执行（per-run mutex 或顺序 promise chain），保证“分配顺序 == 落库顺序”。不同 run 之间可以并发。
   注意当前来源已经混合：`run.created`/`control.sent` 来自 API 侧，agui/run.status 来自 worker 上行，它们会并发打到同一个 run，串行化不能省。

3. **gap 是允许的。**
   `runSeq` 是排序键，不是计数器。`eventKey` 冲突、写入失败导致的空洞都可接受。**绝不允许为了补洞去回读 / 重分配**，那会重新引入竞态。schema 注释里的“严格单调递增”指单调，不是无间断。

4. **DB max 回退只发生一次。**
   仅在内存里没有该 run 的计数器时（首次或重启后）查一次 `max(runSeq)`，之后只走内存 `++`。计数器随 run 终态清理（参照现有 `lastSeqMap` 的清理时机）。

原因：

- 同一个 run 的事件主要由当前 API 实例处理。
- 服务重启后可从 DB max 恢复。
- SQLite/Postgres 都能支持。

未来演进：

- 如果多 API 实例同时处理同一 run，内存计数器失效，必须改为 DB sequence 或 `INSERT ... RETURNING` 事务内分配。第一版不做，但 `RunEventStore` 接口要留出把 seq 分配下沉到 store 的空间。

### 10.3 写入策略

`RunEvent` 是关键链路表，不按任何日志等级丢弃。

策略：

- 第一版 `append()` 的 promise 必须代表持久化结果：DB durable insert 成功，或 `eventKey` 幂等命中后，才能 resolve。
- 写入失败必须抛错或追加 `system.issue`，不能静默吞掉。
- Raw JSONL 不跟随 RunEvent queue 策略。它默认按配置打印 raw/stream/runtime/worker/system 行；如果磁盘或大小限制触发轮转/采样，也在 Raw JSONL 层记录，不用 `debug` RunEvent 表达。

关于吞吐（和现状的差异要正视）：

- 现在的 `RunEventRecordService` 用 batch（100 条 / 500ms）正是因为旧表把 token/agui debug 全塞进来、量很大。v2 砍掉 token/chunk/agui-debug 后量级下降一个数量级，逐条同步落库通常可接受。
- 但 `append()` 跑在 SSE 处理热路径上，`message.completed`/`tool.completed` 仍可能突发。**不要把“同步语义”实现成“每条一个独立同步 insert + round-trip”。**
- 允许 `RunEventStore` 内部做**保序的批量 flush**（保留 runSeq 顺序），但 `append()` 必须等待所属 batch flush 完成后再 resolve。也就是说：seq 分配同步、落库可短暂合并，但绝不丢、不乱序、不静默吞错。如果只是入队就返回，那不叫 `append()`，只能叫 `enqueue()`。

---

## 11. State updater 边界

大爆炸后，`RuntimeEventProcessor` 不再承担所有具体副作用。它只做 orchestrator。

```text
RuntimeEventProcessor.publish(envelope)
  -> RunEventNormalizer.toFacts(envelope)
  -> RunEventRecorder.append(...) for key facts
  -> RawJsonlWriter.append(...) for raw/stream/runtime/worker/system lines
  -> RunStatusStateUpdater.apply(...)
  -> MessageStateUpdater.applyAgui(...)
  -> LiveAguiStreamer.write(...)
```

### 11.1 `RunStatusStateUpdater`

职责：

- 根据 `run.status_changed` 更新 `Run.status`。
- 更新 `Conversation.activeRunStatus`。
- 更新 `Conversation.pendingUserAction`。
- 处理 terminal guard。

不职责：

- 不写 raw trace。
- 不聚合 message。
- 不直接处理 SSE。

### 11.2 `MessageStateUpdater`

职责：

- 从 AG-UI event 或未来 self-owned message event 更新 `Message` 表。
- 当前可继续使用 `RuntimeMessageAggregator`。
- 成功写入不默认追加 RunEvent；失败或不一致时记录 `message.write_failed` 或 `system.issue`。

不职责：

- 不决定 Run 状态。
- 不作为事实源。

### 11.3 `LiveAguiStreamer`

职责：

- 只负责 SSE 输出给 live UI。
- 保持现有 `useAgUiRuntime` 兼容。
- 过滤 `MESSAGES_SNAPSHOT` / 不适合 live 的事件。

不职责：

- 不写 DB。
- 不聚合 Message。

---

## 12. RuntimeEventProcessor v2 流程

### 12.0 用户提交 / Run 创建

```text
User submits message
  -> Message table writes user message for UI replay
  -> Run record created
  -> RunEventRecorder.append({
       type: "run.created",
       origin: "platform",
       targetType: "run",
       targetId: runId,
       chainId: runId,
       refs: { conversationId, messageId, userId },
       summary: "Run created from user message",
       data: { component: "api", agentType, runtimeType }
     })
  -> RunEventRecorder.append({
       type: "message.accepted",
       origin: "platform",
       targetType: "message",
       targetId: messageId,
       chainId: runId,
       refs: { conversationId, userId },
       summary,
       data: { component: "api" }
     })
```

这两条事件让时间线从“用户发起”开始，而不是从 worker 第一条上行事件开始。

### 12.1 上行 AG-UI event

```text
RunChannelMessage(type="agui.event"=N)
  -> RawJsonlWriter.appendAgui(event) when raw AG-UI retention is enabled
  -> RunEventNormalizer.toFacts(event)
       only emits normalized key facts:
       message.started / message.completed / message.failed
       tool.started / tool.completed / tool.failed
  -> RunEventRecorder.append(...) for each fact
  -> MessageStateUpdater.applyAgui(event)
  -> LiveAguiStreamer.write(event)
```

### 12.2 上行 SDK raw

```text
RunChannelMessage(type="sdk.raw"=N)
  -> RawJsonlWriter.appendSdk(data)
  -> if error or important boundary, RunEventRecorder.append({
       type: "system.issue",
       origin: "agent",
       targetType,
       targetId,
       chainId,
       refs,
       summary,
       data: { code, provider, model }
     })
```

### 12.3 Run status

```text
RunChannelMessage(type="run.status"=N)
  -> RunEventRecorder.append({
       type: "run.status_changed",
       origin: "worker",
       targetType: "run",
       targetId: runId,
       data: { from, to: status, reason }
     })
  -> RunStatusStateUpdater.apply(data)
```

### 12.4 Control

> 注意：`control.sent` / `control.{phase}` 现在**已经在发**（`local-runtime-provider.ts`、`runtime-control-queue.ts`、`runtime-event-processor.ts`）。v2 在这里是**改字段命名**（`source/eventType/payload` → `type/origin/target/chain/refs/data`），不是新增行为。风险因此更低，但要确保 API 侧 `control.sent` 和 worker 回执的 `commandId` 仍能对齐成 `chainId`。

```text
API send control
  -> RunEventRecorder.append({
       type: "control.sent",
       origin: "platform",
       targetType: "command",
       targetId: commandId,
       chainId: commandId,
       refs: { commandId },
       data: { component: "api" }
     })
  -> provider.sendControl(...)

Worker reports control.trace received/handled/failed
  -> RunEventRecorder.append({
       type: phase === "failed" ? "control.failed" : "control.handled",
       origin: "worker",
       targetType: "command",
       targetId: commandId,
       chainId: commandId,
       refs: { commandId },
       data: { phase }
     })
```

### 12.5 Permission / question

Permission 需要脱离“只是合成 AG-UI tool call”的语义。v2 规定：

```text
permission.requested
  必须在 UI 出现待处理卡片前写入 RunEvent

permission.resolved
  用户提交答案、拒绝、取消、abort 后写入 RunEvent，结果放 data.decision
```

短期可以继续用合成 AG-UI tool call 渲染 UI，但 `permission.*` 是结构化事实。

---

## 13. Message 写入规则

`Message` 保留现有模型，定位明确为 UI 回显读模型。

写入规则：

- user message 仍由 `ConversationService.saveUserMessage()` 写入。
- assistant message 由 `MessageStateUpdater` 写入。
- `Message.runId` 关联产生它的 run。
- message content 可以来自当前 `RuntimeMessageAggregator`，但其输出不是事实源。

RunEvent 只记录必要边界：

```text
message.accepted
message.started
message.completed
message.failed
message.write_failed
system.issue data.code=message_sync_mismatch
```

成功写入 `Message` 不默认追加 `message.saved`，否则时间线会被读模型同步事件污染。未来如果实现自有 message 写入器，优先从关键 `RunEvent` replay；Raw JSONL 只作为诊断/审计原文，不作为默认恢复来源。

---

## 14. Streaming delta 策略

吸收 OpenHands 的机制：流式 delta 不全部进入结构化事件表。

| 事件 | Live SSE | RunEvent | Raw JSONL |
| --- | --- | --- | --- |
| text chunk | 是 | 默认不写单条 RunEvent | 可写 stream JSONL |
| reasoning chunk | 是 | 默认不写单条 RunEvent | 可写 stream JSONL |
| tool args chunk | 是 | 默认不写单条 RunEvent | 可写 stream JSONL |
| text end | 是 | 写 `message.completed` | 可写 agui JSONL |
| tool result | 是 | 写 `tool.completed` | 大结果写 tool JSONL |
| run terminal | 是 | 必写 RunEvent | 通常不需要 |

这样 `RunEvent` 保持可回溯关键边界，不被 token/chunk 淹没。需要逐 token 复盘时，显式开启 stream JSONL；默认只保证关键事件可回溯。

---

## 15. API 查询

### 15.1 Admin RunEvent list

替换现有 `AdminRunEventResponse`。

支持过滤：

```ts
type AdminRunEventListQuery = {
  runId: string;
  type?: RunEventType[];
  typePrefix?: string;
  origin?: RunEventOrigin[];
  targetType?: RunEventTargetType;
  targetId?: string;
  chainId?: string;
  refKey?: string;
  refValue?: string;
  fromRunSeq?: number;
  toRunSeq?: number;
  pageNo?: number;
  pageSize?: number;
};
```

排序：

```text
order by runSeq asc
```

### 15.2 Raw JSONL search endpoint

新增或预留：

```text
GET /api/v1/admin/runs/:runId/raw-events
```

查询参数：

```ts
type AdminRawJsonlQuery = {
  channel?: RawJsonlChannel[];
  recordType?: string;
  transportSeq?: number;
  targetType?: RunEventTargetType;
  targetId?: string;
  chainId?: string;
  refKey?: string;
  refValue?: string;
  fromRawSeq?: number;
  toRawSeq?: number;
  pageSize?: number;
};
```

行为：

- 默认按 `rawSeq asc` 返回。
- 需要 admin 权限。
- **第一版实现就是按行扫描 + 解析对应 channel 文件**，按 `target/chain/refs/rawSeq range` 过滤。JSONL 无索引，这是 O(文件大小) 的查询，靠 §9.4 的脱敏 / 大小上限 / 轮转把单文件规模兜住。
- 这是 admin 排查工具，不是面向高频/通用查询的 API，前端不要当通用检索用。
- 如果未来 JSONL 很大、线性扫不可接受，再给 Raw JSONL 单独建索引（§9.5）；不改 `RunEvent` schema。

---

## 16. 管理端展示

Run detail 时间线按 `runSeq` 展示。

推荐 UI 分区：

```text
All | Run | Message | Tool | Permission | Control | Runtime | Worker | Issues
```

每条事件显示：

- `#runSeq`
- type
- origin
- target chip
- chainId chip
- refs chips, e.g. messageId/toolCallId/commandId
- summary
- “查看 data”按钮：打开 DB data
- “查看原始流水”按钮：用 target/chain/refs 搜 Raw JSONL

---

## 17. 大爆炸改造清单

“大爆炸 / 不兼容”只针对**数据**——旧 `RunEvent` 行可以直接扔。它**不要求代码改动是一个原子 PR**。实际 emit 点比下面清单的措辞要多（见 17.5），一次性动 schema + 6 个 emit 文件 + admin controller + shared 类型 + admin UI + 全部 test，review 和回滚都难。

推荐分阶段（即使数据可丢）：

1. 落新 schema + `RunEventRecorder`（带 17.x 的 seq/幂等约束），和旧 `RunEventRecordService` 并存。
2. 逐个迁 emit 点到 `RunFacts.* -> append()`，旧 service 同时停用。
3. 切 admin 读路径到新字段（runSeq/origin/target/chain/refs）。
4. 删旧 service / 旧字段 / 旧类型，重生成 client。

### 17.1 Schema / generated client

- 替换 Prisma `RunEvent` 字段。
- 删除旧 `seq/source/domain/meta/eventTime` 概念。
- 保留但重新定义 `type` 为少量 AgeWork 归一化事件类型。
- 重新生成 Prisma client。

### 17.2 Shared types

- 新增 `packages/shared/src/protocol/run-events.ts`。
- 更新 `packages/shared/src/api/runs.ts` 的 admin event response/query。
- 导出 `RunEventOrigin/RunEventType/RunEventTargetType/RunEventRefs`。

### 17.3 Services rename

- `RunEventRecordService` -> `RunEventRecorder`。
- `RunTraceEventInput` -> `RecordRunEventInput`。
- `AgentEventLogService` -> `RawJsonlWriter`。
- 更新所有 import 和 tests。

### 17.4 RuntimeEventProcessor split

先物理拆服务，行为仍可保持：

- `RunStatusStateUpdater`
- `MessageStateUpdater`
- `LiveAguiStreamer`
- `RunEventNormalizer`
- `RunFacts` typed factories

### 17.5 Event extraction

#### 现有 emit 点全清单（都要从 `source/eventType/level/payload` 改写成 `type/origin/target/chain/refs/data`）

| 文件 | 当前 eventType | v2 归一化目标 |
| --- | --- | --- |
| `runtime-event-processor.ts` | `worker.seq_gap` | `system.issue` + `data.code=worker_seq_gap` |
| `runtime-event-processor.ts` | `run.status.{status}` | `run.status_changed` + `data.status` |
| `runtime-event-processor.ts` | agui `TOOL_CALL_START/RESULT` 等 | `tool.started/completed` 等（normalizer 提取） |
| `runtime-event-processor.ts` | `sdk.raw` / `{name}` | 默认进 Raw JSONL；error 边界升 `system.issue` |
| `runtime-event-processor.ts` | `control.{phase}` | `control.handled` / `control.failed` |
| `runtime-runner.ts`（7 处） | `run.created` / `runtime.starting` / `runtime.ready` / `runtime.start_failed` / `run.cancelled_without_handle` / `run.cancel_requested` | `run.created` 保留；`runtime.*` 全部归一化进 `runtime.status_changed` + `data.status`；cancel 相关进 `control.*` 或 `run.status_changed` |
| `local-runtime-provider.ts` | `control.sent` | `control.sent`（已存在，仅改字段，见下） |
| `sandbox-runtime-provider.ts` | control 相关 | 同上 |
| `runtime-control-queue.ts` | `control.sent` | `control.sent`（已存在，仅改字段） |

重点：`runtime.starting/ready/start_failed` 这组**不是新增 type**，而是塌进 `runtime.status_changed`，靠 `data.status` 区分。这个映射是 normalizer 的主要工作量，别低估。

#### 从 AG-UI/control/run data 提取

- `targetType`
- `targetId`
- `chainId`
- `refs.messageId`
- `refs.toolCallId`
- `refs.parentMessageId`
- `refs.commandId`
- `refs.sessionId`
- summary

### 17.6 Raw JSONL

- raw SDK / AG-UI / stream / tool output 按 run 写 JSONL。
- Raw JSONL 每行写标准 envelope 和 `rawSeq`。
- 需要查询时走 Raw JSONL search endpoint。

### 17.7 Admin API/UI

- Run events 查询按 `runSeq`。
- 支持 type/typePrefix/origin/target/chain/ref filters。
- 管理端展示字段改版。

### 17.8 Tests

必须补：

- `RunEventRecorder` 分配 `runSeq`。
- **同一 run 并发 append 不产生重复 runSeq、不撞 unique（验证 §10.2 串行化 + 同步分配）。**
- **重复 `eventKey` 的 append 幂等成功、不抛错，且留下的 runSeq 空洞不被回收（验证 §5.3）。**
- 服务重启后从 DB `max(runSeq)` 正确续接计数器。
- `append()` 写入失败不静默吞掉。
- terminal `run.status_changed` 先写 RunEvent 再更新状态。
- AG-UI event normalization 提取 target/refs。
- control sent/handled/failed 用 `chainId=commandId` 串联。
- RawJsonlWriter 分配 `rawSeq`。
- Raw JSONL search 能按 target/chain/refs 查到相关原始流水。
- admin query 按 runSeq 稳定分页。

---

## 18. 非目标

- 不兼容历史 `RunEvent` 数据。
- 不替换 AG-UI live runtime。
- 不重写 assistant-ui message format。
- 不一次性实现自有 Tool SDK。
- 不把所有 raw data 存 DB。
- 不在第一阶段持久化每个 token chunk。

---

## 19. 最终架构图

```text
Claude/Codex SDK
      |
      v
Adapter / Worker
      |
      | RunChannelMessage(runId, type, data)
      v
RuntimeEventProcessor
      |
      +--> RawJsonlWriter
      |      - sdk raw JSONL
      |      - agui raw JSONL
      |      - stream/tool/runtime/worker/system JSONL
      |
      +--> RunEventRecorder
      |      - runSeq
      |      - type/origin
      |      - target/chain/refs
      |
      +--> RunStatusStateUpdater
      |      - Run.status
      |      - Conversation.activeRunStatus
      |      - Conversation.pendingUserAction
      |
      +--> MessageStateUpdater
      |      - Message assistant-ui content
      |
      +--> LiveAguiStreamer
             - SSE to useAgUiRuntime
```

一句话：**RunEvent 负责关键链路回溯，Message 负责 UI 回显，Raw JSONL 负责原始流水。**
