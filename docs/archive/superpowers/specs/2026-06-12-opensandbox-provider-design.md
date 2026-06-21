# OpenSandboxProvider 接入设计与 DockerProvider 对比

> 前置文档：
> - `docs/superpowers/specs/2026-06-10-agent-runtime-infrastructure-design-v2.md` — AgeWork runtime 总体分层
> - `docs/superpowers/specs/2026-06-12-docker-persistent-container-design.md` — 当前 Docker workspace 级持久容器设计

## 结论

AgeWork 应新增 `OpenSandboxProvider`，并保留现有 `DockerRuntimeProvider` 作为本地兜底和对照实现。

OpenSandbox 适合替代的是底层沙箱平台能力：sandbox 生命周期、Docker/Kubernetes 调度、命令执行、文件 API、端口暴露、资源限制、网络出站策略、凭证代理、安全容器运行时。AgeWork 不应该把这些能力继续复制到自研 Docker provider 里。

但 OpenSandbox 不替代 AgeWork 的产品 runtime 编排。`Workspace`、`Thread`、`Run`、`ModelProvider`、AG-UI/SSE 消息聚合、持久化状态、用户权限仍然属于 AgeWork。

推荐边界：

```text
AgeWork
  Workspace / Thread / Run / ModelProvider
  RuntimeProviderRegistry
    ├── LocalRuntimeProvider
    ├── DockerRuntimeProvider       # 保留，legacy / local fallback
    └── OpenSandboxProvider         # 新增，推荐生产沙箱后端

OpenSandbox
  lifecycle control plane
  Docker / Kubernetes runtime backend
  execd command/file/code API
  endpoint / ingress / egress / credential vault
  secure runtime: gVisor / Kata / Firecracker
```

## 为什么不是直接删掉 DockerProvider

不建议立刻删除 `DockerRuntimeProvider`。

- 当前代码已经跑通 workspace 级持久容器，仍适合作为本地开发和回归对照。
- OpenSandbox 本地运行本质上仍依赖 Docker；出问题时保留直接 Docker provider 有助于判断是 AgeWork 逻辑问题还是 OpenSandbox 控制面问题。
- 接入 OpenSandbox 会引入一个外部 server、SDK、配置、鉴权和版本兼容面，迁移期需要灰度。
- 有些最小部署场景只想跑 API + Docker，不想额外部署 OpenSandbox Server。

合理路径是：

```text
Phase 1: 增加 OpenSandboxProvider，与 docker 并存
Phase 2: workspace.runtimeProvider 默认值从 docker 切到 opensandbox
Phase 3: DockerProvider 标记 legacy，仅用于 local / debug
Phase 4: 如果 OpenSandbox 稳定，再考虑删除 DockerProvider
```

## OpenSandbox 能省掉哪些自研工作

OpenSandbox 官方架构把沙箱平台拆成 client SDK、协议、lifecycle control plane、Docker/Kubernetes runtime backend、sandbox data plane、network/security plane。对 AgeWork 来说，这些正好是自研 Docker provider 逐步会膨胀出来的部分。

| 能力 | 自研 DockerProvider | OpenSandboxProvider |
|------|---------------------|---------------------|
| 容器生命周期 | 自己封装 `docker run/stop/rm/ps`、重启恢复、孤儿清理 | SDK/API 提供 create/get/delete/pause/resume/renew |
| 本地与生产后端 | 需要自己从 Docker 演进到 K8s | 同一 lifecycle API 后面可接 Docker 或 Kubernetes |
| 命令执行 | 需要维护 worker + HttpTransport + internal API | `execd` 已提供 command、background logs、PTY/session |
| 文件操作 | 需要自己处理容器内文件读写或 volume 映射 | SDK 提供 files/directories API |
| 端口暴露 | 需要自己处理 Docker port、反向代理、WebSocket | SDK 提供 endpoint resolution，支持 server proxy / ingress |
| 资源限制 | 自己映射 Docker flags，后续再映射 K8s | API 层已有 resource limits，runtime 后端各自 materialize |
| 网络出站限制 | 自己实现 Docker network/iptables/sidecar | OpenSandbox egress sidecar 支持策略和运行时 patch |
| 凭证保护 | API key 传入 env，容易被 agent/tool 读到 | Credential Vault 可把真实凭证留在 sidecar，沙箱内只放 fake env |
| 安全 runtime | 自己研究 gVisor/Kata/Firecracker 接入 | OpenSandbox 已把 secure runtime 纳入平台配置 |
| 快照/暂停恢复 | 自己实现 container commit 或 worktree 机制 | Docker snapshot 和 K8s rootfs snapshot 路线已有设计 |
| 诊断与运维 | 自己补日志、事件、指标和调试 API | server/execd/ingress/egress 有诊断和 request id 边界 |
| 多语言生态 | AgeWork 只会有自己的 TS/Nest 接入 | OpenSandbox 提供 TS/Python/Go/Java/C# SDK 和 CLI/MCP |

