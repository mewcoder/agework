# AgeWork Agent 运行基础设施设计 v2

> 本文是 `2026-06-10-agent-runtime-infrastructure-design.md` 的修订版，不替换原文件。v2 保留原设计的 Provider / Transport / Workspace 分层，但补齐事件可靠性、跨进程 HITL、Run 与 Thread 状态边界、worker 职责、密钥边界和恢复清理策略。

## 0. v2 关键修订

- **worker 不聚合 assistant-ui 消息**：worker 只运行 Agent Adapter，并上报原始 AG-UI event 与生命周期 envelope；`RunAggregator` 只在 API 控制面运行，避免双重聚合。
- **Run 是运行事实源，Thread 状态由 active/latest Run 派生**：保留给前端的 thread DTO 字段，但不再把 `Thread.runStatus` 当事实源。
- **本期不夸大可靠性语义**：阶段 1-3 的 Local/Ipc 是有序 IPC + 进程内去重；阶段 4 的 HttpTransport 若声明 at-least-once，必须同步引入最小 `run_events` inbox 表。
- **HITL 必须跨进程控制**：API 不再直接调用 adapter 包里的进程内 `resolveQuestion()`；答案通过 `ControlPayload.approval_resolved` 发给 worker，由 worker 内部 resolver 完成。
- **RunConfig 由 API 组装，worker 不访问业务数据库**：API 解析 model config、workspace、policy、secrets 后生成最小运行配置；worker 只拿运行所需字段。
- **恢复和清理是显式能力**：Run 表保存 `runtimeId`、heartbeat、terminal status；provider 实现启动恢复扫描、超时回收和 orphan cleanup。

## 1. 背景与目标

AgeWork 是一个多 Agent 工作台。现状是单体 NestJS：`AgentController.run()` 在 `apps/api` 进程内创建 Claude/Codex adapter，订阅 `Observable<BaseEvent>`，通过 SSE 直接下发给前端，并用 `RunAggregator` 聚合成 assistant-ui `Message` 入库。

这套模式适合本地单用户，但要同时支持：

- **本地/客户端**：打开即用、无需额外沙箱、原生路径体验。
- **服务器多用户沙箱**：用户互不信任，Agent 必须运行在容器/沙箱里，受资源、网络、文件系统边界约束。

目标是把“Agent 怎么运行”从 API 业务逻辑中拆出来，形成稳定运行基础设施：

- Agent 在哪执行：本地子进程、Docker、后续 K8s / microVM / custom runner。
- 控制面与 worker 怎么通信：IPC、HTTP、后续队列或 runner API。
- workspace 怎么映射成 Agent 看到的 cwd：直接用、mount、后续 sync。

## 2. 分层原则

调用方只选择 provider，不感知具体执行环境。

| 层 | 抽象 | 吸收的差异 | 本期/近期实现 |
|---|---|---|---|
| 执行环境 | `RuntimeProvider` | fork / docker run / remote runner | Local / Docker |
| 通信通道 | `RuntimeTransport` | IPC / HTTP poll+post | Ipc / Http |
| 文件映射 | `WorkspaceMapping` | direct / mount / sync | direct / mount |
| 事件汇入口 | `RunEventBus` | transport 差异、去重、落库节奏 | API 侧统一处理 |

Agent Adapter 只拿到 `runtimePath` 作为 cwd。它不知道自己是在宿主机、容器还是远程 runner 里运行，也不知道事件是 IPC 还是 HTTP 上报。

## 3. 总体架构

```text
AG-UI Client (apps/web)
  -> API 控制面 (apps/api)
      用户 / 项目 / 线程 / 消息 / Run 管理
      RuntimeProviderRegistry.resolve()
        -> RuntimeProvider(Local | Docker)
            prepareRun: 解析 Workspace、组装 RunConfig、准备 transport 控制面端
            start: fork worker / docker run worker
              -> Runtime Worker (apps/worker)
                  fetchRunConfig()
                  创建 Agent Adapter
                  订阅 Adapter Observable<BaseEvent>
                  通过 RuntimeTransport.emit() 上报原始 AG-UI event
                  通过 RuntimeTransport.subscribeControls() 接收 cancel / HITL
```

