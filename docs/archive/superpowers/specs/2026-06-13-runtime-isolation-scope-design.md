# Runtime 隔离粒度设计：User / Workspace

> 前置文档：
> - `docs/superpowers/specs/2026-06-10-agent-runtime-infrastructure-design-v2.md` — Runtime / Provider / Transport 总体分层
> - `docs/superpowers/specs/2026-06-12-docker-persistent-container-design.md` — 当前 workspace 级持久容器设计
> - `docs/superpowers/specs/2026-06-12-opensandbox-provider-design.md` — OpenSandboxProvider 接入边界

## 结论

AgeWork 的 runtime 类型选择应继续保持**服务级配置**：

```text
RUNTIME_PROVIDER=local | docker | opensandbox
```

在此基础上新增一个独立的隔离粒度策略：

```text
RUNTIME_ISOLATION_SCOPE=user | workspace
```

推荐默认：

```text
本地开发 / local provider:
  RUNTIME_PROVIDER=local
  RUNTIME_ISOLATION_SCOPE=user    # 语义上等同本机共享，不强做容器隔离

服务器 / SaaS 默认:
  RUNTIME_PROVIDER=opensandbox
  RUNTIME_ISOLATION_SCOPE=user    # 成本优先，每个活跃用户一个 sandbox

高隔离部署:
  RUNTIME_PROVIDER=opensandbox
  RUNTIME_ISOLATION_SCOPE=workspace
```

也就是说，当前产品策略不是让用户或 workspace 自己选择 runtime 类型，而是由部署方为一个 AgeWork 服务实例选择一种 runtime 类型和一种隔离粒度。底层仍保留 `RuntimeProviderRegistry`、`Run.runtimeType`、`Run.runtimeResourceId` 等架构能力，未来可以演进到按租户/套餐/风险策略选择。

## 为什么不是 Conversation 级

Conversation 级 sandbox 首先排除。

```text
Conversation -> sandbox
```

问题：

- 冷启动成本高，同一个 workspace 的多个对话重复安装依赖和准备环境。
- 会破坏 agent session resume 的稳定性，容器销毁后内存 session 丢失。
- 一个 workspace 下多个 conversation 本质上是在同一份代码和依赖上工作，不应该重复创建运行环境。
- 成本接近 run 级，但隔离收益没有 workspace 级清晰。

AgeWork 的合理边界应是：

```text
User         -> 权限、配额、账号、计费
Workspace    -> 文件系统、代码仓库、依赖环境、项目生命周期
Conversation -> 对话上下文、agent session、pending action、resume/cancel
Run          -> 单次执行、事件、状态、runtime handle
```

## User 级与 Workspace 级的取舍

### User 级 sandbox

```text
User -> sandbox/container
  workspace-a/
  workspace-b/
  workspace-c/
```

优点：

- 成本低：一个活跃用户通常只占一个运行中 sandbox。
- 体验接近 local 模式：像“一个用户一台开发机”。
- 多 workspace 之间可以共享系统依赖、语言缓存、包管理缓存。
- 对服务器资源更友好，适合默认 SaaS 起点。

缺点：

- 同一用户的多个 workspace 运行环境可能互相影响。
- 端口、后台进程、全局 cache、临时文件需要治理。
- 凭证和网络策略如果要做到 workspace 级精细隔离，会更复杂。
- 删除/归档单个 workspace 时，只能清理该 workspace 目录，不能直接销毁整个 sandbox。

适用场景：

- 个人工作台、轻量团队、成本敏感的 SaaS。
- 同一用户同时活跃 workspace 数较少。
- 更重视运行成本和启动速度，而不是项目间强隔离。

### Workspace 级 sandbox

```text
Workspace -> sandbox/container
```

优点：

- 项目边界清晰：文件、依赖、后台进程、端口、网络策略都按 workspace 分开。
- workspace 删除时可以直接销毁对应 runtime。
- 适合快照、归档、恢复、审计和按项目配额。
- 更适合高安全租户或企业部署。

缺点：

- 活跃 workspace 数越多，运行中 sandbox 越多。
- 如果所有 workspace 常驻，会浪费大量内存。
- 需要 idle stop / pause / resume 策略，否则成本不可控。

适用场景：

