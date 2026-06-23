# OpenHands → AgeWork 升级路线图

> 从 OpenHands SDK 架构中提取对 AgeWork（TypeScript + NestJS + Prisma + AG-UI）有实际价值的设计思想，
> 按 **投入产出比** 排序：P0 = 高价值低成本，P3 = 高价值高成本。

---

## P0：立即可做，改动小，收益大

### 1. Conversation 聚合根化

**OpenHands 做法**：`Conversation` 是唯一入口，持有 State + 驱动主循环 + 管理生命周期。外部只跟 Conversation 交互，不直接操作内部状态。

**AgeWork 现状**：逻辑分散在 `AgentRunHandler`、`ConversationService`、`RuntimeRunner`、`RuntimeEventProcessor` 四个地方。创建 run、保存消息、状态转移、SSE 管理各管一摊。

**建议**：
- 将 `ConversationService` 升级为聚合根，统一管理：
  - Run 创建与状态转移（乐观锁已有，但逻辑分散）
  - 消息持久化（目前在 AgentRunHandler 和 RuntimeMessageAggregator 两处）
  - 活跃状态派生（`activeRunStatus` 目前靠 Run 状态反推）
- 好处：消除 `AgentRunHandler.run()` 里 200+ 行的编排逻辑，降低跨 service 状态不一致风险。

**改动范围**：`apps/api/src/conversations/` + `apps/api/src/agent/`

---

### 2. Run 事件流持久化（轻量事件溯源）

**OpenHands 做法**：Event 是不可变的 append-only log。State = replay(events)。事件流从不入库，始终是 JSONL。

**AgeWork 现状**：有 `RunEvent` 表但只做审计日志，不参与状态重建。消息靠 `RuntimeMessageAggregator` 在内存中聚合，中途崩溃丢失聚合状态。

**建议**：
- 将 `RuntimeMessageAggregator` 的聚合状态改为可从 `RunEvent` 重建：
  - 每个 AG-UI event 入库时带 `seq`（已有）+ `type` + `payload`
  - 恢复时按 seq 重放，重建消息快照
  - 定期打 checkpoint（已有 `RuntimeMessageAggregator.build()` 的 periodic save）
- 好处：SSE 断连后 resume 不依赖内存；worker 崩溃后消息不丢。

**改动范围**：`apps/api/src/runtime/core/runtime-event-processor.ts` + `runtime-message-aggregator.ts`

---

### 3. Stuck 检测

**OpenHands 做法**：`ConversationState` 有 `stuck_detection` 字段，`StuckDetector` 检测 agent 是否陷入循环（重复相同操作），自动终止并标记 `STUCK` 状态。

**AgeWork 现状**：无。agent 卡死只能靠用户手动 stop 或心跳超时（60s）。

**建议**：
- 在 `RuntimeEventProcessor` 中加轻量 stuck 检测：
  - 连续 N 次相同 tool_call（name + args 哈希）→ 标记 `error` + 记录原因
  - 连续 M 分钟无新 event（非 idle 等待）→ 警告
- 好处：避免 LLM 费用无限烧、用户体验卡死。

**改动范围**：`apps/api/src/runtime/core/` 新增 `stuck-detector.ts`

---

## P1：中等投入，架构收益显著

### 4. Agent 接口统一为 `step(state) → events`

**OpenHands 做法**：Agent 只需实现一个方法 `step(state) → AgentStepResult(events)`。平台对 Agent 内部一无所知——LLM 调用、tool 执行、context 拼装全在 Agent 内部（或外包给远端 ACP server）。

**AgeWork 现状**：Adapter 实现完整的 `AbstractAgent.run(input): Observable<BaseEvent>`，直接管理 SDK 生命周期、流式事件翻译、权限处理。每个 adapter 有 base 层 + business 层，代码量大。

**建议**：
- 定义平台级 Agent 协议接口：
  ```typescript
  interface AgentRunner {
    step(state: ConversationState): Promise<AgentStepResult>
  }
  interface AgentStepResult {
    events: DomainEvent[]
    status?: 'running' | 'finished' | 'error'
  }
  ```
