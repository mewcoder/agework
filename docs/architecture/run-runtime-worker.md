# Run / Runtime / Worker 边界与重构计划

> 本文是 Agent 执行链路的设计与落地计划。核心目标是把
> Run、Runtime、Worker 的职责拆清楚:Run 负责业务编排,Runtime 只准备运行环境,
> Worker 保持薄执行单元。当前不引入 Worker Backend / Agent Server。

## 0. 当前结论

目标边界:

```text
Run 是编排者。
Runtime 只准备运行环境。
Worker 只执行 agent run。

Run -> Runtime
Run -> WorkerExecution
Worker -> Run events

Runtime 不拥有业务 run 状态。
Runtime 目标上不拥有 Worker 语义。
Worker 不依赖 Runtime 语义。
```

一句话:

```text
RunService 调 RuntimeService 准备环境;
RunService 再用 RuntimeResourceHandle + RunConfig 驱动 WorkerExecution;
Worker 只产出事件;
RunService 拥有生命周期、状态、持久化和 SSE。
```

当前代码已经完成 Phase 1-3（含 2f / 3f）的主线重构:

- Run 层 `RunWorkerExecutionService` 是 worker execution owner:自己注入 `RuntimeProviderRegistry`、持有 `runId -> WorkerExecutionHandle` 派发表,直接驱动 provider 的 `startWorkerExecution / sendControl / cancel / heartbeat / cleanup`。
- Runtime 层 `RuntimeService` 已瘦身为纯运行环境门面:只有 `resolvePlacement / provision / heartbeatRuntimeResource / shutdownRuntimeResource`,**不再持有任何 worker execution 方法**。
- Local / Sandbox provider 已经改为 `provision()` + `startWorkerExecution()`。
- 旧 `RuntimeProvider.start()` / `RuntimeService.startWorker()` / 过渡期的 `RuntimeService.startWorkerExecution()` 均已退场。
- `WorkerExecutionHandle` 已独立为共享协议类型,旧 `RuntimeHandle` 已删除。
- `RuntimeProvider` / `RunEventReceiver` 是 API 进程内接口,已移出 `shared/protocol`(分别落在 `runtime/providers/runtime-provider-contracts.ts` 与 `runtime/run-event-receiver.ts`);`shared/protocol` 只留 worker↔api 线缆协议。
- Sandbox provider 已拆成薄 facade + runtime resource service + worker session service。
- worker 心跳 / 手动 stop 的 provider 派发已收口到 `RuntimeService` 门面,内部 / admin 控制器不再注入 `RuntimeProviderRegistry`、不再硬编码 provider type。
- RuntimeResource diagnostics 已落到现有 metadata,暂不改 Prisma schema。

边界现状:

```text
Run -> Runtime:           RuntimeService.provision()            (要环境)
Run -> WorkerExecution:   RunWorkerExecutionService.start()     (驱动执行)
                            -> RuntimeProviderRegistry.resolve(type).startWorkerExecution()
```

worker 的物理启动(local fork / sandbox 容器会话)是 runtime-specific 的,仍实现在 provider 内;
但「谁来驱动执行」已归 Run 层。同一 provider 类同时实现 `RuntimeResourceProvider`(Runtime 驱动)
与 `WorkerExecutionProvider`(Run 驱动)两个契约,经两个不同门面派发——Runtime 拥有「资源」,
不拥有「执行」。

## 1. 理想调用关系图

### 1.1 启动 run

```text
Client / Web
    |
    v
AgentService
    |
    v
RunService
    |
    | 1. resolve runtime placement
    v
RuntimeService.resolvePlacement()
    |
    v
RuntimePlacement
    |
    | 2. prepare or identify runtime resource
    v
RuntimeService.provision()
    |
    v
RuntimeResourceHandle
    |
    | 3. assemble run config
    v
RunConfigAssembler
    |
    v
RunConfig
    |
    | 4. run-owned worker execution boundary
    v
RunWorkerExecutionService.start(runtimeResource, runConfig)
    |
    v
WorkerExecutionHandle
    |
    v
Worker process / worker session
    |
    v
Claude / Codex Agent Adapter
```

