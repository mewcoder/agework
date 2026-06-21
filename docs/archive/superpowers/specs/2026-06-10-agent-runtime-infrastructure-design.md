# AgeWork Agent 运行基础设施设计

## 1. 背景与目标

AgeWork 是一个多 Agent 工作台。现状是单体 NestJS：Agent 在 `apps/api` 进程内执行——Claude 走 `@anthropic-ai/claude-agent-sdk` 的 `query()`（进程内），Codex 走 `@openai/codex-sdk`（fork 子进程）。`AgentController.run()` 直接 `agentService.getAdapter()` 拿到 adapter，订阅其 `Observable<BaseEvent>` 并通过 SSE 下发给前端。Run 没有独立实体，只是 `Thread.runStatus` 字段加内存里的 `activeAgentRuns` Map；停止/人机交互（HITL）靠这个 Map 调 `adapter.interrupt()` / `resolveQuestion()`，即时生效。原始 AG-UI 事件不落库，仅由 `RunAggregator` 聚合成最终 assistant `Message` 写入数据库。`Project.workdir` 一个字段同时承担"业务字段"和"运行时路径"两种语义。

这套现状能很好地支撑**本地单用户**场景，但要同时支撑：

- **本地/客户端**：打开即用、无需沙箱、原生体验。
- **服务器多用户沙箱**：用户互不信任，Agent 需要在容器/沙箱中执行，需要资源限制、网络策略、生命周期清理。

就需要把"Agent 怎么运行"从 API 业务逻辑中抽出来，形成一套稳定的**运行基础设施**：在哪执行、怎么通信、文件怎么变成 Agent 看到的工作目录。

### 本期范围

**设计范围**（本文档完整设计，确保抽象不是为单一 provider 量身定做）：

- `RuntimeProvider` + `RuntimeTransport` 双层抽象
- `LocalProcessProvider` + `IpcTransport`
- `DockerProvider` + `HttpTransport`
- Run 实体与状态管理、Workspace 数据模型 + 运行时映射策略

**本轮实现（对应第 11 节阶段 1-3）：**

- `RuntimeProvider` + `RuntimeTransport` 双层抽象（接口落地）
- `LocalProcessProvider` + `IpcTransport`（本地 worker 进程化）
- Run 实体与状态管理（替代 `Thread.runStatus` + 内存 Map）
- Workspace 数据模型 + 本地映射策略（直接用）
- worker 独立为 `apps/worker`，共享代码抽到 `packages/`

**下一轮实现（设计已完成，对应第 11 节阶段 4，本轮不动代码）：**

- `DockerProvider` + `HttpTransport`（沙箱形态，验证抽象通用性）
- Workspace 的 mount 映射策略

**不做（后续上层能力，模型留口不堵死）：**

- 多 Agent 并行执行 / Agent 编排（一个 Task 多个 Run 并排对比）

**后置：**

- Event Store（原始 AG-UI 事件逐条落库），本期先沿用现有 trace 日志
- Workspace 的 sync 映射策略（远程/无共享文件系统）
- K8s / microVM provider、Custom HTTP provider
- Electron/Tauri 客户端壳

**不兼容旧数据**：本期是全新设计，不做 `Project.workdir` 等旧字段的迁移（开发阶段清空重建）。

## 2. 核心原则：分层透明

调用者只需"选择一种实现"，对上层完全透明。每一层吸收一类差异，新增一种实现 = 增加一个类，不影响其他层：

| 层 | 抽象 | 吸收的差异 | 本期实现 |
|---|---|---|---|
| Agent 在哪执行 | `RuntimeProvider` | 本地子进程 / Docker 容器 | Local / Docker |
| 控制面与 worker 怎么通信 | `RuntimeTransport` | IPC / HTTP | Ipc / Http |
| 文件怎么变成 cwd | `prepareRun` 内部映射 | 直接用 / mount / sync | 直接用 / mount（sync 后置） |

> Agent Adapter 永远只拿到一个 `runtimePath`（cwd）。它不知道：自己跑在本地还是 Docker 容器、上报事件走 IPC 还是 HTTP、这个目录是宿主机真实路径还是容器内的 `/workspace`。

## 3. 架构总览