- 现有 adapter 作为 `AgentRunner` 实现，内部仍然调 Claude/Codex SDK
- 平台主循环只调 `step()`，不关心内部实现
- 好处：新增 agent 类型只需实现一个接口；平台逻辑与 agent 逻辑完全解耦。

**改动范围**：`packages/shared/src/protocol/` 新增接口 + `packages/adapters/` 重构

---

### 5. 工具注册表（Tool Registry）

**OpenHands 做法**：`Tool` 是 `name + schema + executor` 的三元组，有统一注册中心 `list_usable_tools()`。工具可以被 hook 拦截、被 security analyzer 审批。

**AgeWork 现状**：工具由 agent SDK 自己管理（Claude 的 `canUseTool`、Codex 的内部工具）。平台层无法感知有哪些工具、无法拦截、无法审计。

**建议**：
- 在平台层建立工具元数据注册表（不需要执行器，只需要 schema）：
  ```typescript
  interface ToolDefinition {
    name: string
    description: string
    parameters: JSONSchema
    requiresApproval: boolean
  }
  ```
- 从 AG-UI `TOOL_CALL_START` 事件中提取工具名，与注册表比对
- 用途：权限审批 UI 可以展示工具描述；审计可以统计工具使用频率。

**改动范围**：`packages/shared/` 新增类型 + `apps/api/src/agent/` 集成

---

### 6. Token 用量追踪与预算控制

**OpenHands 做法**：`conversation_metadata` 表跟踪 `accumulated_cost`、`prompt_tokens`、`completion_tokens`、`cache_read_tokens`、`reasoning_tokens`、`max_budget_per_task`。每次 LLM 调用后更新。

**AgeWork 现状**：`Run` 表有 `usage` JSON 字段，但没有汇总到 Conversation 级别，也没有预算控制。

**建议**：
- `Conversation` 表新增 `accumulatedCost`、`totalTokens` 字段
- `RuntimeEventProcessor` 处理 `RUN_FINISHED` 时更新（已有 `normalizeRunUsage` 逻辑）
- 前端展示累计 token/cost
- 可选：`maxBudgetPerConversation` 超预算自动 stop

**改动范围**：Prisma schema + `conversation.service.ts` + `runtime-event-processor.ts`

---

### 7. 消息队列（Pending Messages）

**OpenHands 做法**：`pending_messages` 表——会话还没 ready（STARTING）时，用户发的消息先排队，等会话变 RUNNING 再投递。

**AgeWork 现状**：用户在 run 进行中发消息需要等 run 结束。如果 SSE 断连后重连，消息可能丢失。

**建议**：
- 复用现有 `Message` 表，加 `deliveryStatus` 字段：`pending` | `delivered`
- `AgentRunHandler` 启动 run 前先检查 pending messages
- 好处：支持"快速连发多条消息"场景。

**改动范围**：Prisma schema + `conversation.service.ts`

---

## P2：需要一定重构，架构价值高

### 8. Event Bus 解耦（发布-订阅）

**OpenHands 做法**：Event 产生后走三条路：写入 EventLog（持久化）、广播 WebSocket（前端）、触发 Hook（扩展逻辑）。三条路独立，互不阻塞。

**AgeWork 现状**：`RuntimeEventProcessor.publish()` 是唯一的事件汇入点，但内部是顺序处理：更新 DB → 推 SSE → 聚合消息。任何一步阻塞会影响后续。

**建议**：
- 将 `publish()` 拆为：入站处理（去重 + 落库）→ 发布到内部 EventBus → 三个独立 subscriber：
  - `SseSubscriber`：推给前端
  - `AggregatorSubscriber`：聚合消息快照
  - `HookSubscriber`：触发扩展逻辑（未来用）
- 好处：各 subscriber 独立、可测试、可扩展。

**改动范围**：`apps/api/src/runtime/core/runtime-event-processor.ts` 重构

---

### 9. 会话状态机显式化

**OpenHands 做法**：`ConversationExecutionStatus` 是 8 态枚举（IDLE/RUNNING/PAUSED/WAITING_FOR_CONFIRMATION/FINISHED/ERROR/STUCK/DELETING），有明确的 `is_terminal()` 判断和状态转移规则。

