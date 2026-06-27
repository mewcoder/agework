# OpenHands 对 AgeWork 的升级启发与优先级路线

> 日期：2026-06-22  
> 核心问题：从 `~/code/agent-project` 中的 OpenHands 源码与分析文档提炼哪些设计，可以优先升级 AgeWork 的 Agent Workbench / Control Plane 架构。  
> 研究范围：`/Users/mew/code/agent-project` 中的 OpenHands、software-agent-sdk、agent-canvas 及根目录分析文档；AgeWork 当前 `apps/api`、`apps/worker`、`packages/adapters`、`packages/shared`、`docs` 与 Prisma schema。  
> 验证方式：先读你写的对照文档，再用 OpenHands / software-agent-sdk 源码和 AgeWork 当前实现交叉确认。未运行 build/lint/browser；本次只产出设计文档。

---

## 一、结论摘要

AgeWork 当前方向是对的：它不是一个本地 Agent 面板，而是一个可私有化部署、可治理、可扩展的 Agent Workbench / Control Plane。OpenHands 最值得借鉴的不是它内置的 CodeAct Agent，而是它把 Agent 平台拆成几个稳定原语的方式：

```text
Event -> State -> Conversation -> Agent
         + Workspace / Tool / Security / Hook / Callback / Sandbox metadata
```

对 AgeWork 来说，最高价值的升级不是“照搬 OpenHands SDK”，而是围绕现有 Runtime Provider + Worker + Adapter + AG-UI 链路补齐以下能力：

1. 把 Agent Event Log 从调试 trace 升级为事实源，支持查询、重放、投影和诊断。
2. 把 pending input / approval / control 从内存队列升级为可恢复队列，保证长任务和刷新/重启后的可靠性。
3. 建立明确的 Run / Conversation 状态机与转移规则，补上 stuck / pause / waiting 的产品语义。
4. 抽出薄的 AgentBackend / Runner 边界，让 Claude、Codex、未来 ACP/A2A 后端都统一产出 native event + control，而不是直接耦合 AG-UI。
5. 强化 Workspace / Sandbox / Tool / Hook 的治理边界，为团队部署、审计、权限和自动化做基础。

优先级建议：先做 P0 的“事实源 + 队列 + 状态机”，再做 P1 的“后端抽象 + workspace/sandbox 防腐层”，最后再考虑 ACP、复杂工具系统、hooks marketplace 等扩展能力。

---

## 二、当前 AgeWork 状态

从当前源码看，AgeWork 已经具备比较扎实的控制面骨架：

| 维度 | 当前实现 | 关键文件 |
| --- | --- | --- |
| 产品定位 | Local-first / self-hosted Agent Workbench | `README.md`, `docs/product-positioning-and-direction.md` |
| 运行分层 | Web -> API -> RuntimeRunner -> Local/Sandbox Provider -> Worker -> Adapter | `ARCHITECTURE.md`, `packages/shared/src/protocol/transport.ts` |
| Runtime Provider | local fork、sandbox docker/opensandbox、workspace/user 隔离、心跳、idle watchdog | `apps/api/src/runtime/providers/*` |
| 事件处理 | `RuntimeEventProcessor` 处理 `run.status`、`agui.event`、`sdk.raw`、`control.trace` | `apps/api/src/runtime/core/runtime-event-processor.ts` |
| 诊断表 | `RunEvent` 存摘要级事件，支持 run detail 查询 | `apps/api/prisma/schema.prisma`, `RunEventRecordService` |
| 原始 trace | `AgentEventLogService` 写 raw/agui JSONL 调试文件 | `apps/api/src/runtime/core/agent-event-log.service.ts` |
| 消息聚合 | 后端用 `@assistant-ui/react-ag-ui` 的 `RunAggregator` 做持久化快照 | `runtime-message-aggregator.ts` |
| 控制通道 | local IPC 直送；sandbox 用内存 `RuntimeControlQueue` 和 worker long-poll | `runtime-control-queue.ts`, `apps/worker/src/main.ts` |
| 人机交互 | Claude permission / AskUserQuestion 通过合成 AG-UI tool call + `pendingQuestions` Map | `packages/adapters/src/claude/business/claude-agent.adapter.ts` |
| Sandbox 资源 | `RuntimeResource` / `WorkspaceRuntime` 记录持久容器绑定 | Prisma schema, `workspace-runtime.service.ts` |

