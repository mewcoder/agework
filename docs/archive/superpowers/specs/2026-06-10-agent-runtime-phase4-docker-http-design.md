# Agent Runtime Phase 4 — DockerProvider / HttpTransport 设计

> **前置文档**：
> - `docs/superpowers/specs/2026-06-10-agent-runtime-infrastructure-design-v2.md` — 总体架构设计
> - `docs/superpowers/specs/2026-06-10-agent-runtime-phase3-worker-process-design.md` — Phase 3 实现

## 背景与目标

Phase 3 已完成 `LocalProcessProvider` + `IpcTransport`，agent 运行在 API fork 出的本地子进程中。Phase 4 在此基础上引入 `DockerProvider` + `HttpTransport`，使 agent 能运行在 Docker 容器内，实现：

1. **资源隔离**：agent 运行环境与 API 进程隔离，避免 agent 代码/工具执行影响 API 稳定性
2. **多用户安全**：服务器多用户场景下，用户 workspace 通过 Docker mount 隔离，不共享宿主文件系统
3. **可扩展性**：为后续 K8s / microVM / 自定义 runner 打下基础

## 范围

**本期做**：
- ✅ `DockerProvider` 实现 `RuntimeProvider` 接口
- ✅ `HttpTransport` 实现 `RuntimeTransport` 接口（worker 侧）
- ✅ API 侧新增 internal runtime API（`/internal/runs/:runId`）供 worker 拉取 config / 上报 event / 轮询 control
- ✅ runtime token（run-scoped，短期有效）
- ✅ 最小 `RunEvent` inbox 表，支撑 HTTP 幂等和 at-least-once
- ✅ Docker 容器生命周期管理（run / stop / cleanup）
- ✅ API 重启后对 Docker Run 的恢复（重新绑定 handle 或标记 error）

**本期不做**（后置到 Phase 5 及以后）：
- 🚫 K8s / microVM / 自定义 runner
- 🚫 完整 Event Store（长期保存、回放、断线续传）
- 🚫 Workspace sync 策略（remote / sync 模式）
- 🚫 多 Agent 并行

## 架构变化

### Phase 3（当前）

```
API (NestJS) ──fork()──> worker (Node.js, IpcTransport)
                          └──> Agent Adapter
```

### Phase 4（目标）

```
API (NestJS) ──docker run──> worker (Node.js, HttpTransport)
                               └──> Agent Adapter
                               
worker <──HTTP──> API internal runtime API
  - GET  /internal/runs/:runId          (fetch config)
  - POST /internal/runs/:runId/events  (emit events)
  - GET  /internal/runs/:runId/controls  (poll controls)
```

## 1. 新增 internal runtime API

在 `apps/api` 中新增一个内部 API 模块，不暴露给前端，仅供 worker 调用：

```ts
// apps/api/src/runtime/runtime.controller.ts
@Controller("internal/runs")
export class RuntimeController {
  // GET /internal/runs/:runId
  // Authorization: Bearer <runtime-token>
  async getRunConfig(@Param("runId") runId: string): Promise<RunConfig>

  // POST /internal/runs/:runId/events
  // Body: Envelope<UpstreamMessage>
  async postEvent(@Param("runId") runId: string, @Body() envelope: Envelope)

  // GET /internal/runs/:runId/controls?afterSeq=<seq>
  // Long-polling, 30s timeout
  async pollControls(@Param("runId") runId: string, @Query("afterSeq") afterSeq: number)
}
```

### runtime token

- 每个 Run 创建时生成一个 run-scoped token（JWT，包含 `runId`  claim，有效期 24 小时）
- token 存入 Run 表 `runtimeToken` 字段（加密存储）
- worker 启动时通过环境变量 `AGEWORK_RUNTIME_TOKEN` 获取
- internal API 通过 `Authorization: Bearer <token>` 校验，确保只能访问自己的 run

### RunEvent inbox 表

```prisma
model RunEvent {
  runId       String
  seq         Int
  type        String
  payloadJson String
  ts          String
  receivedAt  DateTime @default(now())

  @@id([runId, seq])
  @@index([runId])
}
```

用途：
- HTTP event 上报时的幂等去重（`runId + seq` 唯一约束）
- API 重启后恢复未处理的 event（从 inbox 读取并重新 publish）
- 本期不提供回放 UI，仅作为 transport 可靠性保障

## 2. HttpTransport（worker 侧）

```ts
// apps/worker/src/http-transport.ts
export class HttpTransport implements RuntimeTransport {
  private eventSeq = 0;
  private controlSeq = 0;
  private pendingControls: Envelope<ControlPayload>[] = [];

  async fetchRunConfig(): Promise<RunConfig> {
    // GET /internal/runs/:runId
    // 带 runtime token
  }

  async emit(msg: UpstreamMessage): Promise<void> {
    // POST /internal/runs/:runId/events
    // 带 Idempotency-Key: <runId>:<seq>
    // 2xx 确认后删除本地 buffer；失败重试（退避）
  }

  subscribeControls(cb: (control: Envelope<ControlPayload>) => void): Unsubscribe {
    // GET /internal/runs/:runId/controls?afterSeq=<controlSeq>
    // Long-polling，收到 control 后 callback
  }

  async close(): Promise<void> {
    // 停止轮询，清空 buffer
  }
}
```