```text
AG-UI Client (apps/web)
  → API 控制面 (apps/api)
      用户 / 项目 / 线程 / 消息 / Run 管理
      → RuntimeProviderRegistry.resolve()  // 选 Local 还是 Docker
        → RuntimeProvider: Local | Docker
            prepareRun（解析 workspace、准备环境、搭 transport 控制面端）
            start（启动 worker：fork / docker run）
            → Runtime Worker (apps/worker)
                读取 RunConfig → 加载 Agent Adapter → 跑 SDK
                → Agent Adapter (packages/adapters)
                    Claude SDK / Codex SDK → AG-UI Event
                聚合 → 经 RuntimeTransport 上报事件 / 接收控制
```

**事件方向**：

```text
Agent SDK → Agent Adapter → AG-UI Event
  → Runtime Worker → RuntimeTransport(Ipc/Http)
    → RunEventBus.publish()（统一汇入口，去重 + 更新 Run）
      → SSE → AG-UI Client
      → RunAggregator → Message 落库
```

**控制方向**：

```text
AG-UI Client → API 控制面 → RuntimeTransport → Runtime Worker → Agent Adapter / SDK
```

本地 IPC 是 push，即时生效；沙箱 HTTP 是 worker 轮询 control，存在轮询间隔。

## 4. 统一通信契约（RuntimeTransport）

统一的是**契约**，不是物理通道。三件不变量在所有 transport 实现上保持一致。

### 4.1 消息集（固定）

| 方向 | 消息 | 语义 |
|---|---|---|
| 拉取 | `run.config` | worker 启动时拉取 run 配置（agent 类型、prompt、workspace、policy、limits） |
| 上行 | `run.status` | 生命周期：preparing / running / finished / failed |
| 上行 | `agui.event` | AG-UI 事件流（核心负载） |
| 上行 | `heartbeat` | 存活 + 资源占用，沙箱场景强需要 |
| 上行 | `artifact.ref` | 产物元数据引用（大文件走对象存储，本期后置） |
| 下行 | `control` | cancel / interrupt / approval_resolved / user_message |

### 4.2 统一信封

```ts
interface Envelope<T = unknown> {
  runId: string;
  seq: number;       // 按 run 单调递增
  type: string;       // 上述消息类型之一
  payload: T;
  ts: string;         // ISO timestamp
}
```

### 4.3 可靠性语义

全局语义一致：**at-least-once + 幂等去重**（去重 key = `runId:seq`）。不同通道的兑现方式不同：

- **IpcTransport（本地）**：进程内 message，天然有序、几乎不丢；`seq` 单调，重复消息直接丢弃即可，无需重发机制。
- **HttpTransport（沙箱）**：网络可能丢失/重试，worker 侧用 `Idempotency-Key: <runId>:<seq>` + 本地 buffer 重发；控制面落库侧用 `UNIQUE(run_id, seq)` 约束去重。

本地完全不背 HTTP 的重发/幂等成本，但事件信封与去重语义和沙箱一致——未来 Event Store 落库时两种来源的数据结构相同。

### 4.4 接口

```ts
interface RuntimeTransport {
  fetchRunConfig(): Promise<RunConfig>;
  emit(msg: Envelope): Promise<void>;                          // status/event/heartbeat/artifact 统一入口
  subscribeControls(cb: (c: Envelope<Control>) => void): Unsubscribe; // push 或 poll 由实现自决
  close(): Promise<void>;
}
```

`apps/worker` 主体只依赖 `RuntimeTransport` 接口，启动时根据 `RUNTIME_TRANSPORT=ipc|http` 环境变量装载对应实现：

- **IpcTransport**：`emit` = `process.send(msg)`；`subscribeControls` = `process.on('message', cb)`。
- **HttpTransport**：`emit` = `POST /internal/runs/{runId}/events`（带 `Idempotency-Key`）；`subscribeControls` = 轮询 `GET /internal/runs/{runId}/controls?afterSeq=`；`fetchRunConfig` = `GET /internal/runs/{runId}`。HTTP、token、续传等机制全部封装在这一个实现内。

## 5. RuntimeProvider

