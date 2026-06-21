# SandboxRuntimeProvider 与 SandboxBackend 重构设计

> 前置文档：
> - `docs/superpowers/specs/2026-06-12-docker-persistent-container-design.md`
> - `docs/superpowers/specs/2026-06-12-opensandbox-provider-design.md`
> - `docs/superpowers/specs/2026-06-13-runtime-isolation-scope-design.md`
> - `docs/superpowers/specs/2026-06-13-opensandbox-sdk-notes.md`

## 结论

当前仍处于开发阶段，不需要兼容旧的 `RUNTIME_PROVIDER=docker | opensandbox` 配置。下一步建议直接把 Docker 和 OpenSandbox 的重复编排逻辑抽到一个 `SandboxRuntimeProvider`，再把底层创建运行环境的差异下沉为 `SandboxBackend`。

同时，`local` / `sandbox` 不应再是服务级二选一，而应是 workspace 级运行模式；未来还可以自然扩展 `remote`：

```text
Workspace.runtimeMode = local | sandbox | remote
```

同一个 AgeWork 服务可以同时运行 local workspace 和 sandbox workspace；未来也可以同时运行 remote workspace。但一个 workspace 在任意时刻只能有一种 runtime mode。创建 workspace 时由用户选择，后续切换必须显式停止该 workspace 的运行中任务和 runtime，再迁移模式。

```text
RuntimeProvider
  ├── LocalRuntimeProvider
  └── SandboxRuntimeProvider
        └── SandboxBackend
              ├── DockerSandboxBackend
              ├── OpenSandboxBackend
              ├── KubernetesSandboxBackend       # 未来
              ├── MicroVmSandboxBackend          # 未来
              └── VmSandboxBackend               # 未来
  └── RemoteRuntimeProvider                       # 未来
```

简化后的语义是：

```text
Workspace.runtimeMode 负责选择 local / sandbox / remote
RuntimeProvider 负责 AgeWork 怎么管理一次 run / workspace runtime
SandboxBackend 负责 sandbox 底层怎么创建、恢复、销毁
IsolationScope 只作用于 sandbox workspace，决定按 user 还是 workspace 复用
```

## 为什么要抽

`DockerRuntimeProvider` 和 `OpenSandboxRuntimeProvider` 现在大部分代码在做同一类事情：

- 注册 `RunConfig`，让 worker 后续通过 internal API 拉取。
- 为 workspace 签发 runtime access key。
- 管理 workspace 级常驻 runtime 和 `activeRuns`。
- 向 workspace control queue 推送 `user_message` / `cancel` / `approval_resolved`。
- 处理 run 终态后的 per-run cleanup。
- 处理 worker heartbeat、超时、workspace runtime shutdown。
- 在 runtime 启动期间处理 cancel。

它们真正不同的部分是底层基础设施操作：

| 能力 | Docker | OpenSandbox |
| --- | --- | --- |
| 创建 runtime | `docker run` | `Sandbox.create(...)` |
| 复用 runtime | 进程内 `containerId` / 后续可查 Docker | `WorkspaceRuntimeBinding` + `Sandbox.connect(...)` |
| 启动 worker | 镜像 entrypoint | `sandbox.commands.run(..., background: true)` 或镜像 entrypoint |
| 停止 runtime | `docker stop` / `docker kill` | `sandbox.pause()` |
| 复用 stopped runtime | `docker start` | `sandbox.resume()` |
| 恢复孤儿 | 按 containerId 停掉 | 按 sandboxId kill/delete |
| 平台能力 | 单机 Docker | OpenSandbox Server，可继续接 Docker / K8s / 安全 runtime |

所以这不是再造一层抽象，而是把一个过厚的 Provider 拆成两种责任：

```text
AgeWork 编排责任       -> SandboxRuntimeProvider
基础设施适配责任       -> SandboxBackend
```

## 概念边界

### RuntimeProvider

`RuntimeProvider` 是 AgeWork 应用层 port。它面向 `RuntimeRunner` / `RunService`，表达产品层运行模式。

当前阶段只实现两类产品语义，并在服务内同时注册：

```text
local    本机进程 / fork worker，用于本地开发或单用户可信环境
sandbox  受控隔离环境，用于服务器、多用户、不可信代码执行
```