关键点:

- `RuntimeService.provision()` 只返回环境资源句柄,不启动 worker。
- `RunWorkerExecutionService` 是 Run 层边界,负责把 `RuntimeResourceHandle` 和
  `RunConfig` 组合成一次 worker execution。
- 当前 provider 仍负责 local fork / sandbox startWorker 的物理细节,但对外不再暴露旧
  `start(runConfig, placement)` 合并入口。

### 1.2 事件回流

```text
Agent Adapter
    |
    v
Worker
    |
    | agui.event / run.status / heartbeat / control.trace / artifact.ref
    v
RunEventReceiver
    |
    v
RunEnvelopeProcessor
    |
    v
RunEvent / message aggregation / DB / SSE
```

事件横切能力应挂在 `RunEventReceiver -> RunEnvelopeProcessor` 后面,不要塞进 RuntimeProvider。

### 1.3 控制下发

```text
RunService.stop() / resolveApproval()
    |
    v
RunWorkerExecutionService.cancel/sendControl()
    |
    v
RuntimeProviderRegistry.resolve(handle.runtimeType)
    |
    v
provider.sendControl() / provider.cancel()
    |
    v
Worker
```

控制语义属于 run 生命周期;provider 只负责把 control 送到当前物理 worker/session。

## 2. 三个角色

### 2.1 Run

Run 是业务生命周期 owner。

职责:

- 对外提供 `run` / `stop` / `resume-stream` / `resolveApproval`。
- 创建和更新 Run 记录。
- 管 conversation active run 状态。
- 组装 `RunConfig`。
- 调 Runtime 准备运行环境。
- 用 `RuntimeResourceHandle + RunConfig` 驱动 worker execution。
- 持有 `WorkerExecutionHandle`。
- 下发 cancel / approval_resolved / user_message 等 control。
- 接收 worker 事件并做聚合、持久化、SSE。
- 处理终态 cleanup policy。

不负责:

- 不理解 Docker / OpenSandbox / local fork 的底层资源细节。
- 不直接调用 Claude / Codex SDK。
- 不把 workspace mount / sandbox engine 细节泄漏给 AgentService 或 Web。

### 2.2 Runtime

Runtime 只负责环境。

职责:

- placement 解析。
- provision / reuse / identify runtime resource。
- 返回 `RuntimeResourceHandle`。
- 管 runtime resource 生命周期:starting / running / stopped / missing / error。
- 管 heartbeat、idle、stop、cleanup、orphan recovery。
- 维护 workspace/user -> runtime resource 绑定。
- 屏蔽 local / docker / opensandbox / future remote runtime 差异。

不负责:

- 不拥有 run 的业务状态。
- 不聚合 message。
- 不推 SSE。
- 不理解 agent provider / model provider。
- 目标上不拥有 worker/session 语义。

边界落地说明:

- `RuntimeService` 已无 worker execution 方法;worker 启动 / control 派发由 Run 层
  `RunWorkerExecutionService` 经 `RuntimeProviderRegistry` 直接驱动 provider。
- Runtime 只保留 resource 维度的能力:`provision`、`heartbeatRuntimeResource`、
  `shutdownRuntimeResource`,以及 placement 解析。
- 后续如果引入独立 Worker Backend / Agent Server,`RunWorkerExecutionService` 背后的
  provider dispatch 可以替换成 backend adapter,Runtime 一侧不受影响。

### 2.3 Worker

Worker 保持薄,只负责执行。

职责:

- 接收或拉取 `RunConfig`。
- 创建 Claude / Codex adapter。
- 执行 adapter run。
- 处理 cancel / approval_resolved / user_message control。
- 上报 `agui.event` / `run.status` / `heartbeat` / `control.trace`。

不负责:

- 不决定 run status 如何落库。
- 不决定 conversation 状态。
- 不决定 runtime placement。
- 不管理 runtime resource 生命周期。
- 不承担全局调度、队列、capability registry。

## 3. 当前代码地图

```text
apps/api/src/runs/run.service.ts
  Run lifecycle owner
  resolve placement, provision runtime, assemble RunConfig, start worker execution

apps/api/src/runs/execution/run-worker-execution.service.ts
  Run-owned worker execution owner
  注入 RuntimeProviderRegistry，持有 runId -> WorkerExecutionHandle 派发表
  start/sendControl/cancel/heartbeat/cleanup -> provider

apps/api/src/runtime/runtime.service.ts
  Runtime 纯环境门面
  resolvePlacement/provision
  heartbeatRuntimeResource/shutdownRuntimeResource（resource 生命周期）

apps/api/src/runtime/providers/runtime-provider-contracts.ts
  RuntimeProvider / RuntimeResourceProvider / WorkerExecutionProvider 接口（API 进程内）

apps/api/src/runtime/run-event-receiver.ts
  RunEventReceiver 端口（runtime 拥有，run 实现）

apps/api/src/runtime/providers/local-runtime-provider.ts
  local runtime resource identity
  one run -> one child process worker

apps/api/src/runtime/providers/sandbox-runtime-provider.ts
  public facade for sandbox RuntimeProvider
  delegates resource lifecycle and session lifecycle to services

apps/api/src/runtime/providers/sandbox-runtime-resource.service.ts
  sandbox runtime resource state
  engine create/resume/stop
  heartbeat/idle/orphan recovery
  diagnostics and WorkspaceRuntime binding

apps/api/src/runtime/providers/sandbox-worker-session.service.ts
  per-run config/session/control queue
  cancel-before-ready tracking
  per-run cleanup

packages/shared/src/protocol/transport.ts
  RuntimeResourceHandle
  WorkerExecutionHandle
  WorkerExecutionStartInput
```

## 4. 核心接口

### 4.1 RuntimeResourceHandle

只描述运行环境资源,不承载 run/session 语义。

```ts
type RuntimeResourceHandle = {
  runtimeType: string;
  resourceKey: string;
  workspaceId: string;
  runtimeResourceId?: string;
  placement: RuntimePlacement;
};
```

`isolationScope` 不再出现在 handle 顶层——它是沙箱专属语义,归在
`placement.sandbox.isolationScope`;local 模式 `placement.sandbox` 为 undefined。
（前端 admin run detail 看到的 `runtimeResource.isolationScope` 来自 DB
`RuntimeResource` 表的同名列,与本进程内 handle 无关。）

### 4.1a RuntimePlacement 与 SandboxPlacementInfo

`RuntimePlacement` 是 run 的环境放置快照(纯计算,`resolvePlacement` 产出)。
沙箱专属字段收进可选 `sandbox` 对象,local 不带:

```ts
type SandboxPlacementInfo = {
  isolationScope: "user" | "workspace";   // 容器复用粒度
  mountTarget: string;                      // 容器内挂载根
  sandboxEngineType: "docker" | "opensandbox";
};

type RuntimePlacement = {
  runtimeType: "local" | "sandbox";
  userId: string;
  workspaceId: string;
  hostPath: string;        // 宿主机要挂进去的目录
  runtimePath: string;     // 该 workspace 在执行环境内的路径(local=hostPath)
  sandbox?: SandboxPlacementInfo;   // 仅 sandbox 模式
};
```

`runtimePath` 跨 local/sandbox 都有意义(worker 要知道 workspace 路径),留顶层。
`isolationScope`/`mountTarget`/`sandboxEngineType` 是沙箱物理参数,只有 sandbox 带。

### 4.2 WorkerExecutionHandle

描述一次 run 的 worker/session 执行句柄。

```ts
type WorkerExecutionHandle = {
  runId: string;
  runtimeType: string;
  runtimeResourceId: string;
  conversationId: string;
};
```