最关键的优势不是“少写几行 docker 命令”，而是不用在 AgeWork 里维护一个逐渐复杂的 sandbox control plane。

## 仍然需要 AgeWork 自己做的部分

OpenSandbox 不理解 AgeWork 的业务对象，所以这些仍然保留在 AgeWork：

- `Workspace -> sandboxId` 绑定、选择哪个 provider、何时创建和销毁 sandbox。
- `Run` 记录、`providerType`、`runtimeId`、状态、心跳/超时、错误落库。
- `Thread.agentResumeId`、pending action、cancel、resume 语义。
- AG-UI event 到 assistant-ui message 的聚合与持久化。
- `ModelProvider` 选择、用户级权限、workspace 权限。
- SSE 到前端的流式输出通道。
- OpenSandbox SDK 错误映射成 AgeWork 用户可见错误。

也就是说，Provider 只负责“在哪里跑”和“怎么进出沙箱”，AgeWork 负责“这一轮 run 是什么、属于谁、状态如何、怎么展示”。

## Provider 粒度

延续当前结论：OpenSandbox sandbox 仍应按 workspace 级复用，而不是 user/thread/run 级。

```text
User       -> 权限、配额、可见 workspace
Workspace  -> sandbox 生命周期、文件系统、依赖环境
Thread     -> 会话/resume/cancel/pending action 分片
Run        -> 单次执行、事件、状态、终态清理
```

原因：

- Workspace 是文件系统和依赖环境边界，最适合映射为一个长期 sandbox。
- Thread 级 sandbox 会导致同一 Workspace 多会话重复创建环境，冷启动和依赖安装成本高。
- Run 级 sandbox 最安全但最慢，且会破坏同一 thread 的 agent session resume。
- User 级 sandbox 太粗，会把多个 Workspace 的文件和依赖混在一起。

## 建议的数据模型

当前 `Workspace.runtimeProvider` 已能表达 workspace 选择哪个 provider，但不适合长期保存外部 runtime 绑定。建议增加独立绑定表，避免把 OpenSandbox 的 `sandboxId`、Docker 的 `containerId`、未来其他平台 ID 都塞进 `Workspace`。

```prisma
model WorkspaceRuntimeBinding {
  id                String    @id @default(cuid())
  workspaceId       String
  providerType      String    // docker | opensandbox | ...
  externalRuntimeId String    // sandboxId | containerId | ...
  status            String    @default("running")
  expiresAt         DateTime?
  metadata          String    @default("{}")
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt

  @@unique([workspaceId, providerType])
  @@index([providerType, status])
}
```

`Run.runtimeId` 继续记录本次 run 关联的 provider runtime id。对于 OpenSandbox，它可以记录 `sandboxId`，也可以在 `metadata` 中记录 command/execution id。

## OpenSandboxProvider 设计

### 配置

新增环境变量：

```text
AGEWORK_RUNTIME_PROVIDER=opensandbox
OPENSANDBOX_DOMAIN=localhost:8080
OPENSANDBOX_PROTOCOL=http
OPENSANDBOX_API_KEY=...
OPENSANDBOX_IMAGE=agework/worker:latest
OPENSANDBOX_WORKSPACE_MOUNT=/workspace
OPENSANDBOX_TIMEOUT_SECONDS=3600
OPENSANDBOX_USE_SERVER_PROXY=true
```

说明：

- 本地开发可以用 OpenSandbox Docker runtime。
- 服务器生产可以切 OpenSandbox Kubernetes runtime，不影响 AgeWork Provider 接口。
- `OPENSANDBOX_IMAGE` 可以先使用 AgeWork worker 镜像；后续再评估是否直接用 OpenSandbox code-interpreter 镜像安装 agent CLI。

### start(runConfig)

```text
OpenSandboxProvider.start(runConfig)
  -> getOrCreateSandbox(workspaceId)
       -> 查 WorkspaceRuntimeBinding
       -> 若 sandbox running: reuse
       -> 若不存在/不可用: Sandbox.create(...)
  -> RuntimeConfigStore.register(runId, containerRunConfig)
  -> 启动或通知 sandbox 内 worker
  -> 返回 RuntimeHandle {
       runId,
       providerType: "opensandbox",
       runtimeId: sandboxId,
       threadId
     }
```

有两种执行路径：

1. **沿用 AgeWork worker + HttpTransport**  
   sandbox 内跑常驻 `apps/worker`，仍轮询 AgeWork internal runtime API。OpenSandbox 只负责创建 sandbox、暴露端口、续期、销毁、网络/凭证策略。