未来可以增加：

```text
remote   用户自带或平台托管的远程开发环境 / 远程机器 / 远程 agent runtime
```

`remote` 不应塞进 `SandboxBackend`。它是另一种产品语义：workspace 的文件系统和进程主要在远端存在，AgeWork 通过远程连接、远程 worker 或远程 agent endpoint 编排它。

运行时选择来自 workspace，而不是全局环境变量：

```text
RuntimeRunner.start(...)
  -> runtimeMode = workspace.runtimeMode
  -> provider = RuntimeProviderRegistry.resolve(runtimeMode)
```

### SandboxBackend

`SandboxBackend` 是基础设施 adapter。它不理解 conversation、AG-UI、assistant-ui 消息、模型配置，也不负责 run 状态落库。

它只回答一个问题：

```text
给定一个 sandbox placement 和 worker 配置，如何拿到一个可运行 worker 的 sandbox？
```

### OpenSandbox 的位置

OpenSandbox 更像沙箱控制层，而不是 AgeWork 产品层 Provider。

```text
AgeWork API
  └── OpenSandboxBackend / SDK adapter
        ↓ HTTP
OpenSandbox Server :8080
        ↓ Docker / Kubernetes / secure runtime
实际 sandbox 容器 / pod / microVM
```

因此 OpenSandbox Server 推荐作为独立 service 跑在 Docker Compose 或 Kubernetes 中；API 包里只保留 SDK client/adapter。

## Workspace 运行模式与配置

用户在创建 workspace 时选择运行模式：

```text
workspace.runtimeMode = local | sandbox
# future: remote
```

服务级配置只负责允许范围、sandbox backend 和 sandbox 隔离策略：

```text
WORKSPACE_RUNTIME_ALLOWED_MODES=local,sandbox
SANDBOX_BACKEND=docker | opensandbox
RUNTIME_ISOLATION_SCOPE=user | workspace
```

说明：

- 不需要 `DEFAULT_WORKSPACE_RUNTIME_MODE`。默认选中哪个模式属于创建 workspace 时的运行时选择，可以由客户端、产品形态或创建请求决定。
- 服务端只校验 `workspace.runtimeMode` 是否属于 `WORKSPACE_RUNTIME_ALLOWED_MODES`。
- 如果 allowed modes 只有一种，创建请求可以省略 `runtimeMode`，服务端使用唯一允许的模式。
- 如果 allowed modes 有多种，创建请求应显式传入 `runtimeMode`；桌面客户端可以在 UI 中默认选中 `local`，但这不是服务配置。
- `SANDBOX_BACKEND` 只在 `workspace.runtimeMode=sandbox` 时生效。
- `RUNTIME_ISOLATION_SCOPE` 只在 `workspace.runtimeMode=sandbox` 时生效。
- local workspace 不创建 sandbox binding，也不参与 `RUNTIME_ISOLATION_SCOPE`。
- remote workspace 后续应有自己的 remote provider/connection 配置，不复用 `SANDBOX_BACKEND`。

## 运行模式策略

`runtimeMode` 是能力模型；具体给用户暴露哪些选项，应由部署形态和管理员策略决定。

```text
WORKSPACE_RUNTIME_ALLOWED_MODES=local,sandbox
```

建议规则：

- 客户端 / 桌面应用：默认 `local`，允许 `sandbox`。大多数用户直接用本地工作空间；需要隔离、不想污染本机依赖或要运行高风险命令时，选择本地 Docker/OpenSandbox 沙箱。
- 团队 / 云工作台：可允许 `remote`。团队可以预定义远程工作空间模板或远程机器，用户创建 workspace 时选择云上运行。
- 服务器 / SaaS 托管：可以只允许 `sandbox`。部署方通过 `WORKSPACE_RUNTIME_ALLOWED_MODES=sandbox` 禁止 local，保证所有用户代码只在受控沙箱中执行。
- 企业高安全部署：通常只允许 `sandbox`，并使用 `RUNTIME_ISOLATION_SCOPE=workspace`。

服务端必须校验 `workspace.runtimeMode` 属于 allowed modes；UI 只展示 allowed modes。用户可以选择产品语义上的 `local | sandbox | remote`，但不能直接选择底层 `docker | opensandbox | vm` backend。