事件方向：

```text
Agent SDK
  -> Agent Adapter
  -> 原始 AG-UI Event
  -> worker RuntimeTransport.emit(agui.event)
  -> API RunEventBus.publish()
      -> SSE subscribers
      -> RunAggregator
      -> Message upsert
      -> Run 状态更新
```

控制方向：

```text
AG-UI Client
  -> API endpoint
  -> RunService 找到 active Run
  -> RuntimeProvider.sendControl()
  -> RuntimeTransport control
  -> worker
  -> Agent Adapter / SDK
```

## 4. 运行边界与职责

### 4.1 API 控制面职责

- 鉴权、用户/项目/thread/message 业务逻辑。
- 创建 Run，选择 provider。
- 解析 `Workspace.locator`，生成 `runtimePath` 映射。
- 从数据库读取 model config，组装最小 `RunConfig`。
- 持有 SSE subscriber 和 `RunAggregator`。
- 处理 worker 上报事件，更新 Run、派发 SSE、聚合并写入 Message。
- 接收 stop / HITL answer，并通过 provider 下发 control。
- 启动时扫描非终态 Run，执行恢复或标记失败。

### 4.2 Worker 职责

- 只依赖 `@agework/protocol`、`@agework/adapters` 和 transport 实现。
- 启动后 `fetchRunConfig()`。
- 按 `agentType` 创建 adapter。
- 将 adapter 产生的每个原始 AG-UI event 包成 `agui.event` envelope 上报。
- 上报 `run.status`、`heartbeat`、必要的 `artifact.ref`。
- 维护当前进程内 adapter handle 与 pending HITL resolver。
- 接收 `cancel` / `interrupt` / `approval_resolved` / `user_message` control。
- 退出前尽力上报 terminal status；不能依赖 worker 自己完成最终清理。

worker 不做：

- 不访问业务数据库。
- 不聚合 assistant-ui Message。
- 不直接面向浏览器 SSE。
- 不持久化原始事件。

## 5. RuntimeTransport 契约

### 5.1 Envelope

```ts
type EnvelopeType =
  | "run.config"
  | "run.status"
  | "agui.event"
  | "heartbeat"
  | "artifact.ref"
  | "control";

interface Envelope<T = unknown> {
  runId: string;
  seq: number;
  type: EnvelopeType;
  payload: T;
  ts: string;
}
```

`seq` 在同一个方向内单调递增：

- worker -> API：`eventSeq`，用于上行去重与顺序检查。
- API -> worker：`controlSeq`，用于 control 去重与轮询游标。

不要复用同一个 `seq` 域同时表示上行事件和下行 control。HTTP control polling 的 `afterSeq` 指的是 `controlSeq`。

### 5.2 上行消息

```ts
type RunStatus =
  | "queued"
  | "preparing"
  | "running"
  | "requires_action"
  | "cancelling"
  | "finished"
  | "error"
  | "cancelled";

type RunStatusPayload = {
  status: RunStatus;
  phase?: string;
  error?: string;
  reason?: string;
};

type HeartbeatPayload = {
  at: string;
  resource?: {
    rssBytes?: number;
    cpuMs?: number;
  };
};

type UpstreamEnvelope =
  | Envelope<RunStatusPayload>
  | Envelope<BaseEvent>
  | Envelope<HeartbeatPayload>
  | Envelope<ArtifactRefPayload>;
```

### 5.3 下行 control

```ts
type ControlPayload =
  | { type: "cancel"; commandId: string; reason?: string }
  | { type: "interrupt"; commandId: string; reason?: string }
  | {
      type: "approval_resolved";
      commandId: string;
      threadId: string;
      questionId?: string;
      answers: Record<string, string | string[]>;
    }
  | {
      type: "user_message";
      commandId: string;
      message: string;
    };
```

