# AgeWork Runtime Provider 架构设计

## 背景

AgeWork 当前是一个 Web + API 的 Agent 工作台：

- `apps/web` 提供聊天、项目、线程、配置等 UI。
- `apps/api` 使用 NestJS 承担项目、线程、消息、用户、Agent run 编排。
- Agent 目前通过 Codex / Claude adapter 在项目工作目录中执行，并以 AG-UI event stream 返回给前端。

后续存在两类重要运行形态：

1. **本地化运行**
   - 用户在自己的机器上运行 AgeWork。
   - 用户可以选择任意本地项目文件夹。
   - Agent 直接在本机进程中执行。
   - 不强调多用户隔离，重点是低成本、低延迟、使用本机环境。

2. **服务器多用户运行**
   - AgeWork 部署在服务器上，支持多个用户。
   - 项目 workspace 由系统托管，用户不能任意指定服务器路径。
   - Agent 应在沙箱、容器、远程 worker 或其他隔离环境中执行。
   - 需要考虑资源限制、并发调度、网络策略、环境清理、审计追踪。

这两类形态有大量公共部分：UI、API、线程、消息、Agent 配置、事件协议、run 状态、trace、人机交互。差异主要集中在“文件在哪里”和“Agent 在哪里执行”。

因此，架构目标不是维护两套系统，而是把 AgeWork 设计成：

```text
AgeWork = Agent UI + Control Plane + Scheduler
Runtime Provider = 可插拔执行环境
Agent Adapter = Agent 协议适配
```

## 总体原则

### 不按入口形态拆业务

Web / Electron 是入口形态，不是业务边界。

```text
入口形态:
  Browser Web
  Electron Desktop, later

运行形态:
  Local Runtime
  Server Runtime
  Docker Runtime
  OpenSandbox Runtime
  Custom Runtime
```

Electron 后续可以作为桌面壳存在，但不应承载核心业务逻辑。它主要提供浏览器缺失的本地 OS 能力，例如选择本地文件夹、启动本地 API、系统通知、菜单、自动更新。

### NestJS 是产品内核

`apps/api` 应继续作为统一业务层：

- Auth / Users
- Projects
- Threads / Messages
- Model Configs
- Run Scheduling
- Run State
- Trace / Audit
- Runtime Provider Registry

本地版和服务器版都复用同一套 NestJS 业务模型。

### Provider 只包部署差异

不应该把所有业务都 provider 化。以下概念应保持为产品内核：

- Thread
- Message
- Project
- User
- ModelConfig
- RunAggregator
- AG-UI event stream

需要 provider 化的是：

- 文件环境在哪里
- Agent 进程在哪里跑
- 凭证如何注入
- 网络策略如何限制
- CPU / 内存 / 超时如何控制
- workspace 如何创建、挂载、清理

### Project 不是目录

当前 `Project.workdir` 同时承担业务字段和运行时路径，这在本地模式下简单，但在服务器和沙箱模式下会变成架构瓶颈。

长期设计中：

```text
Project 描述产品里的项目
Workspace 描述项目文件资源
RuntimeProvider 负责把 workspace 解析成 Agent 可执行环境
```

Agent 最终只应拿到 `runtimePath`，不关心这个路径来自本机文件夹、服务器目录、Docker mount、K8s PVC 还是对象存储同步。

## 总览架构

```text
┌─────────────────────────────────────────────┐
│                 AgeWork UI                  │
│              apps/web React                 │
│                                             │
│  Project / Thread / Chat / Trace / Admin    │
└──────────────────────┬──────────────────────┘
                       │ /api/v1
┌──────────────────────▼──────────────────────┐
│             AgeWork Control Plane            │
│                apps/api NestJS               │
│                                             │
│  - Auth / Users                              │
│  - Projects / Threads / Messages             │
│  - Model Configs                             │
│  - Run Scheduling                            │
│  - Capabilities                              │
│  - Audit / Trace                             │
│  - Runtime Provider Registry                 │
└──────────────────────┬──────────────────────┘
                       │ Runtime Provider Contract
        ┌──────────────┼──────────────┬──────────────┐
        │              │              │              │
        v              v              v              v
┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
│ Local       │ │ Docker      │ │ OpenSandbox │ │ Custom HTTP │
│ Runtime     │ │ Runtime     │ │ Runtime     │ │ Runtime     │
└─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘
```