### 能力检测与禁用提示

`WORKSPACE_RUNTIME_ALLOWED_MODES` 只是部署策略，不代表当前机器一定具备对应能力。最终创建页展示的可选项应是：

```text
可选 runtime modes = allowed modes ∩ 当前环境可用能力
```

MVP 不需要自动安装 Docker、启动 Docker Desktop、修复 Docker socket 权限，也不需要复杂的后台自愈。先做轻量检测和 UI 禁用即可：

- 如果 `SANDBOX_BACKEND=docker`，服务端检测 Docker CLI/daemon 是否可用。
- 如果 Docker 不可用，创建 workspace 页面仍展示 `sandbox`，但置为 disabled，并提示“未检测到 Docker 或 Docker 未运行”。
- 如果用户通过 API 强行创建 `runtimeMode=sandbox`，服务端返回明确错误，而不是自动 fallback 到 `local`。
- 如果服务端部署为 `WORKSPACE_RUNTIME_ALLOWED_MODES=sandbox` 但 Docker 不可用，创建 workspace 应被阻止，并在健康状态或设置页提示 sandbox backend 不可用。
- `local` 不依赖 Docker，始终按本机文件系统能力处理。

后续可以把能力检测抽成 `RuntimeCapabilityService`，对外返回 `local/sandbox/remote` 的 `available`、`disabledReason` 和展示文案。当前阶段只需要让 UI 能禁用不可用的 sandbox 选项。

推荐组合：

```text
本地开发:
  WORKSPACE_RUNTIME_ALLOWED_MODES=local,sandbox
  # 客户端创建 workspace 时默认传 local
  # 可选启用 sandbox backend，供单个 workspace 手动选择 sandbox

单机容器部署:
  WORKSPACE_RUNTIME_ALLOWED_MODES=sandbox
  SANDBOX_BACKEND=docker
  RUNTIME_ISOLATION_SCOPE=workspace

服务器 / SaaS 默认:
  WORKSPACE_RUNTIME_ALLOWED_MODES=sandbox
  SANDBOX_BACKEND=opensandbox
  RUNTIME_ISOLATION_SCOPE=user

高隔离部署:
  WORKSPACE_RUNTIME_ALLOWED_MODES=sandbox
  SANDBOX_BACKEND=opensandbox
  RUNTIME_ISOLATION_SCOPE=workspace
```

## 接口草案

### SandboxBackend

```ts
export type SandboxBackendType =
  | "docker"
  | "opensandbox"
  | "kubernetes"
  | "microvm"
  | "vm";

export type SandboxPlacement = {
  scope: "user" | "workspace";
  scopeId: string;
  workspaceId: string;
  workspaceHostPath: string;
  workspaceMountPath: string;
};

export type SandboxStartInput = {
  placement: SandboxPlacement;
  image: string;
  apiBaseUrl: string;
  accessKey: string;
  env: Record<string, string>;
  metadata: Record<string, string>;
};

export type SandboxRuntime = {
  backendType: SandboxBackendType;
  runtimeResourceId: string; // containerId / sandboxId / pod name / vm id
  workspaceMountPath: string;
};

export interface SandboxBackend {
  readonly type: SandboxBackendType;
  getOrCreate(input: SandboxStartInput): Promise<SandboxRuntime>;
  startWorker(runtime: SandboxRuntime, input: SandboxStartInput): Promise<void>;
  stop(runtimeResourceId: string): Promise<void>;
  recoverOrphan(runtimeResourceId: string): Promise<void>;
  isHealthy?(runtimeResourceId: string): Promise<boolean>;
}
```

`SandboxBackend` 不暴露 `RunConfig`、`ControlPayload`、`conversationId`。这些仍属于 `SandboxRuntimeProvider`。

### SandboxRuntimeProvider

`SandboxRuntimeProvider` 继续实现现有 `RuntimeProvider` 接口：

