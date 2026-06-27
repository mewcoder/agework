# AgeWork Agent Event Log 设计（修订版）

> 修订时间：2026-06-19
> 本文替代同名草案。原草案一次性定义了大而全的事件协议（约 50 个 type）、用 "canonical" 命名、并把"替换 AG-UI"当作开局动作。本次修订收敛为：先建事实源、AG-UI 暂留为投影、按 source 分域只定义有真实来源的事件。

相关文档：

- [Agent 事件体系评审报告](./agent-event-system-review.md)
- [Agent 事件追溯与日志体系改造计划](./agent-event-trace-logging-plan.md)

历史的 Assistant UI 数据层重构、AgeWork Runtime 可行性、AG-UI 替换方案已归档到 `docs/archive/`，不属于当前执行范围。

## 1. 根本决策

### 1.1 "用不用 AG-UI 做中间层"不是承重决策

AG-UI 当前同时干两件**可以分开**的事：

1. **实时 UI wire 协议 + 现成聚合器**：前端 `useAgUiRuntime`(`@assistant-ui/react-ag-ui`) 把事件流直接聚合成 assistant-ui messages。这是 AG-UI 白给的价值。
2. **adapter 的输出词汇表**：Claude/Codex SDK 被翻译成的目标格式。

这两件事不必是同一个协议。真正承重的是两个正交决策：

- **要不要一个事实源（Agent Event Log）？** —— 跟 AG-UI 无关，可以独立先做。
- **谁拥有 message 聚合？** —— 这才是又贵又难回退的决策；AG-UI 的去留是它的副产物。

### 1.2 决策结论

| 决策 | 结论 |
| --- | --- |
| 是否建立 AgeWork 自有事实源 | **是**，叫 Agent Event Log，立即做 |
| AG-UI 的定位 | 暂留为 **UI 域事件的载体**，被 Event Log 收编为 `source: "agui"`；最终可替换 |
| 是否现在就替换 AG-UI wire 协议 | **否**。替换是 Event Log + 自有投影验证 parity 后的可逆收尾，不是开局 |
| AG-UI 表达不了的事件（permission/worker/sandbox/auth/raw/task） | 在 Event Log 的**其它 source 域**里头等公民地定义，不塞进 AG-UI |
| 后端 `RuntimeMessageAggregator` | 定位为投影器（projector），不再当事件体系核心 |
| 通用 Agent Runtime | **可以做**，但先做 shadow runtime / projection parity，不作为替换 AG-UI 的前置条件 |

一句话：**Agent Event Log 是事实源；AG-UI、assistant-ui 消息、工具过程面板、排查面板都是它的投影。** 这条 log 让"替换 AG-UI"从高风险开局变成低风险收尾，同时给 AG-UI 表达不了的事件一个名分。

> **当前决策（2026-06-19）：暂不替换 AG-UI。** 移除它本质等于重写一遍 `useAgUiRuntime` 的 live 聚合（见第 7 节 Phase 3），性价比低。AG-UI 继续作为 live UI runtime 保留。
>
> **活跃范围收敛为 Phase 0–2 + 关键事件可靠性**——均为 additive、不触碰 AG-UI wire/runtime：建 Event Log 事实源、补 AG-UI 表达不了的域事件、做 tool process / diagnostics 投影、加固关键事件可靠性。
>
> **Phase 3/4（自有 message 投影 + 移除 AG-UI）暂缓**，作为可选远期项；终态架构（1.3）保留为愿景，不是当前目标。一个副作用：live(`useAgUiRuntime`) 与 history(`RuntimeMessageAggregator`) 的双聚合路径继续并存——可接受，因为事实源已由 Event Log 承担，aggregator 退为纯派生投影，drift 不再影响"事实"。

### 1.3 终态架构

终态分层（已认可）。注意它**不是线性管道**：`Agent Event Log` 是事实源和分支点，下游是多个并列映射器，assistant-ui 只是其中一个视图。

```text
Claude / Codex Native Event
        ↓   （Worker 端：每 provider 一个 runner，尽量只吐 native / raw runner event）
native → Agent Event
        ↓   （契约由 平台 / API 侧拥有；Worker 不做协议转换）
Agent Event Log              ← 事实源 / append-only / 可重放
        ↓   多个映射器（live 与 history 共用同一套，杜绝双路径漂移）
  ├─ Assistant Message       （AgentEvent → assistant-ui ThreadMessage）
  ├─ Tool Process            （处理过程面板）
  └─ Diagnostics             （排查时间线）
        ↓
Agent Runtime = store + useExternalStoreRuntime   ← assistant-ui 适配层
        ↓
Assistant UI                 ← 只是一个视图，不是事实源
```