- 企业租户、高安全项目、强隔离要求。
- 一个用户同时操作多个项目，且项目依赖差异大。
- 需要 workspace 级快照、网络策略、凭证隔离。

## 成本模型

关键不是总 workspace 数，而是**活跃 runtime 数**。

粗略假设：

```text
每个运行中 sandbox 内存: 300MB
每个停止 workspace 磁盘: 1GB
workspace 活跃率: 10%
```

### 10 个用户，每人 10 个 workspace

```text
用户数: 10
workspace 数: 100
```

| 策略 | 运行中 sandbox | 内存估算 | 磁盘估算 | 评价 |
|------|----------------|----------|----------|------|
| user 级，用户都活跃 | 10 | 3GB | 约 100GB+ | 成本低，边界较粗 |
| workspace 级，全部常驻 | 100 | 30GB | 约 100GB+ | 不推荐 |
| workspace 级，10% 活跃 | 10 | 3GB | 约 100GB+ | 内存可控，磁盘要治理 |

### 100 个用户，每人 10 个 workspace

```text
用户数: 100
workspace 数: 1000
```

| 策略 | 运行中 sandbox | 内存估算 | 磁盘估算 | 评价 |
|------|----------------|----------|----------|------|
| user 级，用户都活跃 | 100 | 30GB | 约 1TB+ | 默认可接受，需要用户并发限制 |
| workspace 级，全部常驻 | 1000 | 300GB | 约 1TB+ | 不可取 |
| workspace 级，10% 活跃 | 100 | 30GB | 约 1TB+ | 内存接近 user 级，磁盘压力相同 |
| workspace 级，1% 活跃 | 10 | 3GB | 约 1TB+ | 隔离强且内存低，但冷启动更多 |

结论：

```text
运行内存成本 ≈ 活跃 sandbox 数
磁盘成本 ≈ workspace 总数
```

因此 workspace 级不是不能做，关键是不能“每个 workspace 永久常驻”。应采用 lazy start + idle stop/pause。

## 推荐运行策略

### 默认服务器策略

```text
RUNTIME_PROVIDER=opensandbox
RUNTIME_ISOLATION_SCOPE=user
```

行为：

- 每个活跃用户最多一个 sandbox。
- 用户多个 workspace 挂载在同一个 sandbox 的不同目录。
- 每次 run 仍然传入明确的 `workspaceId` 和 `runtimePath`，agent 只在当前 workspace 目录内工作。
- 限制每用户并发 run 数，避免一个用户的多个 workspace 过度抢资源。
- 用户 sandbox idle 后 stop/pause。

### 高隔离策略

```text
RUNTIME_PROVIDER=opensandbox
RUNTIME_ISOLATION_SCOPE=workspace
```

行为：

- 每个活跃 workspace 一个 sandbox。
- 同 workspace 下多个 conversation/run 共用该 sandbox。
- run 结束不销毁 sandbox；idle 后 stop/pause。
- workspace 删除时销毁 sandbox 和 runtime binding。

### local provider

`local` provider 本质上运行在宿主机进程里，不应强行模拟容器隔离。

```text
RUNTIME_PROVIDER=local
RUNTIME_ISOLATION_SCOPE=user
```

语义上等同“用户的一台本机开发机”。`RUNTIME_ISOLATION_SCOPE=workspace` 可以先不支持 local，或仅作为逻辑分组，不提供真实隔离。

## 数据模型

当前设计偏向：

```text
WorkspaceRuntimeBinding
  workspaceId + runtimeType -> runtimeResourceId
```

为了同时支持 user/workspace，建议泛化为：

```prisma
model RuntimeBinding {
  id                String    @id @default(cuid())
  runtimeType       String    // local | docker | opensandbox
  isolationScope    String    // user | workspace
  scopeId           String    // userId 或 workspaceId
  runtimeResourceId String    // containerId | sandboxId | ...
  status            String    @default("running")
  expiresAt         DateTime?
  metadata          Json      @default("{}")
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt

  @@unique([runtimeType, isolationScope, scopeId])
  @@index([runtimeType, isolationScope, status])
  @@index([isolationScope, scopeId])
}
```

`Run` 继续记录运行事实：

```text
Run.runtimeType
Run.runtimeResourceId
```

可选增加：

```text
Run.runtimeBindingId
Run.runtimeIsolationScope
```