启动时根据 `process.env.RUNTIME_TRANSPORT` 选择 transport：
- `ipc` → `IpcTransport`（Phase 3，本地子进程）
- `http` → `HttpTransport`（Phase 4，Docker/远程）

## 3. DockerProvider（API 侧）

```ts
// apps/api/src/runs/docker-provider.service.ts
@Injectable()
export class DockerProvider implements RuntimeProvider {
  async prepareRun(input: PrepareRunInput): Promise<PreparedRun> {
    // 1. 生成 runtime token
    // 2. 组装 RunConfig
    // 3. 确定镜像（默认 agework/worker:latest）
    // 4. 确定 mount 路径（workspace.locator -> /workspace）
  }

  async start(prepared: PreparedRun): Promise<RuntimeHandle> {
    // docker run \
    //   -v <hostPath>:/workspace \
    //   -e RUNTIME_TRANSPORT=http \
    //   -e PLATFORM_API_BASE=<api-base-url> \
    //   -e AGEWORK_RUNTIME_TOKEN=<token> \
    //   -e AGEWORK_RUN_ID=<runId> \
    //   agework/worker:latest
  }

  async sendControl(handle: RuntimeHandle, control: ControlPayload): Promise<void> {
    // 写入内存 control queue（供 pollControls 读取）
    // 或写入数据库 control 表
  }

  async cancel(handle: RuntimeHandle): Promise<void> {
    // docker stop <containerId>
  }

  async cleanup(handle: RuntimeHandle): Promise<void> {
    // docker rm <containerId>
  }
}
```

### 容器镜像构建

- `apps/worker/Dockerfile`：基于 Node.js slim，COPY worker 源码，安装依赖
- 构建：`docker build -t agework/worker:latest apps/worker`
- CI/CD 中推送到 registry

## 4. RuntimeProviderRegistry

API 侧新增 provider 注册表，根据配置选择 provider：

```ts
// apps/api/src/runs/runtime-provider-registry.service.ts
@Injectable()
export class RuntimeProviderRegistry {
  constructor(
    private readonly localProvider: LocalProcessProvider,
    private readonly dockerProvider: DockerProvider,
  ) {}

  resolve(providerType: "local" | "docker"): RuntimeProvider {
    switch (providerType) {
      case "local": return this.localProvider;
      case "docker": return this.dockerProvider;
      default: throw new Error(`Unknown provider: ${providerType}`);
    }
  }
}
```

provider 选择策略（后续可配置）：
- 开发环境：默认 `local`
- 生产环境：默认 `docker`
- 按 workspace locatorType 决定：`local_path` → `local`，`managed_path` → `docker`

## 5. API 重启恢复

Phase 3 的孤儿恢复只处理 `LocalProcessProvider`（标记 error）。Phase 4 对 `DockerProvider`：

1. 查询所有 `status` 为 `running`/`requires_action`/`cancelling` 且 `providerType = "docker"` 的 Run
2. 对每个 Run，通过 `runtimeId`（container id）查询 Docker API：
   - container 仍在运行 → 重新绑定 handle，恢复 event 接收
   - container 不存在 → 标记 `error`，reason = `runtime_lost`
3. 从 `RunEvent` inbox 读取未处理的 event，重新 publish

## 6. 心跳与超时

沿用 Phase 3 的心跳机制：
- worker 每 5 秒发 heartbeat
- API 每 5 秒检查，超过 60 秒无心跳 → 标记 error + cleanup

Docker 场景下额外：
- `docker stop` 默认 10 秒 grace period，超时强制 kill
- cancel 时先 `docker stop`，超时后 `docker kill`

## 7. 安全

- runtime token 只能访问自己的 run（JWT claim 校验）
- internal API 不暴露给公网（通过 nginx/ingress 限制）
- Docker mount 只挂 workspace，不挂宿主 HOME、env、数据库凭据
- `apiKey` 在 RunConfig 中用 `SecretRef` 或环境变量注入，不落盘
- trace 日志脱敏

## 8. 分阶段实现

### Task 1: internal runtime API + runtime token
- 新增 `RuntimeController`（internal API）
- 新增 runtime token 生成/校验
- Prisma 新增 `RunEvent` 表

### Task 2: HttpTransport
- `apps/worker/src/http-transport.ts`
- worker 入口根据 `RUNTIME_TRANSPORT` 选择 transport

### Task 3: DockerProvider
- `apps/api/src/runs/docker-provider.service.ts`
- `apps/worker/Dockerfile`
- `docker run` / `docker stop` / `docker rm` 封装

### Task 4: RuntimeProviderRegistry + provider 选择
- 注册表实现
- 配置化 provider 选择

### Task 5: API 重启恢复（Docker Run）
- container 存活检测
- 重新绑定 handle
- RunEvent inbox 重放

### Task 6: 测试
- DockerProvider 单元测试（mock docker API）
- HttpTransport 单元测试（mock HTTP）
- runtime token 校验测试
- 端到端 Docker 测试（需 Docker 环境）