主要差距不在“有没有 runtime”，而在“事实源、状态、控制、投影、资源生命周期是否足够可恢复、可审计、可扩展”。

---

## 三、OpenHands 可借鉴设计

### 1. Event 是系统脊柱

OpenHands / software-agent-sdk 的核心是 append-only EventLog。源码中的 `Event` 是 frozen Pydantic model，带 `id`、`timestamp`、`source`，并通过 discriminated union 保证序列化后能还原类型。

值得注意：你写的文档里提到 JSONL；当前 `software-agent-sdk` 源码版本里 `EventLog` 实际使用 file store + `event-{idx}-{event_id}.json` + lock 的方式。存储形态可以变化，但不变量是：事件 append-only、可重放、状态由事件投影得到，SQL 主要存元数据。

AgeWork 启发：

- `RunEvent` 摘要表和 raw/agui trace 文件应收敛到“一个可查询的 Agent Event Log 事实源”。
- AG-UI 继续作为 live UI 协议没问题，但应逐步变成 Event Log 的一个投影，而不是唯一语义来源。
- 大 payload 走 `payloadRef`，DB 只存 envelope、索引字段、预览和关联 id。

### 2. State / View 是事件投影，不是另一份事实

OpenHands `ConversationState` 保存 execution status、stats、secret registry、hook 状态等，同时持有 `EventLog`。它还有一个增量 `View`，通过 watermark 只消费新增事件，避免每次全量 replay。

AgeWork 启发：

- `Conversation.activeRunStatus`、`Message`、tool process、diagnostics 都应被定义为 Event Log 的投影。
- 当前 live AG-UI 聚合和 history 后端聚合存在双路径，短期可接受，但需要 projection parity 机制监控漂移。
- 后端聚合器不要成为事实源，它只是 projector。

### 3. Conversation 是生命周期编排器

OpenHands 的 `LocalConversation` 做三件事：持有 state、驱动主循环、管理状态转移。它用锁保证同一时间只有一个写入者，避免读到半步状态。

AgeWork 不是 Python 同进程 agent loop，不需要照搬锁模型；但需要借鉴它的状态机边界：

- 明确 Run 状态转移矩阵。
- 明确 `requires_action` / waiting / pause / cancelling / terminal 的含义。
- 明确哪些状态允许追加用户消息，哪些只能排队。
- terminal guard、恢复、孤儿 run 清理要从“经验逻辑”沉淀成状态机规则。

### 4. Agent 是薄接口，而不是平台本体

OpenHands 的 `AgentBase.step(state) -> AgentStepResult` 让平台对 Agent 实现无感。ACPAgent 更说明这一点：它不自己实现 agent 行为，只是 stdio JSON-RPC 客户端，把 Claude Code / Codex / Gemini 的远端更新翻译为 OpenHands Event。

AgeWork 当前 adapter 直接输出 AG-UI event，短期效率高，但长期会把“执行、native event、AG-UI 投影、人机控制”混在 worker/adapters 里。

AgeWork 启发：

- 增加 `AgentBackend` 或 `AgentRunner` 薄接口：`start/run`, `interrupt`, `resolveControl`, `events/native`.
- Worker 负责执行和 control 回调；API/平台负责 native -> AgentEvent -> AG-UI / Message / Diagnostics 投影。
- 不要为了“统一”裸跑 CLI；继续 SDK-first，把 CLI fallback 作为逐 provider 退路。

### 5. SQL 存元数据，事件流可独立存储

OpenHands 的 app_server SQL 表主要存 conversation metadata、pending messages、event callbacks、sandbox records、start tasks 等；事件流本身不在这些业务表中。

AgeWork 已经使用 Prisma，因此更适合混合方案：

- DB 存事件 envelope 和索引字段。
- 大 payload / raw provider event 存文件或对象存储，用 `payloadRef` 关联。
- `RunEvent` 可以保留为 diagnostics projection，也可以逐步成为 Agent Event Log 的查询视图。

### 6. Pending message / callback 是长任务可靠性的关键

OpenHands 有 `pending_messages`：当 conversation 还没 ready 或连接未建立时，用户消息先排队，并限制单会话最多 10 条。还有 `event_callback` / `event_callback_result`，用于对特定事件触发 webhook、自动标题等处理器。