旧 `RuntimeHandle` 已从 shared protocol 删除;全链路统一用 `WorkerExecutionHandle`。

### 4.3 WorkerExecutionStartInput

```ts
type WorkerExecutionStartInput = {
  runtimeResource: RuntimeResourceHandle;
  runConfig: RunConfig;
  onRuntimeResourceIdReady?: (runtimeResourceId: string) => void;
};
```

这体现目标边界:

```text
RuntimeResourceHandle = environment
RunConfig = run intent
WorkerExecutionHandle = session
```

## 5. Local 与 Sandbox 的物理差异

runtime 顶层分 local / sandbox 两种 runtimeType;sandbox 内部由两个正交轴
（`isolationScope` 容器复用粒度 × `sandboxEngineType` 引擎类型）进一步区分:

| runtimeType | isolationScope | sandboxEngineType | 含义 |
|---|---|---|---|
| local | (无 sandbox) | — | 本机 fork 子进程,one run = one process |
| sandbox | user | docker | 该用户共用一个 docker 容器 |
| sandbox | user | opensandbox | 该用户共用一个 OpenSandbox 会话 |
| sandbox | workspace | docker | 每个 workspace 一个 docker 容器 |
| sandbox | workspace | opensandbox | 每个 workspace 一个 OpenSandbox 会话 |

`isolationScope` 决定 resourceKey(user→userId / workspace→workspaceId),
即"这个 run 能复用谁的容器";`sandboxEngineType` 决定用哪种沙箱技术实现。

local 模式:

```text
one run ~= one child process ~= one worker ~= one worker execution
```

local 不写 `RuntimeResource` / `WorkspaceRuntime` 表——没有持久容器要登记,
`runtimeResourceId` 即 `pid:startToken`,只记内存,run 结束进程即销毁。

sandbox persistent 模式:

```text
one runtime resource/container
  -> one worker host/process inside the container
    -> many run sessions over time
```

sandbox 才写 `RuntimeResource` 表(容器存活台账)与 `WorkspaceRuntime` 表
(workspace↔容器绑定,一对多)。

因此代码和文档里不要写死 "one run = one worker process"。稳定抽象应是:

```text
Run owns the run lifecycle.
Runtime owns the runtime resource.
Worker owns agent execution.
```

## 6. OpenHands 可借鉴的点

`../agent-project/` 里的 OpenHands 笔记对这次设计有三个直接启发。

### 6.1 Run 是平台骨架,不是 agent 实现

OpenHands 的核心原语是 `Event / State / Conversation / Agent`。Conversation 是编排器:
驱动主循环、写事件、做状态转移;具体 agent 只需要产出事件。

AgeWork 不需要照搬 `step(state) -> result`,因为 AG-UI streaming 和现有 Observable 更适合
当前产品。但可以借它的边界原则:

```text
RunService = platform skeleton
Worker/Adapter = event producer
RunEvent/Message = materialized state
```

### 6.2 Workspace/Runtime 是可替换环境

OpenHands 可以在 LocalWorkspace / DockerWorkspace / RemoteAPIWorkspace 间切换,上层
Conversation API 不变。

AgeWork 应保持同样不变量:

```text
Run API 不随 local / sandbox / future remote runtime 改变。
RuntimeResourceHandle 抹平 runtime resource 差异。
Worker event/control 协议保持稳定。
```

### 6.3 事件横切能力挂在 RunEventReceiver 后

OpenHands 的强能力很多不是 runtime 能力,而是事件流上的横切能力:

- structured error code
- stuck detection
- event callback / webhook
- pending messages
- hook / security / approval pipeline
- context condenser

AgeWork 后续补这些能力时,应挂在:

```text
Worker emits events
  -> RunEventReceiver
  -> RunEnvelopeProcessor
  -> hooks / stuck detector / callbacks / persistence / SSE
```

## 7. 不照搬 OpenHands 的点