## 入口形态

### Browser + Server API

适合团队、多用户、远程访问、服务器托管 workspace。

```text
Browser
  -> apps/web
  -> Remote NestJS API
  -> RuntimeProvider
  -> Sandbox / Worker / Container
```

### Electron + Local API, later

适合个人本地 Agent、直接操作本地文件夹。

```text
Electron
  ├─ Renderer: 复用 apps/web
  ├─ Main Process: 本地 OS 能力桥
  └─ Local NestJS API sidecar
       -> Local RuntimeProvider
       -> 本机 Codex / Claude 进程
```

Electron Main 的职责应限制为：

- 启动、停止本地 NestJS API。
- 等待 API ready 并加载 UI。
- 选择本地文件夹。
- 管理窗口、菜单、托盘、通知、自动更新。
- 提供安全 IPC。

Electron 不应直接承担 Project / Thread / Agent run 业务。

## Runtime Provider

### 为什么是 RuntimeProvider

早期可以把抽象拆成 `WorkspaceProvider` 和 `ExecutionProvider`：

```text
WorkspaceProvider 管文件在哪里
ExecutionProvider 管 Agent 在哪里跑
```

但真实的沙箱系统里，workspace 和 execution 往往强耦合：

- Docker provider 需要同时管理 volume / bind mount 和 container run。
- OpenSandbox provider 需要同时管理 sandbox 文件 API 和 sandbox session。
- Remote worker provider 需要同时管理 workspace sync 和 worker process。
- Local provider 中路径和执行进程都在本机。

因此，对 AgeWork 主业务层暴露一个更粗的 `RuntimeProvider` 更稳：

```text
RuntimeProvider 对 AgeWork 暴露统一运行环境
RuntimeProvider 内部自己决定如何管理 workspace 和 execution
```

Provider 内部仍可自行拆分 workspace manager 和 executor，但不应泄漏给主业务层。

### Provider 合约

概念接口：

```ts
interface RuntimeProvider {
  capabilities(): Promise<RuntimeCapabilities>;

  prepareRun(input: PrepareRunInput): Promise<PreparedRun>;

  run(
    input: AgentRunInput,
    context: PreparedRun
  ): Observable<AgentEvent>;

  cancel(runId: string): Promise<void>;

  cleanup(runId: string): Promise<void>;

  health(): Promise<RuntimeHealth>;
}
```

`prepareRun` 负责：

- 校验 workspace 是否可用。
- 准备运行目录。
- 准备 mount、env、secret、network、limits。
- 对 sandbox 类 provider，创建或分配沙箱实例。
- 返回 Agent adapter 可以使用的运行上下文。

`run` 负责：

- 在准备好的环境中启动 Codex / Claude / 其他 Agent。
- 输出统一 AG-UI event stream。
- 记录 provider 层错误。

`cleanup` 负责：

- 销毁临时容器或沙箱。
- 回收临时目录。
- 清理 run 级别 secret。
- 根据 provider 策略保留或同步 workspace 内容。

### PreparedRun

概念结构：

```ts
type PreparedRun = {
  runId: string;
  providerId: string;
  runtimePath: string;
  hostPath?: string;
  env: Record<string, string>;
  limits?: RuntimeLimits;
  networkPolicy?: RuntimeNetworkPolicy;
  metadata?: Record<string, unknown>;
};
```

说明：

- `runtimePath` 是 Agent 看到的 cwd。
- `hostPath` 是 provider 内部可选信息，本地和单机 Docker 可能存在，远程 provider 可能不存在。
- `metadata` 可保存 sandbox id、container id、worker id 等 provider 私有信息。