```ts
interface RuntimeProvider {
  prepareRun(input: PrepareRunInput): Promise<PreparedRun>;
  start(prepared: PreparedRun): Promise<RuntimeHandle>;
  sendControl(handle: RuntimeHandle, control: Control): Promise<void>;
  cancel(handle: RuntimeHandle): Promise<void>;
  cleanup(handle: RuntimeHandle): Promise<void>;
  getStatus(handle: RuntimeHandle): Promise<RuntimeStatus>;
}

interface PreparedRun {
  runId: string;
  runtimePath: string;       // Agent 看到的 cwd
  hostPath?: string;         // provider 内部使用，远程 provider 可能没有
  env: Record<string, string>;
  limits?: RuntimeLimits;
  networkPolicy?: RuntimeNetworkPolicy;
  metadata?: Record<string, unknown>;
}
```

`prepareRun` 负责：解析 `Workspace.locator`、按 provider 的映射策略产出 `runtimePath`/`hostPath`、准备 env/limits/网络策略、为 transport 搭好控制面端（IPC channel 或 internal API + token）。

`start` 负责真正拉起 worker。

provider 与 transport 成对出现：

| Provider | Transport | runtimePath 映射 |
|---|---|---|
| `LocalProcessProvider` | `IpcTransport` | 直接用：`runtimePath = workspace.locator`；`fork()` 启动 `apps/worker`，注入 `RUNTIME_TRANSPORT=ipc` |
| `DockerProvider` | `HttpTransport` | mount：`hostPath = workspace.locator` → `/workspace`；`runtimePath = /workspace`；`docker run` 启动 worker 镜像，注入 `RUNTIME_TRANSPORT=http` + `PLATFORM_API_BASE` + runtime token |

新增运行环境（K8s、microVM、Custom HTTP runner）= 新增一对 Provider + Transport 实现，`apps/worker` 主体与契约不变。

### 5.1 RuntimeProviderRegistry

`RuntimeProviderRegistry` 是一个轻量组件：给定一次 run 的请求，解析出应该使用哪个 `RuntimeProvider` 实例。它**只做选择**，不重复 `RuntimeProvider` 的职责（不解析 workspace、不启动 worker、不生成 token）。

```ts
interface RuntimeProviderRegistry {
  resolve(input: ResolveInput): RuntimeProvider;
}
```

本期选择逻辑是系统级默认配置（`AGEWORK_RUNTIME_PROVIDER=local|docker`），不引入按 agent 类型/workspace 风险/用户套餐的策略引擎——那是 `runtime-provider-design.md`「Provider 选择策略」一节描述的后续能力，本期不做。

`RunService` / `AgentController` 只与 `RuntimeProviderRegistry.resolve()` 交互，拿到 `RuntimeProvider` 后调用 `prepareRun` / `start`，不直接 `new` 具体 provider。

### 5.2 RunEventBus

worker 通过 `RuntimeTransport.emit()` 上报的 envelope（`run.status` / `agui.event` / `heartbeat` / `artifact.ref`），无论经由 `IpcTransport` 控制面端（`LocalProcessProvider` 内监听 `child.on('message')`）还是 `HttpTransport` 控制面端（Docker internal API 的 `POST /internal/runs/{runId}/events`）到达，最终都汇入同一个入口：

```ts
interface RunEventBus {
  publish(envelope: Envelope): void;
}
```

`RunEventBus` 负责：

- 按 `(runId, seq)` 去重（呼应 4.3 节可靠性语义）
- 更新 `Run` 实体（status / phase / lastSeq / lastHeartbeatAt / error）
- `agui.event` → 转发到该 run 的 SSE 流 → AG-UI Client
- `agui.event` → 喂给 `RunAggregator` → 落库 `Message`（沿用现状节奏）

`RunEventBus` 是 `RuntimeTransport` 在控制面侧的唯一汇入口，与 worker 侧"只依赖 `RuntimeTransport` 接口"对称。`RuntimeProviderRegistry`（选 provider）+ `RunEventBus`（收上报）+ `RuntimeProvider.sendControl`（发控制）构成控制面三个动作的完整闭环；新增 provider/transport 时，三者都不用改。

## 6. Workspace

Workspace 是**数据**，不是 Provider。"怎么得到这个目录"（用户主动选择 / 系统自动分配）只是创建那一刻的逻辑差异，对运行时无影响；运行时真正重要的是**映射策略**：直接用 / mount / sync。