但 MVP 可以先不加，只要 `runtimeResourceId` 足够定位 orphan recovery 和 cleanup。

## RuntimePlacementService

需要新增一个小的决策服务，把 runtime 类型和隔离粒度从业务层移走。

```ts
type RuntimePlacement = {
  runtimeType: string;
  isolationScope: "user" | "workspace";
  scopeId: string;
  workspaceId: string;
  userId: string;
  hostPath: string;
  runtimePath: string;
};
```

接口：

```ts
resolveForRun(input: {
  userId: string;
  workspaceId: string;
  workspaceRootPath: string;
}): RuntimePlacement
```

规则：

```text
runtimeType = RUNTIME_PROVIDER
isolationScope = RUNTIME_ISOLATION_SCOPE

if isolationScope=user:
  scopeId = userId
  hostPath = user workspace root
  runtimePath = mounted user root + relative workspace path

if isolationScope=workspace:
  scopeId = workspaceId
  hostPath = workspace root
  runtimePath = mounted workspace path
```

`AgentRunHandler`、`RuntimeRunner` 不应该自己判断 user/workspace。它们只接收 placement 结果，并把 `runtimePath` 写进 `RunConfig`。

## Provider 行为

Provider 不再只处理 workspace 级 runtime，而是处理 placement。

```text
RuntimeRunner.start(runConfig, placement)
  -> provider = RuntimeProviderRegistry.resolve(placement.runtimeType)
  -> provider.start(runConfig, placement)
```

### user 级 provider 行为

```text
getOrCreateRuntime(userId)
  -> 查 RuntimeBinding(runtimeType, "user", userId)
  -> sandbox 不存在或不可用则创建
  -> 挂载用户 workspace 根目录
  -> worker 常驻，服务该用户的多个 workspace/conversation/run
```

每次 run：

```text
runConfig.workspaceId = 当前 workspace
runConfig.runtimePath = 当前 workspace 在 sandbox 内的路径
```

### workspace 级 provider 行为

```text
getOrCreateRuntime(workspaceId)
  -> 查 RuntimeBinding(runtimeType, "workspace", workspaceId)
  -> sandbox 不存在或不可用则创建
  -> 挂载该 workspace 根目录
  -> worker 常驻，服务该 workspace 的多个 conversation/run
```

## Internal API 与 Control Queue

当前 workspace 级设计有：

```text
/internal/workspaces/:workspaceId/controls
/internal/workspaces/:workspaceId/heartbeat
RuntimeControlQueue 按 workspaceId 分区
```

支持 user 级后，应泛化为 runtime binding / scope 分区：

```text
/internal/runtimes/:runtimeBindingId/controls
/internal/runtimes/:runtimeBindingId/heartbeat
RuntimeControlQueue 按 runtimeBindingId 分区
```

control payload 仍然携带业务上下文：

```text
runId
conversationId
workspaceId
```

这样 user 级 worker 能在同一个 sandbox 里处理多个 workspace 的 run，但每个 run 仍然知道自己属于哪个 workspace。

为了降低迁移风险，可以分两步：

1. 先保留 workspace endpoint，新增 runtime endpoint。
2. provider/worker 切到 runtime endpoint 后，再删除 workspace endpoint。

## 文件系统布局

### user 级

宿主机：

```text
~/.agework/workspaces/{userPrefix}/
  {workspaceA}/
  {workspaceB}/
```

sandbox 内：

```text
/workspaces/
  {workspaceA}/
  {workspaceB}/
```

runConfig：

```text
workspaceId = workspaceA
runtimePath = /workspaces/{workspaceA}
```

### workspace 级

宿主机：

```text
~/.agework/workspaces/{userPrefix}/{workspaceA}
```

sandbox 内：

```text
/workspace
```

runConfig：

```text
workspaceId = workspaceA
runtimePath = /workspace
```

## 资源治理

无论 user 级还是 workspace 级，都需要基础资源治理。但治理入口应放在 runtime 层，而不是散落到 workspace / conversation / run 业务模型里。

本阶段只实现 runtime 生命周期治理：idle 后 stop/pause。数量配额先不实现，默认不限制；内存、磁盘空间、对象存储容量等也不在 AgeWork runtime isolation 设计里配置，由底层 runtime 平台、部署环境或后续观测系统处理。

当前只保留 idle 默认参数：