**AgeWork 现状**：`Conversation.activeRunStatus` 派生自 Run 状态，没有独立的状态机。`RunStatus` 有 8 个值但转移规则隐含在代码逻辑中。

**建议**：
- 提取显式状态机：
  ```typescript
  const transitions: Record<RunStatus, RunStatus[]> = {
    queued: ['running', 'cancelled'],
    preparing: ['running', 'error'],
    running: ['finished', 'error', 'requires_action', 'cancelling'],
    requires_action: ['running', 'cancelled'],
    cancelling: ['cancelled', 'error'],
    finished: [],
    error: [],
    cancelled: [],
  }
  ```
- `RunRecordService` 做转移前校验，非法转移抛异常
- 好处：状态流转可测试、可审计、不依赖隐式代码路径。

**改动范围**：`apps/api/src/runtime/core/run-record.service.ts`

---

### 10. 事件回调系统（Webhook + 内部回调）

**OpenHands 做法**：`event_callback` 表支持注册回调——当特定事件发生时，触发 webhook POST 或内部处理器（如自动设置标题、日志记录）。

**AgeWork 现状**：只有 SSE 推送。标题生成是硬编码在 `AgentRunHandler` 里的。

**建议**：
- 建立轻量回调机制：
  - 数据库表 `EventCallback`：`conversationId?`、`eventKind`、`processorType`、`callbackUrl?`、`status`
  - 内置处理器：`SetTitleProcessor`（已有逻辑抽取）、`LogProcessor`
  - 外部 webhook：POST 到 `callbackUrl`，带签名
- 好处：扩展性——用户可以注册自己的 webhook 做集成。

**改动范围**：Prisma schema + `apps/api/src/runtime/core/` 新增回调模块

---

## P3：大投入，长远价值

### 11. 多层持久化分层

**OpenHands 做法**：4 层金字塔——SDK 用 JSONL、agent-server 用 FileStore、app_server 用 SQL、enterprise 用 PostgreSQL。每层用最合适的存储。

**AgeWork 现状**：单一 PostgreSQL（或 SQLite）。事件、消息、元数据全在同一层。

**建议**（渐进式）：
- **短期**：热数据（当前 run 的事件）留在内存 + 写 DB；冷数据（历史 run）定期归档到文件存储
- **中期**：引入事件文件存储层（JSONL），DB 只存元数据和索引
- **长期**：按需引入 Redis 做热状态缓存
- 好处：降低 DB 压力，事件流天然适合文件存储。

**改动范围**：架构级重构，分阶段实施

---

### 12. Workspace 抽象层（防腐层）

**OpenHands 做法**：`BaseWorkspace` 是纯接口，实现在独立包 `openhands-workspace`：local/docker/apptainer/cloud/remote。平台代码只依赖接口。

**AgeWork 现状**：`RuntimeProvider` 已有 local/sandbox 之分，但 `SandboxRuntimeProvider` 内部直接耦合 Docker API。切换到其他容器运行时需要改 provider 代码。

**建议**：
- 提取 `SandboxEngine` 接口（已有雏形）：
  ```typescript
  interface SandboxEngine {
    create(spec: SandboxSpec): Promise<SandboxInstance>
    start(instanceId: string): Promise<void>
    stop(instanceId: string): Promise<void>
    destroy(instanceId: string): Promise<void>
    status(instanceId: string): Promise<SandboxStatus>
  }
  ```
- Docker、OpenSandbox、未来 Firecracker 都实现此接口
- `SandboxRuntimeProvider` 只依赖接口，不关心具体引擎

**改动范围**：`apps/api/src/runtime/providers/` 重构

---

### 13. 子 Agent 委派

**OpenHands 做法**：`subagent/` 模块 + `task/` 工具——主 agent 可以 spawn 子 agent 执行子任务，子 agent 的事件流挂在主会话下（`parent_conversation_id`）。

**AgeWork 现状**：无。每个 Conversation 只有一个 Run。

**建议**（远期）：
- `Conversation` 表加 `parentConversationId`
- Run 支持 `agentKind` 字段区分主 agent / 子 agent
- 子 agent 的事件流合并到父会话的事件流中
- 好处：支持复杂任务拆分。