## Workspace 的三个层次

不要把所有目录概念都叫 `workdir`。建议明确区分：

```text
1. 用户看到的项目来源
   local path / git url / upload / empty

2. Provider 的存储位置
   本地磁盘 / 服务器固定根目录 / volume / object storage

3. Agent 运行时看到的 cwd
   /Users/mew/code/foo 或 sandbox 内的 /workspace
```

### 本地模式

用户可以选择任意本地文件夹：

```text
Project.sourceType = local
Workspace.locator = /Users/mew/code/foo
PreparedRun.runtimePath = /Users/mew/code/foo
```

这里 `locator` 和 `runtimePath` 通常相同。

### 服务器模式

用户不能任意指定服务器路径。服务器使用受控 workspace root：

```text
AGEWORK_WORKSPACE_ROOT=/var/lib/agework/workspaces
```

项目创建后由 provider 分配：

```text
/var/lib/agework/workspaces/{userId}/{projectId}
```

但这个路径应视为 provider 内部实现。Agent 在沙箱中看到的 cwd 可能是：

```text
/workspace
```

例如：

```text
Project.sourceType = git
Project.sourceUri = https://github.com/example/repo.git

Workspace.kind = managed
Workspace.locator = workspace_abc123

PreparedRun.hostPath = /var/lib/agework/workspaces/u1/p1
PreparedRun.runtimePath = /workspace
```

### 对象存储或远程 worker

未来可能没有本机固定目录：

```text
Workspace.locator = s3://bucket/workspaces/p1
PreparedRun.runtimePath = /workspace
```

此时 provider 负责在 run 前同步文件，在 run 后同步结果。

## 数据模型演进

当前模型简化为：

```text
Project
  id
  name
  workdir
  gitUrl
  userId
```

建议逐步演进为：

```text
Project
  id
  name
  description
  userId
  sourceType        local | git | upload | empty | managed
  sourceUri         local path / git url / upload key, optional
  workspaceId
  runtimeProviderId, optional
  createdAt
  updatedAt
  deletedAt
```

新增：

```text
Workspace
  id
  userId
  projectId
  providerId
  kind              local | managed | remote
  locator           provider-specific locator
  status            ready | preparing | error | deleted
  metadata          JSON
  createdAt
  updatedAt
  deletedAt
```

新增：

```text
RuntimeProviderConfig
  id
  type              local | docker | opensandbox | http
  name
  enabled
  isDefault
  config            JSON
  capabilities      JSON, optional cache
  createdAt
  updatedAt
```

新增，可选：

```text
AgentRun
  id
  threadId
  projectId
  userId
  providerId
  agentType
  status            queued | preparing | running | cancelling | finished | error
  providerRunId
  error
  startedAt
  finishedAt
  metadata          JSON
```

`AgentRun` 不是第一阶段必须，但服务器多用户、队列、取消、重试、审计都会需要它。

## Provider 选择策略

Runtime provider 可以由多个层级决定：

```text
请求显式指定
  > Thread 指定
  > Project 指定
  > ModelConfig 指定
  > 系统默认 provider
```

早期可简化为系统默认：

```text
AGEWORK_RUNTIME_PROVIDER=local
```

后续再允许管理员在 UI 里配置多个 provider。

## Capabilities

前端不应硬编码“当前是 Electron 还是服务器”。应通过 API 获取当前能力：

```text
GET /api/v1/runtime/capabilities
```

概念返回：

```ts
type RuntimeCapabilities = {
  mode: "local" | "server";
  providerType: "local" | "docker" | "opensandbox" | "http";

  supportsLocalDirectory: boolean;
  supportsGitClone: boolean;
  supportsUpload: boolean;
  supportsManagedWorkspace: boolean;

  sandboxed: boolean;
  multiUser: boolean;
  requiresAuth: boolean;

  supportsCancel: boolean;
  supportsResourceLimits: boolean;
  supportsNetworkPolicy: boolean;
};
```

