# Runtime ID 命名规范与不一致分析

> **状态：** 本文档提出的 `Thread -> Conversation`、`providerType/runtimeId -> runtimeType/runtimeResourceId`、`agentResumeId -> agentSessionId` 等重命名已通过
> `docs/superpowers/plans/2026-06-12-conversation-runtime-naming-refactor.md` 完成，本文档仅作历史分析记录保留。
>
> **目的：** 梳理 AgeWork runtime 中所有 ID 变量的含义、层级关系和命名不一致问题，给出统一建议。
> **适用范围：** `packages/shared`、`apps/api/src/runtime`、`apps/worker`、`apps/web/src/lib/runtime`

---

## 0. 当前命名决策

### 业务会话：`Conversation / conversationId`

AgeWork 自己的业务会话建议统一命名为 `Conversation`，对应 ID 为 `conversationId`。

当前代码中的 `Thread / threadId` 主要来自 assistant-ui 的框架概念。后续重命名时，应把 assistant-ui 的 `threadId` 限制在适配层内部；AgeWork 业务层、API、Prisma、前端状态和路由都应优先使用 `conversationId`。

推荐映射：

| 层 | 推荐命名 | 说明 |
|---|---|---|
| AgeWork 业务域 | `Conversation` / `conversationId` | 用户可见的会话 |
| assistant-ui 适配层 | `threadId` / `remoteId` | 框架要求的 thread 概念 |
| URL | `/c/$conversationId` | 如需兼容旧链接，可从 `/t/$threadId` 重定向 |

### 单次执行：保留 `Run / runId`

`runId` 保留。前提是它在全链路中始终是同一个值，且只表示一次 agent 执行：

```
AG-UI input.runId
  → AgeWork Run.id
  → RunConfig.runId
  → worker / adapter input.runId
  → AG-UI event.runId
  → SSE / runtime envelope.runId
```

因此 `Run` 不是新的业务会话概念，而是 AG-UI/runtime 的一次执行在 AgeWork 中的持久化记录。一个 `Conversation` 可以包含多个 `Run`。

约束：

- `runId` 只能表示一次 agent execution。
- 不能把 `workspaceId`、`conversationId` 或 provider 原生会话 ID 塞进 `runId` 字段。
- 如果某个 control/envelope 是 workspace 级作用域，应显式使用 workspace scope 字段，而不是复用 `runId`。

### 运行资源：`runtimeType / runtimeResourceId`

当前代码中的 `providerType + runtimeId` 后续建议统一改为 `runtimeType + runtimeResourceId`。

原因：

- `providerType` 容易把实现层的 provider 概念暴露到核心 Run 模型里；这里实际表达的是运行环境类型。
- `runtimeId` 太泛，容易被理解成 AgeWork runtime 本身的 ID；当前它实际是底层运行资源的句柄。
- `runtimeResourceId` 不暗示一对一实例关系，适合 Docker 持久容器这类多个 Run 共享同一个底层资源的场景。

推荐含义：

| 字段 | 含义 | 示例 |
|---|---|---|
| `runtimeType` | 运行环境类型 | `local`、`docker`、`opensandbox` |
| `runtimeResourceId` | 底层运行资源标识 | `pid:startToken`、`containerId`、`sandboxId` |

推荐映射：

| 当前字段 | 目标字段 |
|---|---|
| `Run.providerType` | `Run.runtimeType` |
| `Run.runtimeId` | `Run.runtimeResourceId` |
| `RuntimeHandle.providerType` | `RuntimeHandle.runtimeType` |
| `RuntimeHandle.runtimeId` | `RuntimeHandle.runtimeResourceId` |

### Agent 会话：`agentSessionId`

当前代码中的 `agentResumeId` 后续建议统一改为 `agentSessionId`。

原因：

- `agentResumeId` 描述的是用途（resume），不是 ID 的本质。
- `agentSessionId` 更直接表达它是 agent/provider 内部的会话标识。
- 它与 `conversationId` 不同层：`conversationId` 是 AgeWork 业务会话 ID，`agentSessionId` 是 Claude/Codex 等 agent 的内部会话 ID。

推荐含义：

| 字段 | 含义 | 示例来源 |
|---|---|---|
| `conversationId` | AgeWork 业务会话 ID | `Conversation.id` |
| `runId` | 一次 agent 执行 ID | AG-UI `input.runId` / `event.runId` |
| `agentSessionId` | agent/provider 内部会话 ID，用于跨 Run 续接 | Claude `system:init.session_id`、Codex `thread_id` |

