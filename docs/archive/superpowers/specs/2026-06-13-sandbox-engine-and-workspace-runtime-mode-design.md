# SandboxEngine 抽取 与 Workspace 级 runtimeMode 设计

> 取代/修订：`docs/superpowers/specs/2026-06-13-sandbox-runtime-provider-backend-design.md`
> 相关：
> - `docs/superpowers/specs/2026-06-13-runtime-isolation-scope-design.md`（隔离粒度，**已实现**）
> - `docs/superpowers/specs/2026-06-12-docker-persistent-container-design.md`
> - `docs/superpowers/specs/2026-06-12-opensandbox-provider-design.md`

## 背景与目标

当前 `apps/api/src/runtime/` 已有完整可运行的基础设施：`RuntimeProviderRegistry` 注册了
`local` / `docker` / `opensandbox` 三个 provider；`RUNTIME_ISOLATION_SCOPE`、`RuntimePlacementService`、
`RuntimeBinding`、持久容器/worker 复用、孤儿恢复均已落地。

本设计要做两件事：

- **A. SandboxEngine 抽取**：`DockerRuntimeProvider`（529 行）与 `OpenSandboxRuntimeProvider`（611 行）
  的编排逻辑大量重复，真正不同的只是底层基础设施操作。把它们收敛成
  「`SandboxRuntimeProvider`（编排）+ `SandboxEngine`（底层适配）」。
- **B. runtime 选择下放到 workspace**：runtime 不再由服务级 `RUNTIME_PROVIDER` env 决定，而是
  每个 workspace 在创建时选 `local | sandbox`，一个服务实例可同时跑 local 和 sandbox workspace。

两步独立，**A 先做（纯内部重构、行为不变），B 随后**。

### 与既有文档的差异（本文档为准）

- 旧文档把底层适配层叫 `SandboxBackend` / `backendType` / `SANDBOX_BACKEND`，
  本文档统一改名为 **`SandboxEngine` / `sandboxEngine` / `SANDBOX_ENGINE`**。
- 旧文档让 `SandboxRuntimeProvider` 每次 run 读 live `SANDBOX_BACKEND`；
  本文档改为**在创建 workspace 时把 `SANDBOX_ENGINE` 快照进 `workspace.sandboxEngine`**，
  之后该 workspace 固定使用此 engine，改配置只影响新建 workspace。
- 旧文档 Phase 5「引入 isolation scope」与对 `WorkspaceRuntimeBinding` 的引用**已过时**：
  `RUNTIME_ISOLATION_SCOPE` 与 `RuntimeBinding` 都已实现，本文档不再包含该阶段。

## 核心概念与分层

```text
RuntimeProvider                       # AgeWork 应用层 port，面向 RuntimeRunner
  ├── LocalRuntimeProvider            # runtimeMode = local，fork 进程
  └── SandboxRuntimeProvider          # runtimeMode = sandbox，编排（register RunConfig、
        │                             #   access key、control queue、heartbeat、cancel、
        │                             #   cleanup、orphan recovery）
        └── SandboxEngine             # 底层基础设施适配，按 workspace.sandboxEngine 选
              ├── DockerSandboxEngine
              ├── OpenSandboxEngine
              ├── KubernetesSandboxEngine   # 未来
              └── VmSandboxEngine           # 未来
  └── RemoteRuntimeProvider           # 未来，不在本设计范围
```

责任边界：

```text
RuntimeProvider / SandboxRuntimeProvider 关心：
  run 属于谁、状态、取消、续会话、给前端发事件、access key、control queue
SandboxEngine 关心：
  运行环境怎么创建、怎么挂载 workspace、怎么启动 worker、怎么停止、怎么恢复孤儿
```

`SandboxEngine` **不理解** `RunConfig` / `ControlPayload` / `conversationId` / 模型配置，
也不负责 run 落库。

## 用户语义 vs 部署配置

```text
用户感知（产品语义，per-workspace，创建后不可变）：
  runtimeMode = local | sandbox            # future: remote

部署方配置（服务级，用户不可见）：
  SANDBOX_ENGINE             = docker | opensandbox   # 新建 sandbox workspace 的默认引擎
  RUNTIME_ISOLATION_SCOPE    = user | workspace       # 仅 sandbox 生效（已实现）
  WORKSPACE_RUNTIME_ALLOWED_MODES = local,sandbox     # B 阶段引入，限制可选模式
```

- 用户只选 `local | sandbox`，**不选** 底层 `docker | opensandbox`（engine 对用户透明）。
- 桌面/本地优先部署：`allowed=local,sandbox`，多数 workspace 用 local，个别开 sandbox。
- 服务器/SaaS 部署：`allowed=sandbox`，禁止 local，所有代码只在受控沙箱执行。