```text
RUNTIME_IDLE_TIMEOUT_SECONDS=1800
```

策略：

- idle 后 stop/pause，而不是 kill 数据。
- 默认情况下，不限制每个用户同时活跃的 runtime 数。
- 默认情况下，不限制每个 runtime 内的并发 run 数。
- 本阶段不新增 `RUNTIME_MAX_*` 配置，不实现基于配额的排队或拒绝。
- 未来可以由管理员在 runtime policy 中配置数量配额，例如 `maxActiveRuntimesPerUser`、`maxRunsPerRuntime`，但它们不属于当前实施范围。
- 删除 workspace 时清理 workspace 目录；如果是 workspace 级，还删除 runtime binding。
- 删除 user 时清理 user runtime 和全部 workspace 数据。
- user 级下，workspace 删除不能直接删除 user sandbox，只清理 workspace 子目录和相关 run/conversation。

## 凭证和网络策略

user 级默认会让同一用户的 workspace 共享 sandbox，因此凭证策略要小心。

推荐：

- 模型 API key 不直接注入 sandbox env，优先通过 AgeWork API 或 OpenSandbox Credential Vault 代理。
- user 级 sandbox 中，workspace 级凭证不能落成全局 env。
- 如果某 workspace 有高敏感凭证或更严格 egress 策略，应升级到 workspace 级 isolation。
- 未来策略引擎可以根据 workspace 风险自动选择 `workspace` scope，但当前先保持服务级配置。

## 实施计划

### Phase 1：配置和决策服务

- 新增 `RUNTIME_ISOLATION_SCOPE=user|workspace`，默认 `user`。
- 新增 `RuntimePlacementService`，统一产出 runtimeType、scope、scopeId、hostPath、runtimePath。
- `AgentRunHandler` / `RuntimeRunner` 不再直接从 workspace 或 env 拼 runtime 细节。

### Phase 2：数据模型泛化

- 新增 `RuntimeBinding`。
- 迁移现有 `WorkspaceRuntimeBinding` 数据到 `RuntimeBinding(isolationScope="workspace")`。
- provider 查询 binding 时改用 `runtimeType + isolationScope + scopeId`。

### Phase 3：Provider 支持 user scope

- DockerProvider 支持挂载 user workspace root。
- OpenSandboxProvider 支持挂载 user workspace root。
- `RunConfig.runtimePath` 指向具体 workspace 子目录。
- 保留 workspace scope 逻辑。

### Phase 4：Internal runtime endpoint

- 新增 `/internal/runtimes/:runtimeBindingId/controls`。
- 新增 `/internal/runtimes/:runtimeBindingId/heartbeat`。
- `RuntimeControlQueue` 按 `runtimeBindingId` 分区。
- worker 从 workspace polling 切到 runtime polling。

### Phase 5：资源治理

- idle stop/pause。
- 不实现数量配额，默认不限额。
- 不实现内存或磁盘空间配额。

### Phase 6：可选策略化

当前不做多策略选择。未来可以扩展：

```text
default: user
workspace.sensitivity=high -> workspace
enterprise tenant -> workspace
free tenant -> user
```

但这是后续能力，不应影响当前“单服务单 runtime provider + 单服务单 isolation scope”的简洁部署模型。

## 当前不做

- 不做 conversation/run 级 sandbox。
- 不让普通用户在 UI 中选择 runtime provider。
- 不让 workspace API 接收 runtime provider override。
- 不在本阶段实现按租户/套餐动态选择 isolation scope。
- 不在本阶段实现 runtime 数量配额；未来可作为管理员 runtime policy 能力。
- 不让 local provider 强行提供真实 workspace 隔离。

## 最终边界

```text
部署方选择:
  RUNTIME_PROVIDER
  RUNTIME_ISOLATION_SCOPE

AgeWork 上层:
  Workspace / Conversation / Run 不关心 provider 内部实现

RuntimePlacementService:
  决定这次 run 使用哪个 scope、哪个 binding、哪个 runtimePath

RuntimeProvider:
  负责创建/复用/停止底层 runtime

Run:
  记录实际 runtimeType/runtimeResourceId，作为审计和恢复事实
```

这使 AgeWork 在默认服务器部署中可以先走成本更低的 user 级 sandbox，同时保留 workspace 级强隔离能力。