**改动范围**：Prisma schema + 核心运行时重构

---

### 14. Condenser（长上下文压缩）

**OpenHands 做法**：`Condenser` 模块——当 event 历史超过 context window 时，自动压缩旧 events 为摘要，保持 context 在可控范围。

**AgeWork 现状**：依赖 agent SDK 自己管理 context window。长对话会超限。

**建议**（远期）：
- 在平台层实现轻量 condenser：
  - 当 events 超过 N 条或 token 超过阈值
  - 将旧 events 压缩为摘要 MessageEvent
  - 保留最近 M 条原始 events
- 好处：长对话不超限，token 成本可控。

**改动范围**：`apps/api/src/runtime/core/` 新增 condenser 模块

---

## 优先级总结

| 优先级 | 项目 | 核心收益 | 预估工作量 |
|--------|------|----------|-----------|
| **P0** | Conversation 聚合根化 | 消除逻辑分散，降低状态不一致 | 2-3 天 |
| **P0** | Run 事件流可重建 | SSE resume 不依赖内存，崩溃恢复 | 1-2 天 |
| **P0** | Stuck 检测 | 避免 LLM 费用无限烧 | 0.5 天 |
| **P1** | Agent 接口统一 `step()` | 新增 agent 类型成本极低 | 3-5 天 |
| **P1** | 工具注册表 | 权限 UI + 工具审计 | 1-2 天 |
| **P1** | Token 用量追踪与预算 | 成本可见 + 防超支 | 1 天 |
| **P1** | 消息队列 | 支持连发消息 + 断连恢复 | 1 天 |
| **P2** | Event Bus 解耦 | 可扩展 + 可测试 | 2-3 天 |
| **P2** | 状态机显式化 | 状态流转可审计 | 1 天 |
| **P2** | 事件回调系统 | Webhook 集成能力 | 2-3 天 |
| **P3** | 多层持久化分层 | 降低 DB 压力 | 5-7 天 |
| **P3** | Workspace 抽象层 | 容器运行时可插拔 | 3-5 天 |
| **P3** | 子 Agent 委派 | 复杂任务拆分 | 5-7 天 |
| **P3** | Condenser | 长对话不超限 | 3-5 天 |

---

---

## P0 具体实施方案

### P0-1：Conversation 聚合根化

**当前问题**：
- `AgentRunHandler.run()` (`apps/api/src/agent/agent-run-handler.ts:43-318`) 是 275 行的编排函数，混合了状态转移、消息持久化、SSE 设置、Run 创建
- 消息保存分散在两处：`saveUserMessage()` 在 handler 里（line 247），assistant 消息通过 `saveRun` 回调链在 `RuntimeEventProcessor` 里
- `setActiveRunStatus()` (`conversation.service.ts:343-355`) 只有 `idle|running|error` 三种状态，但 Run 有 8 种状态，两套状态体系不同步

**改动计划**：

```
Step 1: 提取 ConversationDomainService
  - 文件：apps/api/src/conversations/conversation-domain.service.ts（新建）
  - 职责：统一管理 conversation 级别的状态转移
  - 方法：
    - beginRun(conversationId, runConfig) → Run
      - 乐观锁检查 activeRunStatus
      - 创建 Run 记录
      - 保存 user message
      - 返回 Run 对象
    - completeRun(conversationId, runId, result)
      - 保存 assistant message
      - 更新 Run 状态
      - 重置 activeRunStatus
    - failRun(conversationId, runId, error)
      - 标记 Run error
      - 重置 activeRunStatus

Step 2: 简化 AgentRunHandler.run()
  - 将 line 201-299 的编排逻辑委托给 ConversationDomainService
  - Handler 只负责：解析输入 → 调 domain service → 设置 SSE → 启动 runtime

Step 3: 统一状态模型
  - Conversation.activeRunStatus 扩展为与 Run.status 对齐
  - 或者：废弃 activeRunStatus，改用派生查询（查最新 Run 状态）
```

**验证**：现有 e2e 测试覆盖 run 生命周期；补充 unit test 测试状态转移边界。

---

### P0-2：Run 事件流可重建