## 数据模型

### Workspace（B 阶段）

```prisma
model Workspace {
  id            String  @id @default(cuid())
  runtimeMode   String  @default("local")   // local | sandbox; future: remote，创建后不可变
  sandboxEngine String?                      // docker | opensandbox；仅 sandbox 时有值，
                                             //   创建时快照自 SANDBOX_ENGINE，之后固定
  // ...
}
```

- 现有字段 `defaultRuntimeType String?`（`schema.prisma:55`）目前是死字段（provider 解析不读它）。
  B 阶段用 `runtimeMode` 取代它并真正启用；开发阶段清库重建，无迁移成本。
- `local` workspace：`sandboxEngine` 为空，不创建持久 runtime binding。

### RuntimeBinding（复用现有，无需新增表）

现有 `RuntimeBinding`（`schema.prisma:143-165`）已含
`runtimeType / isolationScope / scopeId / userId / workspaceId? / runtimeResourceId / status / expiresAt / metadata`。

- A 阶段：sandbox workspace 的 binding `runtimeType` 写 `"sandbox"`；
  底层 engine 记在 `metadata.sandboxEngine`（或复用现有字段，实现时确认），供审计/恢复区分 docker/opensandbox。
- 不新增表。

### Run（不变）

`Run.runtimeType` / `Run.runtimeResourceId`（`schema.prisma:125-126`）继续记录运行事实。
A 之后 `Run.runtimeType` 对 sandbox workspace 记 `"sandbox"`。

## SandboxEngine 接口（A 阶段）

```ts
export type SandboxEngineType = "docker" | "opensandbox"; // future: kubernetes | vm

export type SandboxPlacement = {
  scope: "user" | "workspace";
  scopeId: string;
  workspaceId: string;
  workspaceHostPath: string;   // 宿主机路径
  workspaceMountPath: string;  // 容器/沙箱内挂载点
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
  engineType: SandboxEngineType;
  runtimeResourceId: string;   // containerId / sandboxId / ...
  workspaceMountPath: string;
};

export interface SandboxEngine {
  readonly type: SandboxEngineType;
  getOrCreate(input: SandboxStartInput): Promise<SandboxRuntime>;
  startWorker(runtime: SandboxRuntime, input: SandboxStartInput): Promise<void>;
  stop(runtimeResourceId: string): Promise<void>;
  recoverOrphan(runtimeResourceId: string): Promise<void>;
  isHealthy?(runtimeResourceId: string): Promise<boolean>;
}
```

`DockerSandboxEngine` 从 `DockerRuntimeProvider` 搬出 `docker run/stop/kill/recover`；
`OpenSandboxEngine` 从 `OpenSandboxRuntimeProvider` 搬出 `OpenSandboxClient` 创建/连接/删除/启动 worker。

## SandboxRuntimeProvider（A 阶段）

实现现有 `RuntimeProvider` 接口，`type = "sandbox"`，复用两个旧 provider 的共有编排：

```ts
start(runConfig, placement, onRuntimeResourceIdReady) {
  // 1. 用现有 RuntimePlacementService 结果计算 SandboxPlacement
  // 2. 签发 scope/workspace 级 access key（复用现有 RuntimeInternalAccessService）
  // 3. register RunConfig（复用现有 RuntimeConfigStore）
  // 4. engine = selectEngine(...)  // A: 读 SANDBOX_ENGINE；B: 读 workspace.sandboxEngine
  // 5. engine.getOrCreate(...) -> engine.startWorker(...)
  // 6. push user_message control（复用现有 RuntimeControlQueue）
  // 7. 返回 RuntimeHandle（runtimeType = "sandbox"）
}
cancel(handle)        // 只发 cancel control，不销毁 sandbox
cleanup(runId)        // 只清 per-run 状态，保留 sandbox
recoverOrphan(id)     // 委托 engine.recoverOrphan
```

engine 选择来源：
- **A 阶段**：读服务级 `SANDBOX_ENGINE`（保持行为不变，单 engine）。
- **B 阶段**：读 `workspace.sandboxEngine`（创建时快照值）。

## RuntimePlacementService 的改动（B 阶段，关键且收口）

整条 run 路径的 provider 解析都走 `placement.runtimeType`（`runtime-runner.ts:44,69`），
而 placement 只有**一处**读服务级 env（`runtime-placement.service.ts:32`，
`getDefaultRuntimeProviderType()`）。B 的核心路由改动就是这一处：

