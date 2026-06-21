# AgeWork 产品定位与方向

> 记录时间：2026-06-14

## 一句话定位

AgeWork 不是一个单纯的本地 Agent 聚合器，而是一个开源、可私有化部署、可治理、可扩展的 Agent Workbench / Agent Control Plane。

本地版本负责降低试用门槛、建立信任和获取开发者用户；私有化部署负责承载团队价值、治理能力和长期商业化。

## 核心判断

### 本地聚合不是长期护城河

如果产品只停留在“本地聚合多个 Agent”，价值会比较有限。

原因是 IDE 厂商天然占据本地开发入口：编辑器上下文、文件树、diff/review、终端、插件市场和用户习惯都在 IDE 里。Zed、VS Code、JetBrains 这类产品或团队都可以把多个 coding agent 接进编辑器，并通过 ACP、内置 Agent 面板或插件生态完成聚合。

因此，AgeWork 不应该把“本地 Agent 面板”作为最终定位。它可以是入口，但不能是终点。

### 私有化部署才是主要价值

AgeWork 更适合面向需要自主管理代码、模型、密钥、运行环境和审计记录的团队或组织。

这类用户的核心诉求不是“能不能多接几个 Agent”，而是：

- 代码和数据能否留在本机、内网或私有云。
- 模型供应商、baseUrl、API key 是否可控。
- Agent 运行是否可隔离、可恢复、可审计。
- 长任务、后台任务、审批、人机协作是否可管理。
- 运行历史、上下文、workspace、日志和成本是否能被团队治理。
- 能否通过 API 接入 IDE、CLI、CI、内部系统或未来的 Agent 协议。

这些能力比“支持很多 Agent”更能形成产品差异。

## 产品方向

### Local-first to earn trust, self-hosted to create value

AgeWork 应该采用 local-first 的传播方式，但产品价值重心放在 self-hosted / private deployment。

本地版的作用：

- 让个人开发者快速试用。
- 方便开源传播和社区反馈。
- 证明产品可以在用户自己的环境中运行。
- 作为私有化部署前的轻量入口。
- 用于 dogfood runtime、workspace、agent adapter 和 UI 体验。

私有化版的作用：

- 团队共享 workspace、conversation、run history。
- 统一管理模型供应商、密钥和运行配置。
- 提供 Docker、Kubernetes、远程 worker 等可插拔 runtime。
- 支持权限、审计、日志、成本、审批和恢复。
- 提供 API-first 能力，便于被内部平台、IDE、CLI 和 CI 调用。

## Agent 支持策略

### 深度支持少数 Agent，而不是浅层聚合很多 Agent

AgeWork 当前更应该支持 2-3 个真正能干活的 Agent，并把体验做好，而不是追求支持十几个 Agent。

优先级应放在：

- 消息流和工具调用呈现稳定。
- 长任务状态清晰。
- 中断、恢复、失败处理可靠。
- session/thread 能续接。
- 文件变更、命令执行、reasoning、审批等事件能被产品化。
- Docker/local runtime 行为一致。

这比“Agent 列表很长”更符合 Workbench 产品定位。

### SDK-first, CLI-optional, Protocol-ready

当前应继续基于 SDK 开发。

SDK 对应用层产品更友好，因为它通常提供结构化事件、会话管理、中断控制、类型定义和更容易测试的接口。对于 AgeWork 这种要构建上层体验的产品，SDK 比直接模拟终端体验更合适。

CLI 不是产品核心，但应保留插槽。CLI 适合以下场景：

- 某个 Agent 没有 SDK，只有 CLI。
- SDK 落后于 CLI 新能力。
- 需要复刻原生命令行行为。
- 某些 JSON stream 或事件只有 CLI 暴露。

Protocol backend 才是真正的长期扩展点。未来可通过 ACP、A2A 或其他协议接入更多 Agent，但不应让这些协议过早牵引当前产品主线。

建议的抽象方向：

```text
AgeWork UI
  -> AG-UI / assistant-ui runtime
    -> AgeWork Runtime
      -> AgentBackend
        -> Claude SDK
        -> Codex SDK
        -> Codex CLI fallback
        -> ACP backend
        -> A2A backend
```

## 当前架构判断

### Docker 中运行 Adapter 是合理的

当前 Docker worker 中运行 Agent Adapter 没有原则性问题。

Adapter 是 AgeWork 的协议边界，职责是把不同 Agent 的原生事件转换成 AG-UI 事件，并把 run status、pending action、session id、中断等能力接入 AgeWork runtime。

Docker worker 的职责不是“跑一个假的 Agent”，而是：

```text
AgeWork Runtime Worker
  -> Agent Adapter
    -> Agent SDK / CLI / Protocol backend
      -> Native Agent
```

这个边界放在 Docker 中是合理的，因为 Docker 本来就是运行隔离层。

需要控制的是 Adapter 的厚度：

- Adapter 应做协议转换、配置注入和状态桥接。
- 不应在 Adapter 中重新实现 Agent 行为。
- 应保留 raw trace / debug event，方便排查 SDK、CLI 或协议行为差异。
- RunConfig 应保持最小化，避免把控制面业务复杂度塞进 worker。
- Docker 镜像里的 SDK/CLI 版本应可控，并有清晰升级路径。

## 与 IDE 聚合路线的区别

IDE 聚合路线的核心是“把 Agent 接进编辑器”。AgeWork 的核心应是“把 Agent 放进一个可治理的工作系统”。

两者的差异：

| 方向 | IDE 聚合 | AgeWork |
| --- | --- | --- |
| 核心入口 | 编辑器 | Web/API/私有化工作台 |
| 核心价值 | 本地编码体验 | 私有化、治理、运行管理、协作 |
| Agent 数量 | 可多接 | 少数深度支持 |
| Runtime | 通常贴近本机 IDE | local / Docker / K8s / remote worker |
| 组织能力 | 依赖 IDE/平台 | 内建审计、权限、密钥、历史、恢复 |
| 扩展方式 | 插件 / ACP | AgentBackend / RuntimeProvider / API |

AgeWork 不需要和 IDE 厂商争夺“谁的 Agent 面板更像编辑器原生”。更好的方向是成为团队可以部署、治理和扩展的 Agent 工作底座。

## 阶段性路线

### v1：把核心体验做稳

- 深度支持 Claude 和 Codex。
- 继续 SDK-first。
- 保持 AG-UI 作为前端事件协议。
- 稳定 local / Docker runtime。
- 做好 run history、workspace、conversation、stop、resume、pending action、raw trace。

### v1.5：稳定可插拔边界

- 抽象 AgentBackend。
- 将 AG-UI 转换层与 Agent 执行层解耦。
- 保留 Codex CLI fallback 插槽，但不作为主路线。
- 梳理 model provider、runtime provider、agent backend 的配置边界。

### v2：扩展协议生态

- 评估 ACP / A2A backend。
- 支持远程 Agent 服务接入。
- 强化团队治理、审计、权限和 API-first 集成。
- 面向私有化部署完善 Docker/Kubernetes/remote worker 形态。

## 结论

当前定位没有问题：AgeWork 应该继续走 SDK-first 的应用产品路线，通过 Adapter 将 Agent 能力转换为统一的 AG-UI 事件，并在 Docker/local runtime 中保持一致。

不要为了“更原生”过早切到 CLI，也不要把“聚合很多本地 Agent”当成主叙事。

更强的方向是：

```text
AgeWork = 私有化 Agent Workbench
        + 本地开发者入口
        + 可插拔 Agent / Runtime / Model / API
```

本地版负责传播和信任，私有化部署负责价值和护城河。