AgeWork 当前 `RuntimeControlQueue` 是内存 Map；permission 等待状态通过 adapter 内 Map 管理。只要 API/worker 重启，部分 control/pending 状态就难恢复。

AgeWork 启发：

- 引入 `PendingControl` / `PendingUserInput` 表。
- approval/question 先写 Event Log，再投影 UI，再等待 resolution。
- control 的 sent/received/handled/failed 全链路应可从 DB 查到。
- event callbacks 是未来 automation、webhook、审计、自动标题、CI 集成的基础。

### 7. Workspace / Sandbox 是防腐层

OpenHands `BaseWorkspace` 把 execute command、file upload/download、git changes/diff、pause/resume 统一成接口；具体实现可以是 local/docker/remote/cloud。remote sandbox service 还把 sandbox 元数据存在本地 SQL，并在 pause/resume 时轮换 session key hash。

AgeWork 已经有 RuntimePlacement、RuntimeResource、WorkspaceRuntime，方向相近，但还可以补：

- runtime resource 的状态、key hash、暴露服务、最后心跳、暂停/恢复原因。
- key 不只在内存里存在，至少存 hash 和版本，用于恢复/吊销审计。
- workspace capability facade：API 不直接关心 local/docker/opensandbox 的路径和命令差异。

### 8. Tool / Security / Hook 是治理扩展，不是第一阶段核心

OpenHands 工具体系有 `ToolDefinition`、`ToolExecutor`、Action / Observation、risk annotations、resource declaration、interrupt。Hooks 覆盖 PreToolUse、PostToolUse、UserPromptSubmit、SessionStart、SessionEnd、Stop。Security analyzer 能给 action 分风险等级。

AgeWork 现在主要接 Claude/Codex 自带工具和 permission 回调。短期不应重写一套完整 tool executor，否则会偏离“深度接少数 Agent”的主线。

更合适的路线：

- 先把 provider 工具调用标准化为 Event Log 事实。
- 再做 tool process / permission / audit 投影。
- 最后才考虑 AgeWork 自有工具注册、hook、policy engine。

---

## 四、差距与优先级

优先级定义：

- P0：影响可靠性、可恢复、可审计，是控制面成立的基础。
- P1：影响可扩展边界和团队部署能力，建议在核心链路稳定后做。
- P2：提升治理、自动化和高级体验，可渐进引入。
- P3：生态扩展或重型能力，依赖 P0/P1。

| 优先级 | 项目 | 当前状态 | OpenHands 启发 | 建议范围 | 工作量 |
| --- | --- | --- | --- | --- | --- |
| P0 | Agent Event Log 事实源 v1 | raw/agui trace 文件 + RunEvent 摘要表分散 | append-only EventLog 是系统脊柱 | 新增统一 AgentEvent envelope、DB 索引、payloadRef、查询 API；保留 AG-UI | M |
| P0 | Projection parity | live `useAgUiRuntime` 与后端 `RuntimeMessageAggregator` 双聚合 | State/View 是投影 | 建 AgentEvent -> Message/Tool/Diagnostics projector，shadow 对比现有聚合 | M |
| P0 | Durable pending control/input | control queue 和 pending question 多为内存态 | pending_messages + callback result 可恢复 | 增加 PendingControl/PendingUserInput，control 状态全链路落库 | M |
| P0 | Run 状态机硬化 | 已有状态和 terminal guard，但规则散在 service/provider | ConversationExecutionStatus 明确 | 写转移矩阵、统一 guard、补 pause/waiting/stuck/recover 语义 | S-M |
| P1 | AgentBackend / Runner 边界 | adapter 直接产 AG-UI，worker 混合执行与转换 | Agent 是 `step/state -> events` 薄接口 | 定义 provider-native runner；API 拥有 native -> AgentEvent 契约 | L |
| P1 | Workspace capability facade | runtimePath / mountTarget 已有，但文件/git/artifact 能力分散 | BaseWorkspace 防腐层 | 抽象 execute/read/write/git/artifact/pause/resume 能力接口 | M |
| P1 | Sandbox resource registry | 有 RuntimeResource/WorkspaceRuntime，但 key 和 runtime 细节部分在内存 | v1_remote_sandbox + key hash + pause/resume | 增加 key hash/version、exposed urls、pause/resume/lastHeartbeat/limit policy | M |
| P1 | Diagnostics / tool process 视图 | RunEvent 有摘要，UI 诊断可继续增强 | EventLog 多投影 | 从 AgentEvent 生成 tool timeline、control timeline、worker/runtime timeline | M |
| P2 | Event callback / webhook | 暂无通用事件订阅处理器 | event_callback / event_callback_result | 为 run/conversation event 增加 processor 表和结果表 | M |
| P2 | Stuck detector | 暂无明确循环检测 | StuckDetector 扫最近事件 | 基于 AgentEvent/tool/error/reasoning 实现 stuck heuristic | S-M |
| P2 | Tool risk / policy layer | Claude permission 已可用，但非统一策略 | Tool annotations + SecurityRisk | 给 tool/command/file event 加 risk projection，先做审计后做拦截 | M |
| P2 | Conversation metadata 丰富化 | Conversation/Run 已有基础字段和 usage | metadata 存成本、token、trigger、tags、parent | 加 tags、trigger、parentRun/parentConversation、budget/context 指标 | S-M |
| P3 | ACP / A2A backend | 目前 SDK-first Claude/Codex | ACPAgent 作为远端协议客户端 | AgentBackend 稳定后接 ACP，不作为近期主线 | L |
| P3 | 自有 Tool SDK | 主要依赖 provider 自带工具 | ToolDefinition / Action / Observation | 只有在自研 Agent 或平台工具成为主线时再做 | L |