前端根据 capabilities 展示：

- 本地模式：选择本地文件夹、最近项目。
- 服务器模式：Git clone、上传项目、创建空 workspace。
- 沙箱模式：资源限制、网络策略、队列状态。

## 运行流程

### 项目创建：本地目录

```text
用户点击选择目录
  -> Electron Main 打开系统目录选择器, later
  -> 返回 /Users/mew/code/foo
  -> Web 调用 POST /projects/create
  -> ProjectService 创建 Project
  -> RuntimeProvider 创建或绑定 Workspace
  -> 保存 Workspace.locator = /Users/mew/code/foo
```

Browser 服务器版不应允许用户直接传服务器绝对路径。

### 项目创建：Git clone

```text
用户输入 gitUrl
  -> Web 调用 POST /projects/create
  -> ProjectService 创建 Project
  -> RuntimeProvider 分配 managed workspace
  -> provider 在受控目录 clone repo
  -> 保存 Workspace.locator
```

本地 provider 也可以支持 Git clone，只是 clone 到本地受控 workspace root。

### Agent run

```text
AgentController
  -> 解析 user/thread/project/profile
  -> 创建 runId
  -> 保存用户消息
  -> 选择 RuntimeProvider
  -> provider.prepareRun()
  -> provider.run()
  -> 转发 AG-UI events 到前端
  -> RunAggregator 保存 assistant message
  -> 更新 thread/run status
  -> provider.cleanup()
```

业务层关心的是 run 状态和事件流，不关心底层是否 Docker、OpenSandbox、HTTP runner。

## Local Runtime Provider

适用：

- 本地开发。
- 个人本地部署。
- 小团队、互信环境。

职责：

- 解析 local workspace。
- 返回真实本机路径作为 `runtimePath`。
- 在 NestJS 进程内通过现有 Codex / Claude adapter 执行。
- 使用当前 SDK 的 workspace-write sandbox 能力和基础并发限制。

示意：

```text
LocalRuntimeProvider.prepareRun()
  -> project.workspace.locator
  -> runtimePath = locator

LocalRuntimeProvider.run()
  -> new CodexAgentAdapter({ cwd: runtimePath })
  -> adapter.run(input)
```

限制：

- 无法提供强 CPU / 内存隔离。
- 多用户服务器场景下不安全。
- 依赖安装、全局环境修改可能污染宿主机。

## Docker Runtime Provider

适用：

- 单机服务器。
- 私有部署。
- 小规模多用户。

职责：

- 在服务器受控 workspace root 准备项目目录。
- run 时启动临时容器。
- bind mount 或 volume mount workspace 到 `/workspace`。
- 设置 CPU / memory / network 限制。
- 在容器内执行 Codex / Claude。
- 透传 AG-UI events。

示意：

```text
DockerRuntimeProvider.prepareRun()
  -> hostPath = /var/lib/agework/workspaces/u1/p1
  -> runtimePath = /workspace
  -> mount hostPath:/workspace

DockerRuntimeProvider.run()
  -> docker run ...
  -> codex/claude inside container
```

## OpenSandbox Runtime Provider

适用：

- 更正式的生产多用户场景。
- 需要更强隔离、生命周期管理、网络策略。

职责：

- 通过 OpenSandbox API 创建 sandbox。
- 准备 workspace mount 或文件同步。
- 在 sandbox 中执行 Agent CLI。
- 管理 sandbox 生命周期。
- 将 sandbox stdout / events 转换成 AG-UI event stream。

OpenSandbox provider 应作为一个 provider 实现，而不是侵入主业务层。

## Custom HTTP Runtime Provider

如果希望用户或企业接入自己的执行环境，推荐优先支持 HTTP Runtime Provider，而不是让第三方 JS 插件直接运行在 NestJS 进程内。

原因：

- 安全边界更清楚。
- provider 可以独立部署、独立扩缩容。
- 语言无关。
- 不污染 AgeWork 主进程。

概念协议：