关键性质：

- **Event Log 是事实源**，Assistant UI 只是它的一个视图；tool process、diagnostics 是平级的另外两个视图。
- **`native → Agent Event` 的契约归 平台 / API 拥有**，Worker 尽量只吐 native / raw runner event。这样 Worker 更薄、provider 无关（执行除外），也符合"把转换从 Worker 抽到平台"的方向。
- **live 和 history 共用同一套映射器**，这是消除"双聚合路径漂移"、去黑盒的关键。
- Runtime 是 Event Log 的消费者和投影层，不是 Event Log 的替代品。

迁移期：`useAgUiRuntime` 暂时仍驱动 live UI，AG-UI 只作为挂在 `Agent Event` 旁的可选投影（`source: "agui"`）；AgeWork Runtime 以 shadow mode 消费同一批事件做 parity 验证，稳定后再经 feature flag 切到 `useAgeWorkAgentRuntime`、最终摘除 AG-UI。

## 2. Agent Event Log 是什么

### 2.1 定义

一个 **append-only、可落库可查询的事件序列**，按 run 单调递增。每条记录（AgentEvent）带统一字段（`seq` / `source` / `type` / `runId` / `messageId` / `toolCallId` / `payload` / raw ref）。它是"这个 run 到底依次发生了什么"的唯一权威记录。

### 2.2 它收编现在散着的三样东西

现状：raw SDK trace、AG-UI events、worker logs 各记各的，格式不同、没有共享 seq、按 run 查不到一起。

```text
现状（三样互不关联）              目标（一条脊柱，三样归位）
  raw SDK trace (JSONL)   ──┐      Agent Event Log（统一 seq / runId / messageId / toolCallId）
  AG-UI events            ──┤  →     ├─ source: "sdk"     ← raw 事件（大 payload 落文件，用 ref 指）
  worker logs             ──┘        ├─ source: "agui"    ← AG-UI 事件（live UI 继续消费）
                                     ├─ source: "worker"  ← retry / seq gap / drop
                                     ├─ source: "runtime" ← sandbox / auth / rate-limit
                                     ├─ source: "control" ← permission 决策
                                     └─ source: "task"    ← task / plan
```

**Agent Event Log 不是第 4 个日志，而是把这三样串成一条带统一 seq 和 id、可按 run 查询的脊柱。**

### 2.3 命名约定

代码里已有 `agent-event-log.service.ts`、`AgeWorkAgentEvent`，复用这套语汇：

- 概念 / 服务：**Agent Event Log**
- 单条记录：**AgentEvent**
- ⚠️ 不要用 `RunEvent` —— 该名字已被诊断摘要（`run-event-record.service.ts`）占用，会撞名

## 3. 事件 envelope

只保留有明确用途的字段，不预留投机字段。

```ts
type AgentEvent = {
  schemaVersion: 1;
  eventId: string;

  runId: string;
  conversationId: string;
  workspaceId: string;

  /** 由 worker/API 边界分配，按 run 单调递增，用于排序和 seq gap 检测 */
  seq: number;

  /** 事件来源域，决定它属于哪一类事实 */
  source: "agui" | "sdk" | "worker" | "runtime" | "control" | "task";

  /** 域内事件类型，见第 4 节 */
  type: string;

  agentType: "claude" | "codex" | (string & {});

  /** provider 事件发生时间（若有）；observedAt 为 AgeWork 观察时间 */
  occurredAt?: string;
  observedAt: string;

  level?: "debug" | "info" | "warn" | "error";

  /** 跨层定位，按需填写 */
  ids?: {
    sessionId?: string;
    messageId?: string;
    toolCallId?: string;
    parentMessageId?: string;
    parentToolCallId?: string;
  };

  /** 小 payload 直接入库；大 payload 落文件/blob，用 payloadRef 关联 */
  payload?: unknown;
  payloadPreview?: string;
  payloadRef?: string;

  /** 追溯到 provider 原生事件 */
  native?: {
    type: string;
    subtype?: string;
    itemType?: string;
    id?: string;
  };
};
```

`turnId`、`artifactId`、`nativeSeq` 等暂不引入；等出现明确消费方再加。

## 4. 按 source 分域的事件

只定义"现在确实有数据来源"的事件。每个域可随能力扩展。

### 4.1 `agui` 域 — 直接收编现有 AG-UI 事件

不重新发明 UI 语义。现有 `RUN_*` / `TEXT_MESSAGE_*` / `TOOL_CALL_*` / `REASONING_*` / `STATE_SNAPSHOT` 原样作为 `type` 写入 log，live UI 继续用。