2. **直接用 OpenSandbox commands.run 启动每个 run**  
   Provider 调 `sandbox.commands.run(...)` 执行 worker/agent 命令，并把 stdout/stderr 映射回 AgeWork event。这个路径更少基础设施，但和现有 `RuntimeTransport`/AG-UI event 聚合的契合度较差。

推荐先选路径 1，因为它最大程度复用当前 `RuntimeEventProcessor`、`RuntimeConfigStore`、`RuntimeControlQueue` 和 worker 多路复用设计。

### cancel(handle)

`cancel` 不删除 sandbox，只取消该 run/thread。

```text
OpenSandboxProvider.cancel(handle)
  -> 如果走常驻 worker: sendControl(cancel)
  -> 如果走 commands.run: kill/interrupt 对应 command execution
  -> activeRuns.delete(runId)
```

### cleanup(runId)

Run 终态只清 per-run 状态，不销毁 workspace sandbox。

```text
cleanup(runId)
  -> RuntimeConfigStore.unregister(runId)
  -> RuntimeInternalAccessService.unregisterRun(runId)
  -> activeRuns.delete(runId)
  -> sandbox 保留
```

### shutdownContainer(workspaceId)

接口名可以暂时沿用，但语义应改成“关闭 workspace runtime”。

```text
shutdownWorkspaceRuntime(workspaceId)
  -> 查 WorkspaceRuntimeBinding
  -> sandbox.kill/delete
  -> 清 binding
  -> 清 workspace control queue / access key / heartbeat watchdog
```

如果保留 `RuntimeProvider.shutdownContainer?(workspaceId)`，OpenSandboxProvider 可以实现为删除 sandbox。

## 凭证策略

OpenSandbox 的 Credential Vault 是相比自研 DockerProvider 最有价值的安全能力之一。

当前自研 DockerProvider 倾向于把模型 API key 通过 `RunConfig.adapter` 或 env 传入 worker。这样 agent 进程、子命令、日志、恶意脚本都有机会读到真实 key。

OpenSandbox 路线：

```text
AgeWork API 持有真实 key
  -> OpenSandbox Credential Vault 写入 sidecar
  -> sandbox env 放 fake key
  -> agent CLI 正常请求 api.anthropic.com / api.openai.com
  -> egress sidecar 按 host/path/method 注入真实 header
```

建议默认策略：

- sandbox 内只放 fake `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`。
- networkPolicy 默认 deny。
- 只 allow 模型 API 域名、npm/pnpm registry、git host、用户明确授权的域名。
- Credential binding 按 host + path 收窄，例如 Anthropic `/v1/*`、OpenAI `/v1/*`。
- trace 和日志永远不记录真实 key。

## 相比自研 DockerProvider 的主要优势

### 1. 控制面从“项目代码”变成“平台能力”

自研 DockerProvider 会不断新增：

```text
container lifecycle
runtime access key
workspace heartbeat
control queue
port proxy
egress sidecar
credential injection
volume backend
snapshot
secure runtime
K8s migration
diagnostics
```

这些都不是 AgeWork 的核心产品价值。OpenSandbox 已经把它们收敛成 sandbox 平台边界。

### 2. Docker 到 Kubernetes 的迁移成本更低

如果继续自研 DockerProvider，将来上 K8s 时需要重写 provider、worker 网络、端口暴露、volume、ingress、network policy、secret 管理。

OpenSandbox 已有 Docker runtime 和 Kubernetes runtime，AgeWork 只依赖 OpenSandbox lifecycle API。后端从 Docker 切到 K8s 时，AgeWork 主要改 OpenSandbox server 配置，而不是改 AgeWork runtime 编排。

### 3. 安全能力更完整

自研 Docker 默认只是 namespace/cgroup 隔离，共享宿主内核。OpenSandbox 支持 secure container runtime 路线，包括 gVisor、Kata、Firecracker，用于更强的多租户隔离。

更现实的安全收益是 egress + Credential Vault：即使 agent 执行了不可信命令，也不应该能直接读取真实模型 key。

### 4. 更适合后续 GUI/浏览器/远程开发场景

AgeWork 后面如果要支持浏览器自动化、Playwright、VS Code Web、VNC 桌面环境，自研 DockerProvider 会继续扩大 scope。OpenSandbox 已把 command、filesystem、code interpreter、browser automation、desktop/code-server 示例放在同一个平台模型里。

### 5. 降低维护和测试矩阵

自研 DockerProvider 每个 runtime 行为都要自己测：

- Docker on macOS
- Docker on Linux
- rootless Docker
- corporate proxy / registry mirror
- port conflict
- container orphan
- API restart
- workspace delete
- egress rule drift
- secret leak

OpenSandbox 不能消除这些问题，但能把大部分问题移动到 OpenSandbox 的公共测试和社区维护面里。AgeWork 只测 Provider 适配契约。