```text
GET  /health
GET  /capabilities
POST /runs/prepare
POST /runs/{runId}/start
POST /runs/{runId}/cancel
POST /runs/{runId}/cleanup
```

`start` 返回 SSE 或 NDJSON event stream，事件尽量贴近 AG-UI。

AgeWork 与 HTTP provider 之间的关系：

```text
AgeWork Control Plane
  -> HTTP Runtime Provider
      -> 自定义沙箱 / K8s / SSH / CI runner / 企业内部平台
```

## Agent Adapter

Agent adapter 的职责应保持单一：

```text
把 Codex / Claude / 其他 Agent SDK 或 CLI 输出翻译成统一 AG-UI event stream
```

它不应关心：

- 多用户隔离。
- 租户权限。
- 项目来源。
- 沙箱生命周期。
- 队列策略。
- Electron。

这样可以避免组合爆炸：

```text
不要变成:
  CodexLocalAdapter
  CodexDockerAdapter
  CodexOpenSandboxAdapter
  ClaudeLocalAdapter
  ClaudeDockerAdapter
  ClaudeOpenSandboxAdapter

推荐:
  CodexAgentAdapter
  ClaudeAgentAdapter
  +
  LocalRuntimeProvider
  DockerRuntimeProvider
  OpenSandboxRuntimeProvider
```

## 队列和调度

本地模式可以直接执行，不再通过环境变量做简单并发限制。

服务器模式建议引入显式 run 状态和队列：

```text
queued -> preparing -> running -> finished
                          -> error
                          -> cancelling -> cancelled
```

队列可以后续使用 BullMQ / Redis，但不必在第一阶段引入。第一阶段可以先通过 `AgentRun` 模型和 `RuntimeProvider` 接口把状态边界留出来。

## 安全边界

### 本地模式

用户运行在自己的机器上，默认信任用户自己选择的目录和本机环境。

仍建议：

- 明确显示 Agent 会修改所选目录。
- 默认禁用危险网络能力，或由用户显式开启。
- 复用 SDK 自带 workspace-write sandbox。
- 避免把 npm cache 等写入项目目录。

### 服务器模式

服务器模式必须假设用户之间不互信。

必须避免：

- 用户提交任意服务器绝对路径。
- 多个用户共享同一可写运行环境。
- Agent 直接在宿主机执行。
- 无资源限制地并发运行。
- secret 泄漏到日志或跨 run 复用。

服务器 provider 应承担：

- 每个 run 或 workspace 的隔离。
- CPU / memory / timeout。
- 网络策略。
- 文件系统挂载策略。
- 生命周期清理。

AgeWork 主业务层承担：

- 用户权限。
- Project / Thread 访问控制。
- Run 审计。
- Provider 配置访问控制。

## 当前代码的演进入口

当前关键路径：

```text
AgentController.run()
  -> ThreadService.getProjectInfo()
  -> AgentService.getAdapter(agentType, projectWorkdir)
  -> adapter.run()
```

建议演进为：

```text
AgentController.run()
  -> RunService.createRunContext()
  -> RuntimeProviderRegistry.resolve()
  -> provider.prepareRun()
  -> provider.run()
  -> RunAggregator / ThreadService 保存结果
  -> provider.cleanup()
```

当前可逐步替换的位置：

### ProjectService.create

当前直接：

```text
mkdir / git clone / 保存 workdir
```

后续改为：

```text
创建 Project
调用 RuntimeProvider 创建 Workspace
保存 workspaceId / sourceType / sourceUri
```

### ThreadService.getProjectInfo

当前返回：

```text
{ workdir, name }
```

后续应减少对 `workdir` 的依赖。Agent run 应通过 `projectId` 和 provider resolve 出 runtime context。

### AgentService.getAdapter

当前：

```text
getAdapter(agentType, cwd, trace)
```

后续：

```text
getAdapter(agentType, preparedRun, trace)
```

或者由 `LocalRuntimeProvider` 内部创建 adapter。