`commandId` 是控制命令的幂等 key。worker 必须记录本进程已处理 commandId，重复 control 直接 ack/忽略。

### 5.4 RuntimeTransport 接口

```ts
interface RuntimeTransport {
  fetchRunConfig(): Promise<RunConfig>;
  emit(msg: UpstreamEnvelope): Promise<void>;
  subscribeControls(cb: (control: Envelope<ControlPayload>) => void): Unsubscribe;
  close(): Promise<void>;
}
```

## 6. 可靠性语义

### 6.1 阶段 1-3：LocalProcessProvider + IpcTransport

本期本地实现采用：

- 单 worker 进程内 `eventSeq` 单调递增。
- IPC 天然按发送顺序到达父进程。
- API 侧对 `(runId, eventSeq)` 做内存去重和顺序断言。
- 原始 AG-UI event 不落库，只落 trace 日志。

因此阶段 1-3 的语义是：**单 API 进程存活期间有序投递，非 durable at-least-once**。

如果 API 进程崩溃，正在运行的 local worker 视为不可恢复，启动扫描将对应 Run 标记为 `error` 或 `cancelled`，并执行 orphan cleanup。

### 6.2 阶段 4：DockerProvider + HttpTransport

如果 HttpTransport 需要声明 `at-least-once + 幂等去重`，阶段 4 必须同步引入最小 inbox 表，而不是等完整 Event Store：

```text
RunEvent {
  runId
  seq
  type
  payloadJson
  ts
  receivedAt

  @@id([runId, seq])
}
```

这张表可以先只作为 transport inbox 和去重依据，不提供回放 UI，也不承担长期审计。完整 Event Store、断线续传、回放能力仍然后置。

HttpTransport 规则：

- worker `POST /internal/runs/{runId}/events` 带 `Idempotency-Key: <runId>:<seq>`。
- API 先插入 `RunEvent(runId, seq)`，唯一约束冲突表示重复事件。
- 插入成功后再调用 `RunEventBus.publish()` 更新 Run、SSE、聚合 Message。
- 如果发现 `seq > lastSeq + 1`，Run 进入 `error` 或 `waiting_for_gap`，不把乱序文本 chunk 交给 aggregator。
- worker 保留有限本地 buffer，收到 2xx 才删除；重试需要退避和最大时间。

## 7. RuntimeProvider

```ts
interface RuntimeProvider {
  type: "local" | "docker";
  prepareRun(input: PrepareRunInput): Promise<PreparedRun>;
  start(prepared: PreparedRun): Promise<RuntimeHandle>;
  sendControl(handle: RuntimeHandle, control: ControlPayload): Promise<void>;
  cancel(handle: RuntimeHandle): Promise<void>;
  cleanup(handle: RuntimeHandle): Promise<void>;
  getStatus(handle: RuntimeHandle): Promise<RuntimeStatus>;
  recover?(run: RunRecord): Promise<RuntimeHandle | null>;
}

interface PreparedRun {
  runId: string;
  runtimePath: string;
  hostPath?: string;
  runConfigRef: RunConfigRef;
  env: Record<string, string>;
  limits?: RuntimeLimits;
  networkPolicy?: RuntimeNetworkPolicy;
  metadata?: Record<string, unknown>;
}

interface RuntimeHandle {
  runId: string;
  providerType: "local" | "docker";
  runtimeId: string;
  metadata?: Record<string, unknown>;
}
```

`runtimeId` 必须可持久化：

- Local：worker child process pid + start token。API 重启后通常不可安全恢复，只用于 cleanup 检测。
- Docker：container id。API 重启后可以通过 Docker API 重新绑定 handle。

## 8. RunConfig 与密钥边界

worker 不访问 Prisma 和业务数据库。API 在 `prepareRun` 前完成业务解析，生成最小 `RunConfig`。