## 9. 验证方式

- `pnpm typecheck` / `pnpm build` / `pnpm test:api` 全部通过
- Docker 环境可用时：`docker build` 成功，`docker run` 能启动 worker
- 手动测试：
  1. 配置 provider 为 docker
  2. 发消息 → worker 在 Docker 内运行 → 流式返回正常
  3. stop → docker container 被停止
  4. API 重启 → 正在运行的 Docker Run 被恢复
  5. 心跳超时 → container 被 kill，Run 标记 error

## 10. 沙箱方案对比：Docker / OpenSandbox / CubeSandbox

Phase 4 的 `RuntimeProvider` 抽象允许接入不同的执行后端。除了自建 `DockerProvider`，还有两个成熟的开源沙箱平台值得评估：

### 方案对比

| 维度 | **Docker（自建）** | **OpenSandbox** | **CubeSandbox** |
|------|-------------------|-----------------|-----------------|
| **维护方** | 自建 | 阿里云 / CNCF Landscape | 腾讯云 / CNCF Landscape |
| **隔离级别** | 容器级（namespace + cgroup，共享宿主内核） | 可选：gVisor / Kata / Firecracker（内核级） | 硬件级（KVM MicroVM，独立 Guest 内核） |
| **启动延迟** | ~500ms-1s（冷启动） | ~200-500ms（Docker）/ 更快（K8s snapshot） | **<60ms**（资源池 + snapshot clone） |
| **单实例内存开销** | ~50-100MB | 中等（取决于 runtime） | **<5MB**（CoW 内存复用） |
| **并发密度** | ~10-50/节点 | 中-高（K8s 调度） | **数千/节点** |
| **网络隔离** | 手动配置 Docker network | Ingress Gateway + per-sandbox egress | eBPF CubeVS（内核级隔离 + 细粒度 egress 过滤） |
| **自部署** | ✅ 原生 Docker | ✅ Docker 或 K8s | ✅ 需要 KVM（x86_64 Linux） |
| **SDK** | 自建（HttpTransport） | 6 语言 SDK（Python/JS/Go/Java/C#/Kotlin） | E2B SDK 兼容（换一个 env var 即可） |
| **状态管理** | 无（需自建） | 无原生 | ✅ snapshot / clone / rollback（毫秒级） |
| **浏览器/桌面** | 需自建 | ✅ 内置 Chrome VNC / code-server | ❌（聚焦代码执行） |
| **License** | — | Apache 2.0 | Apache 2.0 |
| **成熟度** | 最成熟（Docker 生态） | CNCF Landscape，活跃开发 | CNCF Landscape，6.3k stars，v0.3.1 |

### OpenSandbox 特点

- **通用沙箱平台**：面向 Coding Agent、GUI Agent、评估基准、RL 训练等多种场景
- **双运行时**：Docker runtime（开发/轻量）+ 自研 K8s runtime（企业级分布式调度）
- **强隔离可选**：支持 gVisor / Kata / Firecracker，按需选择隔离强度
- **内置环境**：Code Interpreter、Chrome VNC/DevTools、VS Code Web
- **已对接主流 Coding CLI**：Claude Code、Gemini CLI、OpenAI Codex CLI 等
- **npm 包**：`@alibaba-group/opensandbox`

### CubeSandbox 特点

- **MicroVM 架构**：基于 RustVMM + KVM，每个 sandbox 有独立 Guest OS 内核
- **极致性能**：冷启动 <60ms，P99 137ms；内存开销 <5MB/实例
- **高密度部署**：CoW 内存复用 + 内核共享，单节点可运行数千实例
- **eBPF 网络安全**：CubeVS 在内核级实现严格 inter-sandbox 隔离 + egress 过滤
- **状态快照**：CubeCoW 引擎支持 event 级快照、即时克隆、rollback
- **E2B 兼容**：改一个 URL 即可从 E2B 迁移
- **硬件要求**：需要 x86_64 Linux + KVM 支持（macOS 无法直接运行）

### 对 AgeWork 的建议

**Phase 4a（本期）**：自建 `DockerProvider` — 最简单、最成熟、macOS 可用、不引入外部依赖。Docker 是 Phase 4 的基线实现。

**Phase 4b（后续可选）**：接入 OpenSandbox — 如果需要以下能力：
- GUI Agent / 浏览器自动化（内置 Chrome VNC）
- gVisor/Kata/Firecracker 强隔离（多租户服务器）
- Code Interpreter 内置环境

**Phase 4c（后续可选）**：接入 CubeSandbox — 如果需要以下能力：
- 极致启动速度和密度（AI agent 高频创建/销毁场景）
- 硬件级隔离（最高安全要求）
- 状态快照/rollback（agent 状态保存和恢复）
- 已有 E2B 集成想迁移

三个方案不互斥——`RuntimeProviderRegistry` 可以根据 workspace 策略选择不同 provider：
- 开发环境 → `LocalProcessProvider`
- 通用生产 → `DockerProvider`
- 高安全租户 → `OpenSandboxProvider`（gVisor/Kata）或 `CubeSandboxProvider`（MicroVM）