> 注：`MESSAGES_SNAPSHOT` 可写入 log 但标 `level: "debug"`，不作为事实源、不进 live SSE。

### 4.2 `sdk` 域 — raw 保真

| type | 说明 |
| --- | --- |
| `sdk.raw` | Claude `SDKMessage` / Codex `ThreadEvent` 原样，payload 走 `payloadRef` |

排查时可由 `sdk.raw` 重建任何上层投影；这是"raw 保真"诉求的落点。

### 4.3 `worker` 域 — transport 诊断

| type | 说明 |
| --- | --- |
| `worker.seq_gap` | API 检测到 seq 不连续 |
| `worker.retry` | persistent worker 上报重试 |
| `worker.drop` | 事件被丢弃（含原因、可靠性等级） |

### 4.4 `runtime` 域 — 运行时状态

| type | 来源 | 说明 |
| --- | --- | --- |
| `runtime.init` | Claude `SDKSystemMessage(init)` | session/model/cwd/tools |
| `runtime.sandbox` | local/docker/opensandbox | 启动、健康、退出 |
| `runtime.auth` | Claude `SDKAuthStatusMessage` | auth 状态 |
| `runtime.rate_limit` | Claude `SDKRateLimitEvent` | 限流 |
| `runtime.api_retry` | Claude `SDKAPIRetryMessage` | API 重试 |
| `runtime.status` | Claude `SDKStatusMessage` | requesting / compacting |

### 4.5 `control` 域 — permission / human-in-the-loop（特殊，见第 5 节）

| type | 说明 |
| --- | --- |
| `permission.requested` | 进入宿主决策边界时记录 |
| `permission.resolved` | 宿主决策返回（allow/deny + 可能的 updatedInput） |
| `permission.denied` | 自动拒绝（Claude `SDKPermissionDeniedMessage`） |

### 4.6 `task` 域 — 后台任务 / 计划

| type | 来源 |
| --- | --- |
| `task.started` / `task.updated` / `task.progress` | Claude task 系列 |
| `plan.updated` | Codex `todo_list` |

### 4.7 关于 message / reasoning / tool 的"自有词汇"

**第一阶段不定义。** UI 域语义暂时复用 `agui` 域事件。只有当进入 message projection parity / AG-UI 降级阶段（见第 7 节 Phase 3/4）时，才引入自有 `message.*` / `reasoning.*` / `tool.*` 事件，并把 `agui` 域反向变成它们的投影输出。在那之前不重复建模，避免又造一个 fork。

## 5. Permission 的 control 通道（特殊处理）

AG-UI 和 adapter 的 `run(): AsyncIterable<Event>` 都是**单向流**，表达不了 permission 的请求/响应。Claude 的 `canUseTool(toolName, input, ctx)` 是宿主回调边界，不是 stream 事件。

因此 permission 需要一个**与事件流并行的 control 通道**：

```text
adapter 进入 canUseTool 回调
  → 写 control 事件 permission.requested（进 log + 推 SSE 让 UI 出审批面板）
  → 通过 control 通道等待宿主决策（不阻塞事件流语义）
  → 宿主决策返回 → 写 permission.resolved → 回调 resolve，SDK 继续
```

落地要点：

- adapter 契约需要在 `run()` 之外提供一个决策入口，例如 `resolvePermission(requestId, decision)`，或在 run 启动时注入决策 Promise 工厂。
- `permission.requested` 必须先进 log 再推 UI，保证刷新后能从 log 恢复"待审批"状态。
- 本项目已有 `pending-question-panel` / `ask-user-question` 工具链，可作为前端审批 UI 的接入点。

## 6. Worker / 平台职责边界

原则：**执行留 Worker，转换搬平台。** `native → AgentEvent` 的契约归平台/API；Worker 尽量只吐 native / raw runner event。

### 6.1 为什么转换能搬、执行搬不动

现有 `packages/adapters` 里的 adapter 干了两件事，必须拆开：

- **执行控制（搬不动，留 Worker）**：`query()` 生命周期、session resume、`interrupt`、MCP server / tool 注入，尤其 **`canUseTool` permission 回调**——SDK 进程在哪跑，回调就在哪触发并等决策。
- **事件转换（搬平台）**：native → AgentEvent / AG-UI 投影。

### 6.2 职责划分