推荐映射：

| 当前字段 | 目标字段 |
|---|---|
| `Thread.agentResumeId` | `Conversation.agentSessionId` |
| `ThreadResponse.agentResumeId` | `ConversationResponse.agentSessionId` |
| `AgentTraceMeta.agentResumeId` | `AgentTraceMeta.agentSessionId` |
| `AgentTraceRun.setResumeId()` | `AgentTraceRun.setAgentSessionId()` |

---

## 1. ID 层级关系

```
Workspace (workspaceId)                       ← 容器粒度、文件系统边界
  └── Conversation (conversationId)           ← 用户可见的会话，可跨 Run 恢复
        ├── Run (runId)                       ← 每条用户消息通常触发一次 Run
        │     └── runtimeResourceId           ← 底层进程/容器/沙箱资源标识
        └── agentSessionId                   ← 跨 Run 的 agent/provider 内部会话标识
```

**一句话总结：** 一个 Workspace 有多个 Conversation，一个 Conversation 有多个 Run，每个 Run 可绑定一个 runtimeResourceId。agentSessionId 跨 Run 保持 agent 会话连续性。

---

## 2. 各 ID 详解

### workspaceId

| 属性 | 值 |
|---|---|
| **类型** | CUID（Prisma auto-generate） |
| **Prisma 列** | `Workspace.id` |
| **API DTO** | `WorkspaceResponse.id` |
| **协议** | `RunConfig.workspaceId` |
| **语义** | 工作空间/项目，Docker 容器粒度（一个 workspace 一个持久容器） |
| **前后端** | ✅ 前端 `selectedWorkspaceId`、后端 `workspaceContainers` Map key |

### threadId

| 属性 | 值 |
|---|---|
| **类型** | CUID（Prisma auto-generate） |
| **Prisma 列** | `Thread.id` |
| **API DTO** | `ThreadResponse.threadId`（从 `Thread.id` 重命名） |
| **协议** | `RunConfig.threadId`、`RuntimeHandle.threadId` |
| **语义** | 对话线程，用户可见的主标识 |
| **前后端** | ✅ 前端核心路由 `/t/$threadId`、后端 `ThreadService` 参数 |
| **注意** | assistant-ui 框架将其映射为 `remoteId`（`thread-list-adapter.ts:13`） |

### runId

| 属性 | 值 |
|---|---|
| **类型** | UUID（`agent-run-handler.ts:31` 生成） |
| **Prisma 列** | `Run.id` |
| **API DTO** | `AdminRunResponse.id`（保持 Prisma 列名） |
| **协议** | `RunConfig.runId`、`RuntimeHandle.runId`、`Envelope.runId` |
| **语义** | 一次 agent 执行（一条消息一轮），runtime 内部流转的核心标识 |
| **前后端** | ⚠️ 前端很少直接用，主要是后端 runtime + worker 内部流转 |

### runtimeId

| 属性 | 值 |
|---|---|
| **类型** | string（provider 自定义格式） |
| **格式** | Local: `pid:startToken`；Docker: containerId |
| **Prisma 列** | `Run.runtimeId`（nullable） |
| **协议** | `RuntimeHandle.runtimeId` |
| **语义** | 底层计算资源标识，用于孤儿恢复 |
| **前后端** | ❌ 仅后端使用 |

### agentResumeId

| 属性 | 值 |
|---|---|
| **类型** | string（Agent SDK 事件生成） |
| **Prisma 列** | `Thread.agentResumeId` |
| **API DTO** | `ThreadResponse.agentResumeId` |
| **语义** | 跨 Run 的 agent 会话恢复（如 Claude 的 `--resume`） |
| **来源** | AG-UI `system:init` 事件的 `session_id` 字段 |

---

## 3. 命名不一致清单

### 🔴 A. 同一概念三个名字：agentResumeId / agentSessionId / session_id

| 位置 | 名字 | 文件 |
|---|---|---|
| Prisma / API DTO | `agentResumeId` | `schema.prisma:72`、`threads.ts:16` |
| Trace Logger | `agentSessionId` | `agent-trace-logger.ts:14` |
| AG-UI 事件 | `session_id` | `runtime-event-processor.ts:237` |

**影响：** 阅读事件处理流程时需要脑内翻译三次。Trace Logger 的 `setSessionId()` 接收的值最终写入 `Thread.agentResumeId`，但函数名和字段名完全不同。