```ts
interface RunConfig {
  runId: string;
  threadId: string;
  projectId: string;
  userId: string;
  agentType: "claude" | "codex";
  runtimePath: string;
  input: RunAgentInput;
  adapter: ClaudeAdapterRuntimeConfig | CodexAdapterRuntimeConfig;
  policy: RuntimePolicy;
  env: Record<string, string>;
}
```

adapter config 示例：

```ts
type ClaudeAdapterRuntimeConfig = {
  kind: "claude";
  model?: string;
  baseUrl?: string;
  apiKey?: SecretRef | InlineSecret;
  isEnvironmentConfig: boolean;
  claudeThinkingMode?: "disabled" | "adaptive";
};

type CodexAdapterRuntimeConfig = {
  kind: "codex";
  model?: string;
  baseUrl?: string;
  apiKey?: SecretRef | InlineSecret;
  modelReasoningEffort?: "low" | "medium" | "high" | "xhigh";
  extraConfig?: Record<string, unknown>;
};
```

规则：

- 本地环境配置模式可以允许 SDK 读取用户本机配置，但只适用于 `LocalProcessProvider`。
- Docker/server 模式默认不挂载 HOME，也不读取宿主配置文件；API 必须通过 RunConfig 注入运行所需认证，或通过 provider 的 secret injection 机制注入。
- `RunConfig` 可以存短期内存 registry；Docker/HTTP 模式下如果 worker 通过 internal API 拉取 config，接口必须使用 run-scoped runtime token。
- trace 日志和错误信息必须脱敏 `apiKey`、token、headers。

## 9. Workspace 模型

Workspace 是数据，不是 provider。建议模型：

```text
Workspace {
  id
  ownerUserId
  locator        string
  locatorType    local_path | managed_path | remote_ref
  status         ready | preparing | error
  metadata       JSON
  createdAt
  updatedAt
}

Project {
  id
  workspaceId
  ...
}
```

关系方向使用 `Project.workspaceId -> Workspace.id`。如果后续需要一个 workspace 被多个 project 共享，可以直接支持；如果不需要，给 `Project.workspaceId` 加唯一约束。

映射策略：

- Local/direct：`runtimePath = canonical(locator)`。
- Docker/mount：`hostPath = canonical(locator)`，容器内 `runtimePath = /workspace`。
- Remote/sync：后置。接口预留，但未实现前 provider 不能选择 sync。

安全规则：

- server managed workspace 必须位于受控 root 下。
- `locator` 入库前做 canonicalize，拒绝指向平台 HOME、数据库目录、`.ssh`、`.aws`、`docker.sock` 等路径。
- Docker mount 默认只挂 workspace，不挂宿主 HOME、平台 env、数据库凭据。
- provider 选择必须考虑 workspace locatorType：服务器多用户默认禁止 `local_path + LocalProcessProvider`。

## 10. Run 模型与 Thread 派生状态

Run 是运行事实源：

```text
Run {
  id
  threadId
  projectId
  userId
  agentType
  providerType
  runtimeId
  status
  phase
  pendingAction
  lastSeq
  lastControlSeq
  lastHeartbeatAt
  error
  startedAt
  finishedAt
  createdAt
  updatedAt
}
```

状态建议：

```text
queued -> preparing -> running -> requires_action -> running
running -> cancelling -> cancelled
running -> finished
running -> error
preparing -> error
```

约束：

- 本期一个 thread 同时最多一个 active Run：`queued/preparing/running/requires_action/cancelling`。
- `pendingAction` 放在 Run 上，thread DTO 可从 latest active Run 派生出 `pendingAction`。
- 前端兼容字段 `thread.runStatus` 继续返回，但由 Run 派生：
  - 无 active Run：`idle`
  - active Run：`running`
  - latest terminal Run 是 `error` 且没有更新消息：`error`
- 后续多 Agent 并行时，thread 级 `runStatus` 需要升级为 summary，不再适合作为唯一状态。