---

## 五、P0 详细方案

### P0-1：Agent Event Log 事实源 v1

目标：让“一个 run 到底发生了什么”有唯一查询入口。

建议 envelope：

```ts
type AgentEvent = {
  schemaVersion: 1;
  eventId: string;
  runId: string;
  conversationId: string;
  workspaceId: string;
  seq: number;
  source: "agui" | "sdk" | "worker" | "runtime" | "control" | "task";
  type: string;
  agentType: "claude" | "codex" | (string & {});
  observedAt: string;
  occurredAt?: string;
  level?: "debug" | "info" | "warn" | "error";
  ids?: {
    sessionId?: string;
    messageId?: string;
    toolCallId?: string;
    parentMessageId?: string;
  };
  payloadPreview?: string;
  payload?: unknown;
  payloadRef?: string;
  native?: {
    type: string;
    subtype?: string;
    id?: string;
  };
};
```

落地建议：

1. 新增 Prisma 表 `AgentEvent`，或先扩展 `RunEvent` 为事实源表。更推荐新增表，保留 `RunEvent` 作为摘要/诊断投影，避免概念混用。
2. `RuntimeEventProcessor.publish()` 在处理所有 envelope 前先写 AgentEvent。
3. `AgentEventLogService` 从“写 raw/agui 文件”变为“写 payloadRef + 文件存储”的底层组件。
4. 管理端 run detail 先读 `RunEvent`，同时提供 raw AgentEvent tab。
5. 保留当前 AG-UI SSE 链路，不在第一阶段替换。

验收：

- 任意 run 可按 seq 查询完整 AgentEvent。
- raw/agui/control/runtime/worker 事件有统一 runId、seq、source、type。
- 大 payload 不塞爆 SQLite / Postgres。
- 关闭 trace 文件时，DB 仍有可诊断的事件索引。

### P0-2：Projection parity

目标：把“事实源”和“UI 消息”分开，同时不冒险替换当前 AG-UI live runtime。

步骤：

1. 新建 `AgentEventProjector`，初期只消费 `source=agui` 事件，产出 assistant-ui message snapshot。
2. 与当前 `RuntimeMessageAggregator` 并行运行，记录 hash / message count / status 是否一致。
3. 差异写入 `RunEvent` 或 `AgentEvent(source="runtime", type="projection.drift")`。
4. 稳定后让 history 读取 projector 结果；live 仍可继续用 AG-UI。

验收：

- 同一个 run 的终态消息，AG-UI aggregator 与 AgeWork projector 一致。
- projection drift 可被 run detail 看到。
- projector 可从已落库事件重建消息。

### P0-3：Durable pending control/input

目标：审批、用户补充消息、interrupt/cancel 的控制链路可追溯、可恢复。

建议新增：