**建议：** 统一为 `agentResumeId`。Trace Logger 的 `AgentTraceMeta.agentSessionId` → `agentResumeId`，`setSessionId()` → `setResumeId()`。AG-UI 事件中的 `session_id` 是上游协议字段无法修改，但在消费处加注释说明映射关系。

---

### 🔴 B. HeartbeatWatchdog 参数名 `runId` 但 Docker 传入 `workspaceId`

**当前代码：**

```ts
// runtime-provider-utils.ts — 参数名是 runId
class HeartbeatWatchdog {
  start(runId: string, onTimeout: () => void) { ... }
  beat(runId: string) { ... }
  stop(runId: string) { ... }
}

// docker-runtime-provider.ts — 传入的是 workspaceId
this.heartbeats.start(workspaceId, () => { ... });
this.heartbeats.beat(workspaceId);
this.heartbeats.stop(workspaceId);
```

**影响：** 阅读代码时误以为 watchdog 按 runId 跟踪，实际 Docker 模式下按 workspaceId 跟踪。这直接导致了 code review 中发现的心跳掩盖 per-run 死锁问题。

**建议：** 将 HeartbeatWatchdog 的参数名从 `runId` 改为 `key: string`，表明它只是一个通用的字符串 key，语义由调用方决定。

---

### 🔴 C. `nextControlEnvelope` 参数名 `runId` 但 Docker 传入 `workspaceId`

**当前代码：**

```ts
// runtime-provider-utils.ts:83 — 参数名是 runId
export function nextControlEnvelope(
  controlSeqs: Map<string, number>,
  runId: string,     // ← 实际可能是 workspaceId
  control: ControlPayload
)

// docker-runtime-provider.ts:303 — 传入的是 workspaceId
nextControlEnvelope(this.controlSeqs, workspaceId, control)
```

**影响：** 同上，参数名与实际语义不一致。

**建议：** 将 `nextControlEnvelope` 的第二个参数名从 `runId` 改为 `key: string`，与 HeartbeatWatchdog 统一。

---

### 🟡 D. 实体 ID 字段命名不统一：`id` vs `threadId`

| 实体 | Prisma 列 | API DTO 字段 | Request DTO 字段 |
|---|---|---|---|
| Workspace | `id` | `id` | `WorkspaceIdRequest.id` |
| Thread | `id` | **`threadId`** | **`ThreadIdRequest.threadId`** |
| Run | `id` | `id` | — |

Thread 是唯一把 Prisma `id` 重命名为 `threadId` 的实体（`thread.service.ts:39`）。Workspace 和 Run 保留 `id`。

**影响：** 前端调用 API 时，workspace 和 run 用 `id`，thread 用 `threadId`，需要记住哪个实体用哪个字段名。

**建议（两选一）：**

1. **统一用带前缀的名称：** Workspace → `workspaceId`，Thread → `threadId`（已有），Run → `runId`。改动较大但最一致。
2. **统一用 `id`：** Thread DTO 改回 `id`，与 Workspace/Run 一致。但前端路由和大量代码已用 `threadId`，改动更大。

推荐方案 1，因为 `threadId` 已是前端核心标识，改回 `id` 代价更高。只需把 `WorkspaceResponse.id` → `workspaceId`、`AdminRunResponse.id` → `runId`。但这是一个较大的 breaking change，建议单独排期。

---

### 🟡 E. `runtimeId` vs `containerId` 同值双名

Docker provider 中 `DockerWorkspaceState.containerId` 和 `RuntimeHandle.runtimeId` 存储同一个值（Docker 容器 ID）。代码已有注释承认：`/** runtimeId 即 containerId */`（`docker-runtime-provider.ts:375`）。

**影响：** 在 Docker provider 内部阅读代码时需要记住两者是同一个值。`getHandle()` 中 `runtimeId: state.containerId` 就是一个映射点。

**建议：** 这是合理的分层（内部实现用 `containerId`，协议接口用 `runtimeId`），不建议消除。但应在 `DockerWorkspaceState` 类型上加注释说明 `containerId` 即 `RuntimeHandle.runtimeId`。

---

### 🟡 F. `controlSeqs` Map key 语义因 Provider 而异

| Provider | Map 名 | Key 含义 |
|---|---|---|
| Local | `controlSeqs` | **runId** |
| Docker | `controlSeqs` | **workspaceId** |