```text
Workspace {
  id
  projectId
  locator      string   实际路径或标识
  status       ready | preparing | error
  metadata     JSON     provider 私有信息（如 sandbox id）
}
```

- **创建时**（`WorkspaceService`）：本地/客户端场景用户主动选择本机目录 → `locator` = 该路径；服务器场景系统在受控 root 下自动分配目录 → `locator` = 生成路径。git clone 是创建后向 `locator` 指向的目录填充内容的附加功能，不影响本设计。
- **运行时**（`RuntimeProvider.prepareRun`）：读取 `locator`，按 provider 决定映射方式，产出 `runtimePath`：
  - **直接用**（Local）：`runtimePath = locator`。
  - **mount**（Docker，单机/共享文件系统）：`hostPath = locator`，`mount hostPath:/workspace`，`runtimePath = /workspace`。
  - **sync**（远程 provider，无共享文件系统）：run 前同步进沙箱、run 后同步回——**本期不实现，接口预留**。

`Project` 调整：移除"`workdir` 即运行路径"的语义，改为 `Project.workspaceId` 关联一个 `Workspace`。

## 7. Run 实体与状态管理

worker 进程化后，控制面需要跨进程定位 run、下发控制、处理崩溃，内存 Map 不再够用：

```text
Run {
  id
  threadId
  projectId
  userId
  agentType
  providerType    local | docker
  runtimeId       provider 内部句柄标识
  status          queued | preparing | running | cancelling | finished | error
  phase
  lastSeq
  lastHeartbeatAt
  error
  startedAt
  finishedAt
  createdAt
  updatedAt
}
```

- 一个用户回合对应一个 `Run`。未来多 Agent 并行（一个 Task 多个 Run）在此基础上自然扩展，本期不实现。
- 控制面维护 Run 注册表（`runId → RuntimeHandle`），stop/HITL 通过 `provider.sendControl()` 下发，平移现状内存 Map + `adapter.interrupt()` / `resolveQuestion()` 的语义。
- assistant `Message` 仍由 `RunAggregator` 产出并入库，与现状一致。

## 8. 事件持久化

- 聚合后的 `Message` 继续入库，沿用现有 `thread.service.ts` 的 `upsertMessage` 落库节奏（每 N 个 chunk + 边界事件 + `RUN_FINISHED` 最终落盘）。
- 原始 AG-UI 事件**本期走日志**，沿用现有 `agent-trace-logger.ts` / `codex-run-logger.ts`，不落库。
- 统一信封已带 `seq`，未来引入 Event Store（`run_events` 表，`UNIQUE(run_id, seq)`）时无需改动契约，只需新增一个落库的 transport 侧消费者。

## 9. Monorepo 结构调整

```text
apps/
  api/      控制面：用户/项目/线程/消息/Run 管理、RuntimeProvider(Local/Docker)、
            Transport 控制面端（IPC channel 维护 / internal API + token）、SSE
  web/      前端（不变）
  worker/   Runtime Worker 主体：读取 RunConfig → 加载 Adapter → 跑 SDK →
            聚合 → 经 RuntimeTransport(Ipc/Http) 上报/接收控制
packages/
  protocol/ 消息契约（Envelope / RunConfig / Control / AGUIEvent）、
            RuntimeTransport 接口、Run 相关共享类型
  adapters/ Claude / Codex Agent Adapter
            （从 apps/api/src/libs/ag-ui-*-agent-sdk 与 src/agent/adapters 抽出）
```

- `apps/api` 与 `apps/worker` 都依赖 `packages/protocol`、`packages/adapters`。
- Docker 镜像运行 `apps/worker`。
- Turborepo `^build` 拓扑：api / worker 依赖 packages，先构建 packages。

## 10. 安全

- **本地**：`fork()` 出的子进程通过 IPC 与父进程通信，同机父子进程信任，无需 runtime token；workspace 是用户自选目录，沿用 SDK 自带的 `workspace-write` sandbox（macOS seatbelt / Linux landlock）。
- **沙箱（Docker）**：每个 run 分配一个 runtime token，仅允许访问该 run 自己的 internal API（`GET /internal/runs/{runId}`、`POST .../events`、`GET .../controls`）；容器内 worker 只能访问 `PLATFORM_API_BASE`、模型 API 与必要白名单；不挂载宿主机 HOME / `~/.ssh` / `~/.aws` / 平台数据库凭据 / `docker.sock`。