```text
A 阶段：runtimeType 来自 SANDBOX_ENGINE 映射后的 "sandbox" / 服务级 RUNTIME_PROVIDER（保持现状）
B 阶段：runtimeType = workspace.runtimeMode（local | sandbox）
        SandboxRuntimeProvider 内部再按 workspace.sandboxEngine 选 engine
```

`resolveForRun(...)` 入参增加 workspace 的 `runtimeMode` / `sandboxEngine`（由调用方
`AgentRunHandler` 从 conversation 所属 workspace 读出后传入）。local/sandbox 的 runtimePath
分支逻辑（local 直用宿主机路径；sandbox user 隔离 `/workspaces/<rel>`；sandbox workspace 隔离
`/workspace`）已存在于 `runtime-placement.service.ts`，按 `runtimeMode` 复用即可。

## 内部 endpoint / heartbeat provider 解析（B 阶段）

`runtime-workspace.controller.ts` 与 `runtime-runtime.controller.ts` 的 heartbeat 当前按服务级 env
解析 provider（`configService.getDefaultRuntimeProviderType()`）。B 阶段改为：这两个 controller
手里有 `workspaceId` / `runtimeBindingId`，据此反查 binding/workspace 的 `runtimeMode`，
解析到 `"sandbox"` provider。A 阶段因为 registry 里只剩 `local` + `sandbox`，这里解析目标天然简化。

## Workspace / User 生命周期清理（复用现有）

`RuntimeLifecycleService`（`runtime-lifecycle.service.ts`）已实现按 binding 的 `userId/workspaceId`
归属关闭 runtime，且不依赖 isolationScope 判断。本设计无需改动其逻辑：
- 删 workspace：`shutdownForWorkspace(workspaceId)` 关闭专属该 workspace 的 binding（user 级共享资源不动）。
- 删/禁用 user：`shutdownForUser(userId)` 关闭该用户全部 binding。
- A 之后 `shutdownContainer?.()` 经 `SandboxRuntimeProvider` 委托给对应 engine。

## 配置项

```text
# 新建 sandbox workspace 的默认引擎（仅创建时快照，不影响已有 workspace）
SANDBOX_ENGINE=docker            # docker | opensandbox

# 隔离粒度（已实现，仅 sandbox 生效）
RUNTIME_ISOLATION_SCOPE=user     # user | workspace

# B 阶段引入：限制 workspace 可选运行模式
WORKSPACE_RUNTIME_ALLOWED_MODES=local,sandbox
```

- A 阶段：保留现有 `RUNTIME_PROVIDER` 读取以不破坏现状；新增 `SANDBOX_ENGINE`，
  当 `RUNTIME_PROVIDER` 为 docker/opensandbox 时映射到对应 engine（过渡兼容，开发阶段也可直接切）。
- B 阶段：`RUNTIME_PROVIDER` 作为运行时决策入口被移除，运行时模式由 `workspace.runtimeMode` 决定；
  `ConfigService.getDefaultRuntimeProviderType()` 不再用于 run 路径决策。

## 实施阶段

### 阶段 A — SandboxEngine 抽取（行为不变）

目标：不改变任何对外行为与现有测试预期，仅重构 provider 内部结构。

文件改动（`apps/api/src/runtime/`）：
- 新增 `providers/sandbox-engine.ts`（接口 + 类型）。
- 新增 `providers/docker-sandbox-engine.ts`：从 `docker-runtime-provider.ts` 搬出基础设施操作。
- 新增 `providers/opensandbox-sandbox-engine.ts`：从 `opensandbox-runtime-provider.ts` 搬出。
- 新增 `providers/sandbox-runtime-provider.ts`（`type = "sandbox"`），收敛共有编排。
- `providers/runtime-provider-registry.ts`：注册 `LocalRuntimeProvider` + `SandboxRuntimeProvider`；
  移除 docker/opensandbox 两个 provider 的直接注册。
- `runtime.module.ts`：装配新 provider 与两个 engine（DI）。
- `runtime-placement.service.ts`：A 阶段把 docker/opensandbox 映射为 `runtimeType="sandbox"`。
- 测试：旧 provider spec 迁移为 `sandbox-runtime-provider.spec.ts` + 各 engine spec。

验收：
- `local` 行为不变。
- docker engine 行为与原 `DockerRuntimeProvider` 一致：持久 runtime、control queue、heartbeat、
  cancel、cleanup、orphan recovery 全部通过迁移后的测试。
- opensandbox engine 行为与原 `OpenSandboxRuntimeProvider` 一致：复用 persisted binding、
  启动常驻 worker、删除 sandbox、recover orphan 通过测试。