```ts
export class SandboxRuntimeProvider implements RuntimeProvider {
  readonly type = "sandbox";

  start(runConfig, onRuntimeResourceIdReady) {
    // 1. 按 isolation scope 计算 placement
    // 2. 签发 scope/workspace 级 access key
    // 3. register RunConfig
    // 4. backend.getOrCreate(...)
    // 5. backend.startWorker(...)
    // 6. push user_message control
    // 7. 返回 RuntimeHandle
  }

  cancel(handle) {
    // 只发 cancel control，不销毁 sandbox
  }

  cleanup(runId) {
    // 只清理 per-run 状态，保留 sandbox
  }

  recoverOrphan(runtimeResourceId) {
    // 委托 backend.recoverOrphan(...)
  }
}
```

## 状态模型

Workspace 应显式记录运行模式。当前 schema 中的 `defaultRuntimeType` 建议重命名为 `runtimeMode`，避免误解成“每次 run 可以覆盖的默认值”。

```prisma
model Workspace {
  id          String @id @default(cuid())
  runtimeMode String @default("local") // local | sandbox; future: remote
  // ...
}
```

Sandbox runtime binding 建议从 workspace 绑定表继续泛化，而不是绑定死 `workspaceId + runtimeType`：

```text
RuntimeBinding
  scope             user | workspace
  scopeId           userId | workspaceId
  runtimeMode       sandbox
  backendType       docker | opensandbox | ...
  runtimeResourceId containerId | sandboxId | podName | vmId
  status            running | stopped | stale
  expiresAt
  metadata
```

短期也可以沿用现有 `WorkspaceRuntimeBinding`，先完成代码结构拆分；等支持 `RUNTIME_ISOLATION_SCOPE=user` 时再泛化数据模型。local workspace 不需要持久 runtime binding，run 级事实仍记录在 `Run.runtimeType` / `Run.runtimeResourceId`。

## 隔离粒度

第一阶段只建议支持两种：

```text
user       一个活跃用户一个 sandbox
workspace  一个活跃 workspace 一个 sandbox
```

暂不建议默认支持：

- `conversation` 级：成本高，依赖环境重复，容易破坏同 workspace 的复用。
- `run` 级：隔离最强但最慢，且会破坏 agent session resume，需要额外快照/恢复能力。

如果未来需要高风险任务隔离，可以把 `run` 级作为单独策略引入，不要影响默认路径。

## 迁移步骤

### Phase 1：引入 SandboxBackend

- 新增 `SandboxBackend` 接口。
- 新增 `DockerSandboxBackend`，从 `DockerRuntimeProvider` 搬出 `docker run/stop/kill/recover` 相关逻辑。
- 新增 `OpenSandboxBackend`，从 `OpenSandboxRuntimeProvider` 搬出 `OpenSandboxClient` 创建、连接、删除、启动 worker 相关逻辑。

### Phase 2：引入 SandboxRuntimeProvider

- 新增 `SandboxRuntimeProvider`，复用当前 Docker/OpenSandbox Provider 中共有的 workspace runtime 编排逻辑。
- `SandboxRuntimeProvider` 根据 `SANDBOX_BACKEND` 选择 `DockerSandboxBackend` 或 `OpenSandboxBackend`。
- `workspace.runtimeMode=sandbox` 返回的 `RuntimeHandle.runtimeType` 统一为 `"sandbox"`。
- 如需区分底层实现，使用 runtime binding 的 `backendType` / metadata，而不是把 backend 暴露成 provider type。

### Phase 3：Workspace 选择 runtime mode

- 将 `Workspace.defaultRuntimeType` 重命名为 `Workspace.runtimeMode`，合法值为 `local | sandbox`。
- `CreateWorkspaceRequest` / workspace 创建 UI 增加 `runtimeMode`；默认选中由客户端/产品形态决定。
- 新增 `WORKSPACE_RUNTIME_ALLOWED_MODES`，服务端创建/更新 workspace 时校验 mode，UI 只展示允许的 mode。
- 如果 `WORKSPACE_RUNTIME_ALLOWED_MODES` 只有一种，服务端可以把省略的 `runtimeMode` 解析为唯一允许值；如果有多种，创建请求必须显式传入。
- 新增轻量 runtime capability 查询；当 Docker 不可用时，UI 禁用 `sandbox` 并显示“未检测到 Docker 或 Docker 未运行”。
- 单个 workspace 的 `runtimeMode` 固定；如需切换，必须先确保无 active run，并关闭已有 workspace runtime。
- `AgentRunHandler` 不再读取服务级 runtime provider，而是从 conversation 所属 workspace 读取 `runtimeMode`。
- `RuntimeRunner.start()` 使用 `workspace.runtimeMode` 解析 provider。