```text
Worker（薄，按 provider，只管"跑"）
  - 起 provider runner（底层用 SDK，见 6.3）、session、interrupt
  - 把 NATIVE / raw runner event 原样流上去   ← 不做协议转换
  - canUseTool / interrupt / cancel ←→ control 通道（双向，见第 5 节）

         │ native events + control
         ▼
平台 / API（拥有契约和事实源）
  - native → AgentEvent（契约归这里）
  - 写 Agent Event Log（sdk.raw 天然就是它）
  - 投影：assistant message / tool process / diagnostics / 可选 agui
```

### 6.3 底层保留 SDK，不裸跑 CLI

Claude/Codex SDK 本质是 CLI 的上层包装（spawn `claude`/`codex` CLI + `stream-json` + stdio 控制协议）。SDK 在 CLI 之上替你实现了：stdio 控制协议（`initialize`/`can_use_tool`/`interrupt`/`set_permission_mode`/`mcp_message`）、**进程内 MCP（`createSdkMcpServer`，本项目 ag_ui 工具依赖它）**、类型化消息、stream-json 解析。

裸跑 CLI 要把这些全部重写，且要自己追 CLI 协议的版本变动——**协议兼容性更差**。而 SDK 已暴露 CLI 自控口子：

- `pathToClaudeCodeExecutable` —— 指定/钉自己的 CLI 二进制
- `extraArgs` —— 透传任意 CLI flag
- `executable` / `executableArgs` —— 选 JS 运行时

结论：**底层保留 SDK**（用 `pathToClaudeCodeExecutable`/`extraArgs` 拿到 CLI 自控），"provider 统一"放在**自有薄 runner 接口**（`run() + native + control`）这一层达成，不靠裸 CLI。裸 CLI 仅作"某 provider 无像样 SDK / SDK 严重落后 CLI"的逐 provider 退路。

### 6.4 代价

- **native 事件量更大**：Claude 每个 `content_block_delta`、partial message 全量上行，比 Worker 转换后再发的量大 → Event Log 的"大 payload 落文件 / `payloadRef`"策略权重上升。
- **Worker 不能纯单向**：permission / interrupt 决定了 control 通道是刚需。
- **Worker 仍按 provider 区分**（执行层无法 provider 无关），只是不再背协议转换。

## 7. 迁移路径与工程量

### 7.1 开发策略：设计自顶向下，实现自底向上

- **设计自顶向下**：先定 3 个映射器的输出契约（`ThreadMessage` / `ToolProcessItem` / 诊断时间线），再**反推** AgentEvent schema。避免"SDK 吐什么记什么"导致无人消费的字段（原草案 50 type 的毛病）。
- **实现自底向上**：Event Log → 映射器 → Runtime → UI 切换最后。每层 additive、可独立验证、不破坏现有聊天。
- **中间打一根垂直贯穿桩**：先用 Claude + 流式纯文本端到端打通一遍（`native → AgentEvent → Event Log → assistant-message 投影 → useExternalStoreRuntime → 渲染`），用最少代码验证全层接缝，再铺宽。避免纯 bottom-up 把集成风险压到最后。

### 7.2 分阶段计划（替换是收尾，不是开局）

体量按 1 名有经验工程师估算，含测试。AG-UI 触点共约 6200 行；改动核心见 7.3。

| Phase | 内容 | 体量 | 风险 | 并行 |
| --- | --- | --- | --- | --- |
| **0. Event Log** | 现有 raw/AG-UI/worker 落统一索引（seq/source/type/ids/payloadRef）+ 读取 API。**live 零改动** | 1–2 周 | 低 | — |
| **1. 新 source 域事件** | permission(control 通道)/worker/sandbox/auth/raw/task 写入 log | 2–3 周 | 中（permission 来回是新机制） | 部分 |
| **2. tool process / diagnostics 投影** | 从 Event Log 投影 + 管理端/会话页面板，独立 API，不碰 wire | 1.5–2.5 周 | 低 | ✅ 与 1 并行 |
| ~~3. 自有 message 投影 + Agent Runtime~~（**暂缓**） | 重写 live 聚合 + `useAgeWorkAssistantRuntime`(`useExternalStoreRuntime`) + 自有 SSE client + middleware/interceptor 迁移 + 与 `useAgUiRuntime` shadow 对比 | 3–5 周 | **高** | — |
| ~~4. 移除 AG-UI~~（**暂缓**） | 摘 `useAgUiRuntime`、删 `@ag-ui/*` 依赖、清理 fork aggregator、adapter 转换收尾 | 1–1.5 周 + 稳定期 | 中 | — |
| | **当前活跃合计（Phase 0–2 + 可靠性）** | **~5–8 周** | | |