| OpenHands 设计 | AgeWork 不照搬的原因 |
|---|---|
| `step(state) -> result` 同步接口 | AgeWork 需要真实 streaming,现有 AG-UI 事件流更合适。 |
| Action Execution Server | OpenHands 后端发 Action、沙箱回 Observation;AgeWork 是 Claude/Codex agent 自己执行并回事件。照搬会把 Worker 做厚。 |
| 事件流只存 JSONL | AgeWork 是多用户 + Prisma,DB 存 `RunEvent` 更适合查询和管理端。未来量大时再冷热分层。 |
| 自研 CodeAct agent | AgeWork 的 Claude/Codex adapter 已经承担 agent loop,没必要重写。 |
| 先做 Worker Server | 当前还没有远程 worker pool / capability registry / 全局调度需求,先不引入。 |

## 8. 已完成阶段

### Phase 1: Run-owned WorkerExecution 边界

状态:已完成。

结果:

- 新增 `RunWorkerExecutionService`。
- `RunService` 不直接启动 worker,而是走 Run 层 execution boundary。
- stop / resolveApproval / cleanup 的 control 下发收口到同一边界。
- 新增 `RunWorkerExecutionService` 单测。

### Phase 2: RuntimeResource 与 WorkerExecution 拆分

状态:已完成。

结果:

- 引入 `RuntimeResourceHandle`。
- `RuntimeService.provision()` 不启动 worker。
- `RunService` 先 provision runtime,再 assemble `RunConfig`,再启动 worker execution。
- Local provider 拆出 `provision()` 和 `startWorkerExecution()`。
- Sandbox provider 拆出 `provision()` 和 `startWorkerExecution()`。
- 旧 `RuntimeProvider.start()` / `RuntimeService.startWorker()` 退场。
- `WorkerExecutionHandle` 从旧 `RuntimeHandle` 独立出来。

### Phase 2f: Sandbox provider service split

状态:已完成。

结果:

```text
SandboxRuntimeProvider.startWorkerExecution()
  -> SandboxRuntimeResourceService.resolveWorkerExecutionContext()
  -> SandboxWorkerSessionService.registerRunConfig()
  -> SandboxRuntimeResourceService.ensureScopeState()
  -> SandboxWorkerSessionService.registerRunSession()
  -> SandboxRuntimeResourceService.attachOrStartRuntimeResource(callbacks)
```

职责拆分:

- `SandboxRuntimeResourceService`:scope state、pending sandbox、engine create/resume/stop、
  heartbeat/idle、WorkspaceRuntime/RuntimeResource diagnostics、access key lifecycle。
- `SandboxWorkerSessionService`:run config、per-run access、control queue、cancel-before-ready、
  per-run cleanup。
- `SandboxRuntimeProvider`:只保留 public facade、callback bridge 和 orchestration。

### Phase 3: RuntimeResource 多 instance 诊断

状态:已完成。

结果:

- `RuntimeResource.metadata` 写入标准 diagnostics。
- starting/running/stopped/missing/error 语义更清晰。
- admin runtime list 返回 resourceKey、workspaceCount、isReusable、diagnostics。
- orphan recovery、manual stop、owner release 都写入诊断原因。
- 暂不改 Prisma schema,避免本轮引入 migration。

### Phase 3f: 执行边界收口（Runtime 不再执行）

状态:已完成。

结果:

- worker execution 派发（`start / sendControl / cancel / heartbeat / cleanup` + `runId -> handle` 表）从 `RuntimeService` 整体移入 `RunWorkerExecutionService`,后者直接经 `RuntimeProviderRegistry` 解析 provider。
- `RuntimeService` 去掉所有 worker execution 方法,只剩 `resolvePlacement / provision / heartbeatRuntimeResource / shutdownRuntimeResource`。
- `run-internal.controller` 的 worker 心跳 / 终态清理改调 `RunWorkerExecutionService`。
- `RuntimeProvider` / `RunEventReceiver` 移出 `shared/protocol`,旧 `RuntimeHandle` 删除。
- worker 心跳 / 手动 stop 的 provider 派发收口到 `RuntimeService` 门面;内部与 admin 控制器不再注入 `RuntimeProviderRegistry`、不再硬编码 provider type、不再用可选链兜底。
- 配套精准单测:`RunWorkerExecutionService`、`RuntimeService`、三个控制器 spec 全部更新并通过。