### Phase 4：删除厚 Provider

- 删除 `DockerRuntimeProvider` / `OpenSandboxRuntimeProvider` 的 Provider 注册。
- 迁移或删除对应的旧 Provider 单测，改为测 `SandboxRuntimeProvider` 和各 backend。
- 删除 `ConfigService.getDefaultRuntimeProviderType()` 作为运行时决策入口；运行时 provider 由 `workspace.runtimeMode` 决定。
- Registry 中长期只注册：

```text
LocalRuntimeProvider
SandboxRuntimeProvider
```

### Phase 5：引入 isolation scope

- 新增 `RUNTIME_ISOLATION_SCOPE=user | workspace`。
- 将 `workspaceContainers` / `workspaceSandboxes` 抽成通用 `sandboxStates`，key 从 `workspaceId` 泛化为 `scopeKey`。
- 必要时把 `WorkspaceRuntimeBinding` 泛化为 `RuntimeBinding`。

## 不在本次重构范围

- 不改变 worker 的 `HttpTransport` 协议。
- 不改变 AG-UI event 聚合和 assistant-ui 消息持久化。
- 不改变模型 provider / API key 选择逻辑。
- 不引入 run 级 sandbox。
- 不兼容 `RUNTIME_PROVIDER=docker | opensandbox` 旧配置值。
- 不把 `local | sandbox` 做成服务级二选一；服务应同时注册两种 provider。
- 不要求 OpenSandbox 替代 Docker；Docker 仍保留为本地、单机和调试 backend。
- 不允许 workspace 在 active run 存在时切换 runtime mode。
- 不在本次实现 remote workspace；只预留 `runtimeMode` 扩展方向。

## 验收标准

- `local` provider 行为不变。
- 同一个服务中可以同时创建 local workspace 和 sandbox workspace，并分别运行 agent。
- 单个 workspace 的 run 始终使用该 workspace 的 `runtimeMode`。
- 创建 workspace 时可以选择 `local | sandbox`；如果服务只允许一种模式，可以省略并使用唯一允许值。
- 当服务允许多种模式时，创建 workspace 必须显式传入 `runtimeMode`。
- 当 `SANDBOX_BACKEND=docker` 且 Docker 不可用时，创建页禁用 `sandbox` 并显示原因；API 创建 sandbox workspace 返回明确错误。
- `docker` backend 与当前 `DockerRuntimeProvider` 行为一致：workspace 级持久 runtime、control queue、heartbeat、cancel、cleanup、orphan recovery 均通过现有测试。
- `opensandbox` backend 与当前 `OpenSandboxRuntimeProvider` 行为一致：复用 persisted binding、启动常驻 worker、idle 后 pause/resume sandbox、recover orphan 时删除 sandbox，均通过现有测试。
- `SandboxRuntimeProvider` 的单测覆盖：
  - 首次 run 创建 sandbox。
  - 同 scope 后续 run 复用 sandbox。
  - sandbox 启动中 cancel。
  - run cleanup 不销毁 sandbox。
  - heartbeat timeout 会关闭 sandbox 并给 active runs 报错。
  - backend 创建失败会清理 access/control/config 状态。
- Docker/OpenSandbox 只在 backend 层出现，不再散落在通用 runtime 编排代码里。

## 关键判断

这次重构的目标不是让抽象变多，而是让抽象回到各自的问题域：

```text
AgeWork 关心：
  run 属于谁、状态如何、怎么取消、怎么续会话、怎么给前端发事件

SandboxBackend 关心：
  运行环境怎么创建、怎么挂载 workspace、怎么启动 worker、怎么销毁

OpenSandbox Server 关心：
  沙箱生命周期、命令执行、网络/端口、凭证、安全 runtime、底层 Docker/K8s 调度
```

当这三层边界清楚后，后续增加 VM、MicroVM、Kubernetes 或远程 runner，只需要新增 backend，而不需要再复制一份完整的 AgeWork RuntimeProvider。