```text
PendingControl
  id, commandId, runId, conversationId, workspaceId
  type, payload, status
  seq, createdAt, deliveredAt, handledAt, failedAt, error

PendingUserInput
  id, conversationId, runId?
  kind: "message" | "approval" | "question"
  payload, status, createdAt, resolvedAt
```

变化：

- `RuntimeControlQueue.push*()` 同步写 DB，再入内存队列。
- worker poll 时按 DB/内存组合交付，handled/failed 后更新状态。
- `permission.requested` 先进 AgentEvent，再更新 `Conversation.pendingUserAction`。
- API 重启后可扫描 pending controls，重新装入队列或标记 failed/retryable。

验收：

- API 重启后，未处理的 approval 仍可在 UI 恢复。
- run detail 能看到 control.sent -> received -> handled/failed。
- pending 队列有上限，防止同一 conversation 无限积压。

### P0-4：Run 状态机硬化

目标：把散落在 handler、runner、processor、provider 中的状态规则收敛。

建议先写文档和单测，不必大改实现：

```text
queued -> preparing -> running
running -> requires_action -> running
running -> cancelling -> cancelled
running -> finished | error | stuck
preparing -> cancelling -> cancelled
requires_action -> cancelling -> cancelled
```

需要明确：

- `Conversation.activeRunStatus` 是 Run 状态投影，不是独立事实源。
- `pendingUserAction` 来自 AgentEvent / PendingUserInput 投影。
- `stuck` 是否作为 Run terminal status，还是 `error` 的 reason。
- terminal 后任何 delayed exit handler 不得覆盖终态。

验收：

- 状态转移有集中函数和精准单测。
- 非法转移只记 diagnostics，不改 DB。
- recovery service 能根据 DB 状态判断 orphan run、lost worker、pending approval。

---

## 六、P1/P2 设计方向

### P1：AgentBackend / Runner

建议接口方向：

```ts
interface AgentBackend {
  readonly kind: "claude" | "codex" | "acp" | string;
  start(input: AgentRunInput, ctx: AgentRunContext): AsyncIterable<AgentNativeEvent>;
  interrupt(runId: string): Promise<void>;
  resolveControl(control: AgentControl): Promise<void>;
}
```

迁移方式：

1. 先在 worker 内包一层，不改变外部行为。
2. Claude/Codex adapter 仍输出 AG-UI，但同时输出 native/raw 标准事件。
3. API 侧逐步拥有 native -> AgentEvent -> AG-UI 投影。
4. 等 projector 稳定后，worker 可以变薄。

不建议：

- 不要为了统一而立即裸跑 Claude/Codex CLI。
- 不要把 OpenHands 的 CodeAct Agent 模型搬进 AgeWork。
- 不要一次性替换 AG-UI live runtime。

### P1：Workspace capability facade

AgeWork 可以抽象：

```ts
interface WorkspaceCapability {
  resolvePath(workspaceId: string): Promise<WorkspacePath>;
  gitChanges(workspaceId: string): Promise<GitChange[]>;
  gitDiff(workspaceId: string, path?: string): Promise<GitDiff>;
  artifactRef(runId: string, artifact: ArtifactInput): Promise<ArtifactRef>;
  pause?(resourceKey: string): Promise<void>;
  resume?(resourceKey: string): Promise<void>;
}
```

价值：

- UI/agent/admin API 不直接知道 local/docker/opensandbox 路径差异。
- 后续做文件树、diff、artifact、review、PR 集成更自然。
- 对团队部署来说，这是 sandbox 防腐层。

### P1：Sandbox resource registry

当前 `RuntimeResource` 已经是好基础。建议补齐：

- `status`: starting/running/paused/stopped/stale/error/missing。
- `lastHeartbeatAt`, `lastStartedAt`, `lastStoppedAt`。
- `accessKeyHash`, `accessKeyVersion`，不存明文。
- `exposedUrls` / `metadata` 标准字段。
- `pauseReason`, `stopReason`。
- 启动前执行 max running resources 策略。
- resume 时轮换 access key，pause/delete 时吊销 key。

### P2：Event callback / automation

OpenHands 的 event callback 模型很适合 AgeWork 的团队能力：

- 自动标题、自动 summary。
- run finished webhook。
- run error 通知。
- tool permission 审计。
- CI / Issue / Slack / Jira 集成。

建议在 AgentEvent 事实源稳定后做，避免 callback 消费不稳定事件。