- `SandboxRuntimeProvider` 单测覆盖：首 run 建 sandbox / 同 scope 复用 / 启动中 cancel /
  cleanup 不销毁 sandbox / heartbeat timeout 关闭 sandbox 并给 active runs 报错 /
  engine 创建失败清理 access+control+config 状态。
- docker/opensandbox 字样只出现在 engine 层，不再散落在编排代码里。

### 阶段 B — Workspace 级 runtimeMode

文件改动：
- `apps/api/prisma/schema.prisma`：`Workspace` 增 `runtimeMode` + `sandboxEngine`，弃用 `defaultRuntimeType`。
- `config.service.ts`：新增 `getSandboxEngine()`、`getAllowedRuntimeModes()`；
  run 路径不再用 `getDefaultRuntimeProviderType()`。
- workspace 创建（`workspaces/` service + DTO）：
  - 接收 `runtimeMode`；`allowed` 仅一种时可省略并取唯一值，多种时必须显式传。
  - 校验 `runtimeMode ∈ WORKSPACE_RUNTIME_ALLOWED_MODES`。
  - `runtimeMode=sandbox` 时把当前 `SANDBOX_ENGINE` 快照进 `workspace.sandboxEngine`。
  - `runtimeMode` 创建后不可变（update 不允许改）。
- `agent/agent-run-handler.ts`：从 conversation 所属 workspace 读 `runtimeMode` / `sandboxEngine`，传入 placement。
- `runtime-placement.service.ts`：`resolveForRun` 用 workspace 的 `runtimeMode` 决定 runtimeType。
- `sandbox-runtime-provider.ts`：按 `workspace.sandboxEngine` 选 engine。
- `runtime-workspace.controller.ts` / `runtime-runtime.controller.ts`：heartbeat 按 binding/workspace 解析 provider。
- 前端 `apps/web`：创建 workspace 表单增加 `local | sandbox` 选择（仅展示 allowed modes）。

验收：
- 同一服务实例可同时创建 local workspace 与 sandbox workspace，并分别运行 agent。
- 单个 workspace 的每次 run 始终用该 workspace 的 `runtimeMode` 与 `sandboxEngine`。
- `allowed` 多种时创建必须显式传 `runtimeMode`；仅一种时可省略。
- `runtimeMode` 创建后不可变（尝试修改被拒）。
- 改 `SANDBOX_ENGINE` 只影响新建 sandbox workspace，已有 workspace 仍用其快照 engine。

## 已知边界（先记录，暂不处理）

- **user 级隔离下 engine 一致性**：user 级下同一用户多 sandbox workspace 共享一个 sandbox
  （scopeId=userId）。若部署方在该用户两个 sandbox workspace 创建之间改了 `SANDBOX_ENGINE`，
  会出现「两个 workspace 快照了不同 engine 但又要共享一个 sandbox」的冲突。
  现实中 `SANDBOX_ENGINE` 极少中途更改，开发阶段不处理。
  约定：user 级下 engine 以该用户首个 sandbox workspace 为准；换 engine 需先 drain 该用户 sandbox。
  workspace 级隔离无此问题。

## 非目标

- 不做能力检测（Docker daemon / OpenSandbox server 可用性探测与 UI 置灰）；v1 选了 sandbox
  但 engine 不可用则在 run 时明确报错。后续可补 `RuntimeCapabilityService`。
- 不支持 `runtimeMode` 创建后切换（无迁移状态机）。
- 不做 conversation 级 / run 级 sandbox。
- 不让用户选择底层 `docker | opensandbox` engine。
- 不实现 remote workspace，仅预留 `runtimeMode` 扩展位。
- 不改 worker `HttpTransport` 协议、AG-UI 聚合、assistant-ui 持久化、模型 provider/API key 逻辑。
- 不改 `RUNTIME_ISOLATION_SCOPE` 既有语义。

## Validation（轻量）

```bash
pnpm --filter api typecheck
pnpm --filter api test sandbox-runtime-provider
pnpm --filter api test docker-sandbox-engine
pnpm --filter api test opensandbox-sandbox-engine
pnpm --filter api test runtime-placement
```

Manual smoke（B 阶段）：
- `WORKSPACE_RUNTIME_ALLOWED_MODES=local,sandbox`，`SANDBOX_ENGINE=docker`。
- 建一个 local workspace 跑 agent；建一个 sandbox workspace 跑 agent；两者并存互不影响。
- 删除 sandbox workspace，对应 runtime 被关闭；local workspace 不受影响。