## 11. 分阶段落地

**本轮实现：阶段 1-3。** 阶段 4（Docker/Http）设计已在第 4、5、6 节给出，留待下一轮实现，不在本轮代码改动范围内。

1. **抽 packages + 契约**：建 `packages/protocol`（`Envelope`、`RuntimeTransport` 接口、`RunConfig`、`Control`、AG-UI 事件类型）与 `packages/adapters`（迁移现有 Claude/Codex adapter）。`apps/api` 改为引用这两个包，行为不变。
2. **Run 模型 + 控制面注册表**：Prisma 新增 `Run`、`Workspace`，调整 `Project` 关联；`AgentController` 编排改为围绕 `Run` 生命周期，但仍 in-process 执行（零运行时风险，先把模型和编排切换到位）。
3. **worker 进程化 + Local/Ipc**：建 `apps/worker`；`LocalProcessProvider` `fork()` 启动 worker 并建立 `IpcTransport`；事件经 IPC 回传 API 后走 SSE；stop/HITL 经 IPC control 下发。本地完整链路跑通。`RuntimeProviderRegistry` 本轮固定解析为 `LocalProcessProvider`。

---

**下一轮：**

4. **Docker/Http**：实现 `DockerProvider` + `HttpTransport` + internal API endpoints + runtime token + workspace mount。用同一份 `apps/worker` 验证双层抽象的通用性。`RuntimeProviderRegistry` 按 `AGEWORK_RUNTIME_PROVIDER` 支持选择 docker。
5. **收尾**：`GET /api/v1/runtime/capabilities`（前端按 provider 能力展示）、worker 异常退出/孤儿进程回收、超时与错误处理。

## 12. 验证方式

- **阶段 1-2**：`pnpm typecheck`、`pnpm test:api` 全绿；现有聊天/线程/HITL 行为回归不变。
- **阶段 3**：本地 `fork` worker 跑一次 Claude / Codex run，前端 SSE 流式展示正常；触发 stop 能即时中断；HITL 答题正常；与现状相比延迟无明显回退。
- **阶段 4**：`docker run` 启动 worker，事件经 HTTP 上报、控制经轮询下发、workspace mount 生效、取消能销毁容器；同一份 `apps/worker` 代码在两种 transport 下都能跑通，即证明双层抽象成立。
- **端到端**：本地与 Docker 两种形态对同一 prompt 产出一致的 assistant 消息并正确入库。

## 13. 后置事项（本期不做，仅留接口）

- 多 Agent 并行执行 / Agent 编排（一个 Task 多个 Run，前端并排对比与采纳）
- Event Store（原始事件逐条落库、断线续传、回放）
- Workspace 的 sync 映射策略（远程 / 无共享文件系统）
- K8s / microVM Runtime Provider、Custom HTTP Runtime Provider
- Electron / Tauri 客户端壳

## 14. 与既有文档的关系

本设计文档为**单一权威文档**，替换 `docs/superpowers/specs/2025-06-09-product-architecture-design.md` 中关于 Runtime 执行模型的内容。`docs/design.md`、`docs/runtime-provider-architecture.md`、`docs/sandbox-design.md` 降为历史/附录参考：

- `docs/runtime-provider-architecture.md` 中"本地进程内 provider、provider 内聚 workspace"的判断被本设计采纳（第 6、9 节）。
- `docs/design.md` 中"独立 worker、无端口、主动调 internal API、轮询 control、Event Store"等机制被本设计采纳，但**限定为沙箱/server 形态下 `DockerProvider` + `HttpTransport` 的内部实现**，不再表述为本地/客户端的全局统一模型。
- `docs/sandbox-design.md` 的容器化方案（OpenSandbox / Docker、`codexPathOverride` / `pathToClaudeCodeExecutable` 透传）作为 `DockerProvider` 内部实现的可选路径，本期 `DockerProvider` 优先采用直接运行 `apps/worker` 镜像的方式，sandbox wrapper 透传方案留作 provider 内部实现的备选。