### P2：Stuck detector

可先做轻量规则：

- 最近 N 个 tool call 相同且结果相同。
- 最近 N 个 tool error 相同。
- assistant 连续自说自话且无用户输入。
- context/window/rate limit error 连续出现。

输出：

- 写 `AgentEvent(source="runtime", type="runtime.stuck_detected")`。
- Run 可进入 `stuck` 或 `error` + `reason=stuck`。
- UI 给出“中断/继续/总结当前状态”的控制。

---

## 七、不要照搬的部分

| OpenHands 能力 | 不建议照搬原因 | AgeWork 替代路线 |
| --- | --- | --- |
| 完整 CodeAct Agent loop | AgeWork 当前主线是深度接 Claude/Codex，不是自研通用 LLM+Tool Agent | 保持 SDK-first adapter，抽薄 AgentBackend |
| Python SDK 的同进程 Conversation 锁 | AgeWork 是 API + worker 进程模型，写入边界不同 | 用 DB 状态机、seq、terminal guard、pending queue 保证一致性 |
| 全量 ToolDefinition / ToolExecutor | 会过早变成自研 agent 平台，偏离当前产品价值 | 先标准化 provider tool event、permission、diagnostics |
| 事件完全不入 DB | AgeWork 有 admin 查询、审计、团队部署诉求 | DB 存 envelope/索引，payloadRef 存大对象 |
| 立即接 ACP | ACP 有价值，但依赖 AgentBackend 与 Event Log 稳定 | P3 评估，不作为 P0/P1 阻塞项 |

---

## 八、验证记录

| 结论 | 验证来源 | 结果 |
| --- | --- | --- |
| OpenHands 核心是 Event/State/Conversation/Agent | `openhands-core-4.md`, `openhands-sdk-blueprint.md`, `software-agent-sdk/openhands-sdk/openhands/sdk/*` | 已验证 |
| OpenHands Event 是 frozen discriminated union | `software-agent-sdk/openhands-sdk/openhands/sdk/event/base.py` | 已验证 |
| 当前 software-agent-sdk EventLog 不是单一 SQL 表 | `conversation/event_store.py` | 已验证；源码为 file store + event json + lock |
| OpenHands SQL 主要存 conversation/sandbox/pending/callback 元数据 | `OpenHands/openhands/app_server/*` | 已验证 |
| AgeWork 已有 RuntimeProvider + Worker + control queue | `packages/shared/src/protocol/transport.ts`, `apps/api/src/runtime/*`, `apps/worker/src/main.ts` | 已验证 |
| AgeWork 已有 RunEvent 摘要与 raw/agui trace 文件 | Prisma schema, `run-event-record.service.ts`, `agent-event-log.service.ts` | 已验证 |
| AgeWork 当前 control queue 主要是内存态 | `runtime-control-queue.ts` | 已验证 |
| Claude permission 通过 pendingQuestions Map + 合成 AG-UI tool call | `claude-agent.adapter.ts` | 已验证 |
| Sandbox access key 当前主要在内存服务中管理 | `runtime-internal-access.service.ts` | 已验证 |

未验证 / 未覆盖：

- 没有运行 AgeWork 测试、类型检查、build 或浏览器验证。
- 没有完整阅读 OpenHands enterprise 44 张表，只参考了你的数据库设计文档和部分 app_server 源码。
- 没有验证 OpenHands 最新上游实现是否与本地 `agent-project` 完全一致，本报告只基于本地参考目录。

---

## 九、建议下一步

1. 先落一份 `AgentEvent` Prisma schema 设计稿，明确和 `RunEvent` 的关系。
2. 为 `RuntimeEventProcessor.publish()` 增加事实源写入路径，但不改变 SSE / AG-UI 行为。
3. 做 `AgentEvent -> Message` shadow projector，与当前 `RuntimeMessageAggregator` 做 parity 记录。
4. 增加 `PendingControl` 持久化，让 approval/control 的 sent/received/handled/failed 可恢复。
5. 补一份 Run 状态机文档和单测，把终态、requires_action、cancel、recovery 的规则固定下来。

如果只选一个开工点，建议选 **Agent Event Log 事实源 v1**。它是后续 tool process、diagnostics、pending recovery、callbacks、stuck detection、ACP 接入的共同地基。