### AgentController

当前同时负责：

- 保存消息。
- 找 project workdir。
- 创建 adapter。
- 处理 SSE。
- 保存 assistant message。
- run 状态。

后续可以把 run 编排抽成 `RunService` 或 `ExecutionService`，Controller 保持薄一些。

## 分阶段实施建议

### 阶段 1：保留现有行为，明确 Runtime 边界

目标：功能不变，结构开始稳。

- 新增 runtime capabilities API。
- 新增 RuntimeProvider interface。
- 实现 LocalRuntimeProvider，内部复用当前 adapter 创建逻辑。
- AgentController 不再直接依赖 `projectWorkdir`，而是通过 runtime context 获取 `runtimePath`。
- 暂不做 Electron。
- 暂不引入 Docker / OpenSandbox。

### 阶段 2：Workspace 模型演进

目标：减少 `Project.workdir` 的中心地位。

- 新增 Workspace 模型。
- Project 增加 `sourceType`、`sourceUri`、`workspaceId`、`runtimeProviderId`。
- 兼容旧 `workdir` 数据。
- ProjectService 委托 provider 创建 workspace。

### 阶段 3：AgentRun 和调度状态

目标：为服务器多用户和队列做准备。

- 新增 AgentRun 模型。
- run 状态从 Thread 的简单 `runStatus` 扩展成独立 run 状态。
- 增加 cancel / cleanup 生命周期。
- 本地模式仍可同步执行。

### 阶段 4：Docker 或 OpenSandbox Provider

目标：支持服务器沙箱执行。

- 实现 DockerRuntimeProvider 或 OpenSandboxRuntimeProvider。
- 支持资源限制、网络策略、临时容器清理。
- workspace mount 到统一 `/workspace`。
- 保持 AG-UI event stream 不变。

### 阶段 5：Custom HTTP Runtime Provider

目标：允许企业或高级用户接入自己的执行环境。

- 定义 HTTP provider 协议。
- 支持 provider health/capabilities。
- 支持 SSE / NDJSON event stream。
- 管理 provider auth secret。

### 阶段 6：Electron Shell

目标：提供本地桌面客户端。

- 新增 `apps/desktop`。
- Renderer 复用 `apps/web`。
- Main Process 启动 local NestJS API。
- 提供目录选择 IPC。
- 根据 capabilities 展示本地目录能力。

## 不建议的方向

### 不建议现在先做 Electron

Electron 是入口壳，边界相对清晰。太早做会分散精力到打包、自动更新、跨平台路径、端口管理等问题，而核心 runtime 边界还没稳定。

### 不建议让 Electron Main 承担业务

避免：

```text
Web -> Electron IPC -> 直接跑 Agent / 写消息 / 管线程
```

这会导致 Web 服务器版和 Electron 本地版分裂。

### 不建议长期依赖 Project.workdir

本地可以是路径，服务器和远程 provider 不一定有可见路径。业务层应依赖 workspace id 和 provider resolve 结果。

### 不建议为每个 Agent 和每种 Runtime 写组合 adapter

组合爆炸会很快出现。应保持：

```text
AgentAdapter 处理 Agent 协议差异
RuntimeProvider 处理运行环境差异
```

## 最终判断

AgeWork 更适合定位为 Agent Control Plane：

```text
AgeWork 负责：
  UI 展示
  用户 / 项目 / 线程 / 消息
  Agent run 调度
  状态记录
  权限策略
  日志追踪
  人机交互
  Runtime 选择

Runtime Provider 负责：
  文件环境
  进程执行
  沙箱隔离
  资源限制
  网络策略
  环境清理
```

这条边界能同时支持：

- 当前 Web + API 本地运行。
- 未来服务器多用户沙箱运行。
- 企业自定义执行环境。
- Electron 桌面客户端。

最重要的架构线是：

```text
Web/Electron 是入口
NestJS 是产品内核
RuntimeProvider 是执行环境边界
AgentAdapter 是 Agent 协议边界
```