## 11. RunEventBus

`RunEventBus` 在 API 侧，是所有 transport 上行事件的唯一汇入口。

```ts
interface RunEventBus {
  publish(envelope: UpstreamEnvelope): Promise<void>;
}
```

处理顺序：

1. 校验 run 存在且未处于 terminal status。
2. 校验 envelope `runId`、`seq`、`type`。
3. 去重和顺序检查。
4. `run.status` 更新 Run。
5. `heartbeat` 更新 `lastHeartbeatAt` 和资源信息。
6. `agui.event` 先喂给 SSE subscribers，再喂给 API 侧 `RunAggregator`。
7. 聚合 Message 按现有节奏 upsert：chunk interval、边界事件、terminal event。
8. terminal event 或 worker exit 后 finalize Run。

对 AG-UI event 的特别规则：

- `MESSAGES_SNAPSHOT` 仍不直接下发/落库，除非后续明确支持快照恢复。
- `CUSTOM agent.resumeId` / `system:init.session_id` 仍由 API 侧处理，并更新 thread 的 `agentResumeId`。
- 用户主动停止造成的 adapter error 不应渲染成可见失败消息；Run 状态应为 `cancelled`，Message 状态为 incomplete/cancelled。

## 12. HITL 跨进程设计

现状 `resolveQuestion(threadId, answers)` 是进程内 Map 调用。worker 化后必须改为 control。

流程：

```text
Claude canUseTool("AskUserQuestion")
  -> worker 内 pendingQuestions.set(questionId, resolver)
  -> worker emit run.status { status: "requires_action", pendingAction: "question" }
  -> worker emit agui.event 或 custom event，包含 questionId/questions
  -> API RunEventBus 更新 Run.pendingAction
  -> 前端展示问题
  -> POST /agent/threads/:threadId/question-answer
  -> API 查找该 thread 的 active Run
  -> provider.sendControl({ type: "approval_resolved", commandId, questionId, answers })
  -> worker 收到 control，resolve pending question
  -> worker emit run.status { status: "running", pendingAction: null }
```

取消/断开规则：

- 浏览器 SSE close 不停止 Run，但如果 Run 正在 `requires_action`，API 可以下发 `cancel` 或 `approval_resolved` 的拒绝语义，避免 worker 永久等待；具体 UX 需产品决定。
- 用户点击 stop：API 将 Run 置为 `cancelling`，下发 `cancel`。worker 同时 interrupt adapter 和 reject pending HITL resolver。
- worker 收到重复 `approval_resolved.commandId` 必须幂等。

## 13. Provider 实现

### 13.1 LocalProcessProvider + IpcTransport

- `prepareRun` 生成 `RunConfig` 并存入 API 内存 registry。
- `start` 使用 `fork()` 启动 `apps/worker`，注入：
  - `RUNTIME_TRANSPORT=ipc`
  - `AGEWORK_RUN_ID`
  - 必要的最小 env
- API 父进程监听 `child.on("message")`，转为 `RunEventBus.publish()`。
- `sendControl` 使用 `child.send(envelope)`。
- child exit：
  - terminal status 已到达：cleanup。
  - 未到达 terminal：Run 标记 `error` 或 `cancelled`，保存 error。

限制：

- API 重启不可恢复 in-flight local worker；启动扫描直接终结非 terminal local Run。
- 本地无需 runtime token，因为父子进程同机信任。

### 13.2 DockerProvider + HttpTransport

- `prepareRun` 创建 run-scoped runtime token 和 `RunConfig`。
- `start` `docker run` worker 镜像：
  - mount `hostPath:/workspace`
  - env: `RUNTIME_TRANSPORT=http`
  - env: `PLATFORM_API_BASE`
  - env/secret: runtime token
- worker:
  - `GET /internal/runs/{runId}` 拉 config。
  - `POST /internal/runs/{runId}/events` 上报 event。
  - `GET /internal/runs/{runId}/controls?afterSeq=` 轮询 control。