## OpenSandbox 的代价和风险

### 1. 多一个服务依赖

AgeWork 部署不再只是 API + Web + DB + Docker，还要部署 OpenSandbox Server。本地开发也需要先启动 OpenSandbox，或保留 DockerProvider 作为低门槛路径。

### 2. 版本兼容风险

OpenSandbox 正在快速演进。AgeWork 需要 pin SDK/server 版本，并把 provider 适配测试固定下来。

### 3. 部分能力仍要验证

接入前必须验证：

- TypeScript SDK 对 create/get/delete/commands/files/credentialVault 的实际 API 形状。
- 长期 sandbox + 常驻 worker 的稳定性。
- Credential Vault 对 Claude Code / Codex CLI 的 header 注入是否满足现有模型服务配置。
- OpenSandbox server proxy / endpoint 在 AgeWork 部署网络中的可达性。
- host volume 是否能直接映射本地 Workspace；K8s 下是否要切 PVC/OSSFS/sync。

### 4. 不是所有 OpenSandbox 能力都该暴露给用户

OpenSandbox 有 code interpreter、browser、desktop、MCP、CLI 等能力。AgeWork 初期只应该接 Provider 所需最小集合：

- lifecycle
- command/endpoint
- volume
- networkPolicy
- credentialVault
- resource limits

不要把 OpenSandbox 的所有概念直接泄露到 AgeWork UI。

## 实施计划

### Task 1: Provider 类型和配置

- `RuntimeProviderRegistry` 注册 `OpenSandboxProvider`。
- `ConfigService.getDefaultRuntimeProviderType()` 支持 `opensandbox`。
- Workspace 创建/编辑时允许 `runtimeProvider = "opensandbox"`。
- 增加 OpenSandbox connection config。

### Task 2: WorkspaceRuntimeBinding

- 新增 Prisma model。
- 新增 service：按 `workspaceId + providerType` 查询/更新 binding。
- 支持 stale binding 清理。

### Task 3: OpenSandboxProvider MVP

- 安装 `@alibaba-group/opensandbox`。
- 实现 `type = "opensandbox"`。
- `start()` 创建或复用 workspace sandbox。
- 返回 `RuntimeHandle.runtimeId = sandboxId`。
- `shutdownContainer(workspaceId)` 删除 sandbox。
- `recoverOrphan(runtimeId)` 检查 sandbox 是否存在，不存在则标记 run error。

### Task 4: 常驻 worker 路径

- OpenSandbox sandbox 启动 AgeWork worker。
- worker 使用现有 `HttpTransport` 访问 AgeWork internal runtime API。
- endpoint/server proxy 配置跑通。
- workspace 级 control queue 继续复用。

### Task 5: Credential Vault 和 networkPolicy

- 默认 deny egress。
- 按 ModelProvider 生成 Credential Vault binding。
- 模型 API key 不再进入 sandbox env。
- npm/git/package registry 作为显式 allowlist。

### Task 6: 验证

不自动 build/lint。建议手动或 CI 覆盖：

1. `pnpm --filter api typecheck`
2. `OpenSandboxProvider.start()` 单测：已有 binding 复用、无 binding 创建、创建失败报错。
3. 同一 workspace 两个 thread 并发 run，事件按 runId 回到各自 Thread。
4. 同一 thread 连续两轮消息能 resume。
5. cancel 一个 thread 不影响同 workspace 其他 thread。
6. workspace 删除会 kill sandbox 并清 binding。
7. Credential Vault 下模型请求成功，sandbox 内读不到真实 key。

## 取舍建议

短期：新增 `OpenSandboxProvider`，默认仍可保留 `docker`，用 workspace 级 sandbox 跑通主链路。

中期：生产默认切 `opensandbox`，DockerProvider 仅作为 local fallback。

长期：如果 OpenSandbox 的 Docker/K8s/egress/Credential Vault 路线稳定，就不要继续扩展自研 DockerProvider。后续其他沙箱平台也按同一个 `RuntimeProvider` 接口新增，例如 `E2BProvider`、`DaytonaProvider`、`CubeSandboxProvider`，不要污染 AgeWork 的业务层。

## 资料来源

- OpenSandbox Architecture: https://open-sandbox.ai/overview/architecture
- OpenSandbox GitHub README: https://github.com/opensandbox-group/OpenSandbox
- OpenSandbox TypeScript SDK README: https://github.com/opensandbox-group/OpenSandbox/blob/main/sdks/sandbox/javascript/README.md
- OpenSandbox Credential Vault: https://github.com/opensandbox-group/OpenSandbox/blob/main/docs/credential-vault.md
- 当前 Docker 持久容器设计：`docs/superpowers/specs/2026-06-12-docker-persistent-container-design.md`
- 当前 Provider 接口：`packages/shared/src/protocol/transport.ts`