**当前问题**：
- `RuntimeMessageAggregator` (`apps/api/src/runtime/core/runtime-message-aggregator.ts`) 纯内存，进程崩溃丢失聚合状态
- SSE 断连后 resume 依赖内存中的 aggregator 快照（`streamingSnapshot` 模式）
- `RunEvent` 表只做审计，不参与状态重建

**改动计划**：

```
Step 1: RunEvent 增加聚合所需字段
  - schema.prisma RunEvent 模型加字段：
    - messageSnapshot Json?  // 每个事件处理后的消息快照（可选，按需打）
  - 或者：不加字段，靠 seq + type 重放

Step 2: 实现 EventReplayer
  - 文件：apps/api/src/runtime/core/event-replayer.ts（新建）
  - 方法：replay(runId) → AssistantMessageContent
    - 按 seq 顺序读取该 run 的所有 agui 类型 RunEvent
    - 逐个喂给一个新的 RuntimeMessageAggregator
    - 返回最终快照
  - 用途：进程重启后恢复 aggregator 状态

Step 3: 在 resumeStream() 中使用 EventReplayer
  - runtime-runner.ts 的 attachStream() 方法
  - 如果 handle.aggregator 为空（进程重启过），调 eventReplayer.replay()
  - 将重建的快照推给新 SSE 连接

Step 4: 定期 checkpoint
  - runtime-event-processor.ts handleAgUiEvent()
  - 每 20 个 chunk 已有 saveRun(false)（line 324-334）
  - 确保 saveRun 同时将当前 aggregator.build() 结果写入 RunEvent 的 snapshot 字段
```

**验证**：写 unit test 模拟"写入 N 个事件 → 重建 → 比对快照"。

---

### P0-3：Stuck 检测

**当前问题**：
- `Run.lastHeartbeatAt` 字段已存在（`schema.prisma:148`），但没有任何代码检查它是否过期
- `RunRecordService.markRunning()` (`run-record.service.ts:55-60`) 是无条件 update，不检查当前状态——terminal 状态的 run 可以被重新标记为 running
- 唯一的超时机制是 provider 级别的 `HeartbeatWatchdog`（60s），但这只检测 worker 进程存活，不检测 agent 是否卡死

**改动计划**：

```
Step 1: 修复 markRunning() 无条件更新 bug
  - run-record.service.ts:55-60
  - 改为 updateMany + WHERE status IN ACTIVE_RUN_STATUSES（与其他 mark 方法一致）

Step 2: 实现 StuckDetector
  - 文件：apps/api/src/runtime/core/stuck-detector.ts（新建）
  - 两种检测模式：
    a) 心跳超时：Run.status="running" && lastHeartbeatAt < now() - 90s → stuck
    b) 重复操作：连续 3 次相同 tool_call name+args 哈希 → stuck（需要在 handleAgUiEvent 中跟踪）
  - 触发动作：
    - 调 runtimeEventProcessor.forceErrorStatus(runId, "stuck: heartbeat timeout")
    - 或发 cancel control 给 worker

Step 3: 启动定时扫描
  - 在 RuntimeRunner 或 RuntimeEventProcessor 初始化时启动 setInterval
  - 每 30s 扫描一次 findAllActive() 中 status="running" 的 runs
  - 检查 lastHeartbeatAt 是否超时
  - 或者：在 handleHeartbeat() 中对比时间戳（更轻量，但依赖 worker 发心跳）

Step 4: Conversation.activeRunStatus 增加 "stuck" 状态（可选）
  - 或者直接映射为 "error"，在 error message 中标注 stuck 原因
```

**验证**：写 unit test 模拟"心跳停止 → 检测 → 标记 error"。

---

## 核心设计原则（从 OpenHands 提炼）

1. **平台对 Agent 一无所知** — Agent 是可插拔的，平台只负责 event → state → persist → broadcast
2. **事件流是真理源** — 状态可从事件重建，不依赖内存
3. **聚合根边界清晰** — Conversation 管理一切子实体（Run、Message、Event），外部不直接操作内部
4. **每层用最合适的存储** — 不是所有数据都需要进 SQL
5. **状态转移是显式的** — 用枚举 + 转移表，不用隐式代码路径