- API 通过 runtime token 校验 run scope。
- cancel 必须同时：
  - 写入 control。
  - 尝试优雅停止 worker。
  - 超时后 kill/remove container。

Docker provider 必须配套 heartbeat timeout 和 container cleanup。

## 14. 恢复、超时与清理

API 启动时：

1. 查找非 terminal Run。
2. Local Run：标记 `error`，reason=`api_restarted`，清理可能残留 child pid。
3. Docker Run：用 `runtimeId` 查询 container。
   - container 仍运行：重新绑定 handle，继续接收 HTTP event/control。
   - container 不存在：标记 `error`，reason=`runtime_lost`。
4. 对 `lastHeartbeatAt` 超过阈值的 Run，触发 provider cleanup 并标记 `error`。

运行中：

- heartbeat timeout：`running/requires_action` -> `error`，下发 cleanup。
- cancel timeout：`cancelling` -> `cancelled`，强制 cleanup。
- finished/error/cancelled 后必须调用 provider cleanup。

## 15. 分阶段落地

### 阶段 1：packages 抽取

- `packages/protocol`：Envelope、RuntimeTransport、RunConfig、ControlPayload、AgentTrace 类型。
- `packages/adapters`：迁移 Claude/Codex base + business adapter。
- `apps/api` 改为引用 workspace packages。
- 行为保持不变。

### 阶段 2：Run / Workspace 模型与 in-process Run 编排

- Prisma 新增 `Workspace`、`Run`。
- `Project.workdir` 语义拆到 `Workspace.locator`；开发期可清库不迁移。
- `AgentController` 不再直接以 `Thread.runStatus` 为事实源。
- 仍 in-process 运行 adapter，但围绕 Run 生命周期编排。
- HITL endpoint 改成“查 active Run -> control dispatch”的形状，即使此阶段 control 仍可由 in-process shim 实现。

### 阶段 3：apps/worker + LocalProcessProvider/IpcTransport

- 新建 `apps/worker`。
- API 侧实现 `LocalProcessProvider` 和 IPC 控制面端。
- worker 侧实现 `IpcTransport`。
- API 侧 `RunEventBus` 统一处理 IPC 上报事件。
- stop/HITL 经 control 下发到 worker。

### 阶段 4：DockerProvider/HttpTransport

- 新增 internal runtime API。
- 新增 runtime token。
- 新增最小 `RunEvent` inbox 表，支撑 HTTP 幂等和 at-least-once。
- Docker mount workspace。
- heartbeat timeout、container cleanup、API 重启恢复。

### 阶段 5：能力暴露与收尾

- `GET /api/v1/runtime/capabilities`。
- 前端按 provider capability 展示限制。
- 更完整的 Event Store、断线续传、回放、artifact store 后置。

## 16. 验证方式

- 阶段 1：`pnpm typecheck`、`pnpm test:api`。
- 阶段 2：Run/Workspace 单测；thread list DTO 从 Run 派生状态；现有聊天/标题/消息历史行为不变。
- 阶段 3：
  - Claude/Codex 本地 worker run 能流式返回。
  - 用户 stop 能中断 worker 内 adapter。
  - HITL question-answer 能跨进程 resolve。
  - 浏览器断开 SSE 后，Run 继续执行并最终落库。
  - worker 异常退出能标记 Run error。
- 阶段 4：
  - HTTP event 重试不会重复写坏 Message。
  - 乱序/缺 seq 不进入 aggregator。
  - Docker mount cwd 正确。
  - runtime token 不能访问其他 run。
  - API 重启后能恢复或正确终结 Docker Run。

## 17. 后置事项

- 完整 Event Store：长期保存、回放、断线续传。
- Workspace sync 映射策略。
- K8s / microVM / custom HTTP runner。
- 多 Agent 并行执行和并排对比。
- Electron / Tauri 客户端壳。