**影响：** 同名变量不同语义。修改 Local provider 的 controlSeqs 逻辑时，可能误以为 Docker 用法相同。

**建议：** 不改变量名（它是 private），但在 Docker provider 的 `controlSeqs` 声明处加注释说明 key 是 workspaceId。或者将 key 统一为 workspaceId（Local provider 每个 run 独占进程，workspaceId = runId 概念上等价）。

---

### 🟡 G. 前端 `remoteId` = 后端 `threadId`

`ThreadResponse.threadId` 在 assistant-ui adapter 层被映射为 `remoteId`（`thread-list-adapter.ts:13`）。

**影响：** 仅前端内部，且是 assistant-ui 框架的命名约定。

**建议：** 不改。这是框架层的映射，在 adapter 文件中已有清晰的映射代码，改了反而与框架不一致。

---

## 4. Map Key 汇总表

下表列出所有以 ID 为 key 的 Map，帮助理解哪个 ID 在哪里被用作索引：

| Map | Key | 值 | 所在文件 |
|---|---|---|---|
| `RuntimeActiveStore.handles` | `runId` | `RunHandle` | `runtime-active-store.ts` |
| `LocalRuntimeProvider.states` | `runId` | `LocalRunState` | `local-runtime-provider.ts` |
| `DockerRuntimeProvider.workspaceContainers` | **workspaceId** | `DockerWorkspaceState` | `docker-runtime-provider.ts` |
| `DockerRuntimeProvider.pendingContainers` | **workspaceId** | `Promise<string>` | `docker-runtime-provider.ts` |
| `DockerWorkspaceState.activeRuns` | **runId** | **threadId** | `docker-runtime-provider.ts` |
| `LocalRuntimeProvider.controlSeqs` | runId | number | `local-runtime-provider.ts` |
| `DockerRuntimeProvider.controlSeqs` | **workspaceId** | number | `docker-runtime-provider.ts` |
| `RuntimeControlQueue.queues` | runId | `Envelope[]` | `runtime-control-queue.ts` |
| `RuntimeControlQueue.workspaceQueues` | **workspaceId** | `Envelope[]` | `runtime-control-queue.ts` |
| `HeartbeatWatchdog.lastHeartbeats` | runId 或 **workspaceId** | number | `runtime-provider-utils.ts` |
| `HeartbeatWatchdog.timers` | runId 或 **workspaceId** | `Timeout` | `runtime-provider-utils.ts` |
| `RuntimeConfigStore.configs` | runId | `RunConfig` | `runtime-config-store.ts` |
| `RuntimeInternalAccessService.accessKeys` | runId | string(key) | `runtime-internal-access.service.ts` |
| `RuntimeInternalAccessService.workspaceKeys` | **workspaceId** | string(key) | `runtime-internal-access.service.ts` |
| `RunMultiplexer.runs`（worker） | runId | `{ threadId, sub }` | `run-multiplexer.ts` |
| `threadToRun`（worker persistent） | **threadId** | runId | `main.ts` |

**加粗** 表示该 key 在当前使用场景下是 workspace 级别而非 run 级别。

---

## 5. 修复优先级建议

| 优先级 | 问题 | 建议改动 | 改动量 |
|---|---|---|---|
| **P0** | B. HeartbeatWatchdog 参数名 `runId` | 参数名改为 `key: string` | 小（3 个方法签名 + 对应调用处注释） |
| **P0** | C. `nextControlEnvelope` 参数名 `runId` | 参数名改为 `key: string` | 小（1 个函数签名） |
| **P1** | A. agentResumeId 三名问题 | Trace Logger 统一为 `agentResumeId` | 小（2 处字段名 + 1 处方法名） |
| **P2** | D. 实体 ID 字段命名不统一 | `WorkspaceResponse.id` → `workspaceId`、`AdminRunResponse.id` → `runId` | 中（DTO + 前端消费处） |
| **P2** | F. `controlSeqs` key 语义 | 加注释说明 Docker 下 key 是 workspaceId | 小 |
| **P3** | E. `runtimeId` vs `containerId` | 在 `DockerWorkspaceState` 类型上加注释 | 小 |
| **不改** | G. `remoteId` = `threadId` | 框架约定，保持不变 | — |

P0 建议立即修——参数名误导是 code review 中多个 bug 的间接原因（心跳掩盖 per-run 死锁、cancel 控制语义混淆等）。P1 影响可读性但不影响正确性。P2/P3 是命名一致性改进，可排期。