## 9. 下一步计划

### Phase 4: 事件横切能力

触发条件:

- Run/Runtime/Worker 边界稳定。
- 需要提升故障诊断、外部集成或长任务安全性。

优先级:

```text
P0 structured agent error code
P0 stuck / max duration / max iterations
P1 pending messages
P1 event callback / webhook
P1 hook pipeline
P2 context condenser
```

落点:

```text
RunEventReceiver
  -> RunEnvelopeProcessor
  -> cross-cutting processors
  -> DB / SSE / callbacks
```

不要放进 RuntimeProvider。

### Phase 5: Worker Backend / Agent Server 化

状态:暂缓,单独设计。

只有出现以下需求时才启动:

- 同时支持 IPC、HTTP long polling、WebSocket、RPC/gRPC 等多种 worker 通信方式。
- worker host 需要跑在远端机器或独立进程池。
- 需要远程 worker pool。
- 需要全局并发上限 / 排队。
- 需要 worker capability registry。
- 需要多种 worker binary / image / protocol version。
- 需要跨机器运行 worker。

届时可能引入:

```text
RunWorkerExecutionService
  -> WorkerBackend / AgentServer client
       -> LocalWorkerHost
       -> SandboxWorkerHost
       -> RemoteWorkerHost
```

但当前阶段不做。现在的目标是保持 Worker 薄,把 Run/Runtime 边界和 sandbox resource/session
职责先稳定下来。

### Phase 6: RuntimeResource schema 化

触发条件:

- admin/runtime diagnostics 需要强查询能力。
- metadata 字段开始承载过多结构化信息。
- 需要 dashboard、筛选、告警或报表。

可能改动:

- 给 diagnostics 中的核心字段加 Prisma schema 字段。
- 给 `resourceKey/runtimeType/status/owner` 增加索引。
- 把 access key fingerprint、spec/version、lastSeenAt 等字段从 metadata 提升出来。

## 10. 风险与护栏

### 10.1 不让 Runtime 重新变厚

禁止把以下内容放进 RuntimeProvider:

- run business status 聚合。
- conversation active run 状态。
- message aggregation。
- SSE 推送。
- agent/model provider 决策。
- webhook/hook pipeline。

### 10.2 不把 Worker 做厚

Worker 当前仍然只是:

```text
RunConfig in
Control in
AG-UI / run.status / heartbeat out
```

不要加入:

- capability registry
- remote pool scheduler
- standalone Worker Server
- runtime resource lifecycle ownership
- DB persistence

### 10.3 触碰高风险路径必须补精准测试

高风险路径:

- local IPC worker event path
- sandbox HTTP event path
- worker exit error path
- heartbeat timeout path
- terminal status / cleanup / unregister 顺序
- cancel-before-ready
- persistent sandbox session reuse

## 11. 当前验收状态

本轮已覆盖的关键测试面:

- `RuntimeService` provision / placement / heartbeatRuntimeResource / shutdownRuntimeResource。
- `RunWorkerExecutionService` start/control/cancel/heartbeat/cleanup 的 provider 派发。
- `LocalRuntimeProvider` provision 和 worker execution。
- `SandboxRuntimeProvider` provision、session reuse、cancel-before-ready、heartbeat、idle、recovery。
- `SandboxRuntimeResourceService` resource lifecycle。
- `SandboxWorkerSessionService` control queue 和 session cleanup。
- `RuntimeProviderRegistry`。

还需要在后续实际开发中保持:

- 每次修改 `RunEventReceiver` / `RunEnvelopeProcessor` 后补事件流测试。
- 每次修改 sandbox lifecycle 后补 resource/session 分层测试。
- 每次修改 shared protocol 后跑 API 和 shared typecheck。