> Phase 3/4 暂缓（见 1.2 当前决策）：移除 AG-UI ≈ 重写一遍 `useAgUiRuntime`，性价比低。当前只做 Phase 0–2 + 可靠性，全部 additive、不触碰 AG-UI。

风险**不均匀**：80% 集中在 Phase 3——重写 `useAgUiRuntime` 替你做的 live 增量聚合（流式文本拼接、tool start/args/end/result、reasoning block、status 流转，以及 adapter 里那些 quirk：并行 tool 悬挂清理、frontend-tool halt、signature 聚合、thinking-only 不发空消息）。其余是机械替换。

**为什么分阶段而非 big-bang**：Phase 0–2（约 5–7 周、低风险）就兑现"可控/去黑盒/排查"的大部分价值，且全程不破坏现有聊天；Phase 3 这个高危重写放在有 shadow 对比的位置做，过 parity 才翻 flag；Phase 4 可逆收尾。任何阶段卡住都停在可用状态。big-bang 把 Phase 3 当开局，前期无可交付物、易整体不可用、无法二分定位——不建议。

### 7.3 改动核心清单

**后端**：`claude/codex adapter`(~2400，拆 runner + 转换)、`runtime-event-processor.ts`(649，改写 log+投影)、`runtime-message-aggregator.ts`(358，重定位为 projector)、`agent-event-log.service.ts`(129，扩成索引)、`agent-run-handler/controller/run-agent-input`(~300)、`shared/protocol/transport.ts`。

**前端**：`use-agent-chat-runtime.ts`(74，**唯一 `useAgUiRuntime` 调用点**→`useExternalStoreRuntime`)、`chat-http-agent.ts`(19，→自有 SSE client)、`agent-middleware.ts`(154)、`agent-run-interceptor.ts`(239)、`thread-history-adapter.ts`(258，改走 projection API)。

**可复用不动**：`thread-message.ts`(已是 StoredMessage→ThreadMessage 投影器)、`thread-list-adapter.ts`、`pending-question-resume.ts`，及已有大量 `.test`/`.spec`（对 Phase 3 parity 验证是利好）。

## 8. Claude / Codex 映射（精简）

只列进 log 的关键映射；细粒度 UI 事件沿用现有 adapter→AG-UI 逻辑，写入 `agui` 域。

### Claude

| Claude native | source / type |
| --- | --- |
| 任意 `SDKMessage` | `sdk` / `sdk.raw` |
| `SDKSystemMessage(init)` | `runtime` / `runtime.init` |
| `SDKStatusMessage` | `runtime` / `runtime.status` |
| `SDKAPIRetryMessage` | `runtime` / `runtime.api_retry` |
| `SDKAuthStatusMessage` | `runtime` / `runtime.auth` |
| `SDKRateLimitEvent` | `runtime` / `runtime.rate_limit` |
| `canUseTool` 回调进入 / 返回 | `control` / `permission.requested` / `permission.resolved` |
| `SDKPermissionDeniedMessage` | `control` / `permission.denied` |
| task 系列 | `task` / `task.*` |
| 现有 AG-UI 输出 | `agui` / 原 event name |

### Codex

| Codex native | source / type |
| --- | --- |
| 任意 `ThreadEvent` | `sdk` / `sdk.raw` |
| `thread.started` | `runtime` / `runtime.init`（session id） |
| `error`(retryable) | `worker`/`runtime` warning |
| `todo_list` item | `task` / `plan.updated` |
| 现有 AG-UI 输出 | `agui` / 原 event name |

Codex 注意：item id 多轮可能复用，用 `runId + native item.id` 唯一化；item update 是全量快照，delta 在投影层 diff（Phase 2/3）。

## 9. 可靠性分级

| 等级 | 事件 | 策略 |
| --- | --- | --- |
| Critical | terminal `run` 状态、`RUN_ERROR`、`permission.*`、control ack | 失败不静默，重试或进错误态 |
| Important | `TOOL_CALL_START`/`RESULT`、`message` 完成、`worker.seq_gap` | 重试或留可见 trace |
| Normal | text/reasoning/args delta、`tool.progress` | 投影可压缩，raw 可选 |
| Debug | `sdk.raw` 大 payload、`MESSAGES_SNAPSHOT` | payloadRef，可截断 |

## 10. 待定决策（实现前需拍板）

- **存储**：log 索引入库 + 大 payload 落 JSONL / blob / 对象存储，三选一需先定（承重项）。
- **permission control 通道**的具体形态：`resolvePermission` 入口 vs 注入决策 Promise。
- **Phase 3 message 时机**：`message.started` 是否推迟到首个 text delta（沿用当前 adapter 已解决的"thinking-only 不发空消息"行为）。
