# Runtime 隔离粒度实施计划

> **For agentic workers:** 按 task 顺序逐项实施；每个 task 只改列出的文件范围。不要自动 build、lint 或自动打开浏览器测试；必要时只运行相关 typecheck / 单测。

**Goal:** 在保持 `RUNTIME_PROVIDER=local|docker|opensandbox` 服务级选择的前提下，引入 `RUNTIME_ISOLATION_SCOPE=user|workspace`。默认服务器部署走 user 级 runtime 以降低资源成本，同时保留 workspace 级强隔离能力。

**Architecture:** 上层 `Workspace / Conversation / Run` 不直接选择 runtime provider 或 isolation scope。新增 `RuntimePlacementService` 统一根据服务配置和业务上下文产出 placement：`runtimeType + isolationScope + scopeId + runtimePath`。Provider 只根据 placement 创建/复用底层 sandbox/container。`Run.runtimeType` / `Run.runtimeResourceId` 继续记录运行事实。

**Tech Stack:** NestJS 11、Prisma、Vitest、DockerProvider、OpenSandboxProvider、现有 `apps/worker` + HTTP transport。

**设计来源:** `docs/superpowers/specs/2026-06-13-runtime-isolation-scope-design.md`

**当前代码事实:**
- 当前已支持多个 provider 聚合：`RuntimeProviderRegistry`。
- 当前产品策略已收敛为服务级 runtime provider：`ConfigService.getDefaultRuntimeProviderType()`。
- 当前仍存在 workspace 级 runtime resource 语义：`WorkspaceRuntimeBinding`、workspace control queue、workspace heartbeat endpoint。
- 当前 Docker/OpenSandbox provider 都更接近 workspace 级 persistent worker 模型。
- 目标不是删除多 provider 能力，而是把“选择来源”收口到服务配置和 placement service。

---

## File Structure

**配置 / Placement**
- `apps/api/src/config/config.service.ts` — 新增 `getRuntimeIsolationScope()`。
- `apps/api/src/runtime/core/runtime-placement.service.ts` — 新增：根据 user/workspace 解析 placement。
- `apps/api/src/runtime/core/runtime-placement.service.spec.ts` — 新增测试。
- `packages/shared/src/protocol/transport.ts` — 如需要，新增 `RuntimePlacement` 类型或 provider start 参数类型。

**Prisma / Binding**
- `apps/api/prisma/schema.prisma` — 新增 `RuntimeBinding`；后续删除或废弃 `WorkspaceRuntimeBinding`。
- `apps/api/src/runtime/core/runtime-binding.service.ts` — 新增：`runtimeType + isolationScope + scopeId -> runtimeResourceId`。
- `apps/api/src/runtime/core/runtime-binding.service.spec.ts` — 新增测试。
- `apps/api/src/runtime/runtime.module.ts` — 注册新 service。

**Run / Runner**
- `apps/api/src/agent/agent-run-handler.ts` — 调用 placement service，不直接拼 runtimeType。
- `apps/api/src/agent/agent-run-config-builder.ts` — 接收 placement runtimePath。
- `apps/api/src/runtime/core/runtime-runner.ts` — `start()` 接收 placement 并传给 provider。
- 对应 `.spec.ts`。

**Provider**
- `apps/api/src/runtime/providers/docker-runtime-provider.ts` — 支持 user/workspace scope。
- `apps/api/src/runtime/providers/opensandbox-runtime-provider.ts` — 支持 user/workspace scope。
- `apps/api/src/runtime/providers/runtime-provider-registry.ts` — 保持 provider 解析，不加入业务策略。
- 对应 `.spec.ts`。

**Internal runtime**
- `apps/api/src/runtime/internal/runtime-workspace.controller.ts` — 过渡期保留。
- `apps/api/src/runtime/internal/runtime-runtime.controller.ts` — 新增 runtime binding 级 controls / heartbeat。
- `apps/api/src/runtime/internal/runtime-control-queue.ts` — 从 workspaceId 分区泛化到 runtimeBindingId 分区。
- `apps/api/src/runtime/internal/runtime-internal-auth.guard.ts` — 支持 runtimeBindingId access key。
- 对应 `.spec.ts`。

**Worker**
- `apps/worker/src/main.ts` — 支持 runtime binding 级 polling。
- `apps/worker/src/persistent-http-client.ts` — 从 workspace endpoint 迁移到 runtime endpoint。
- 对应 `.spec.ts`。

**Workspace lifecycle / Recovery**
- `apps/api/src/workspaces/workspace.service.ts` — workspace 删除时按 isolation scope 清理：workspace scope 删除 runtime；user scope 只清 workspace 数据。
- `apps/api/src/runtime/core/run-recovery.service.ts` — 按 `Run.runtimeType` / binding 恢复或清理。
- 对应 `.spec.ts`。

---

## Phase 0 — 决策边界落地（doc/code 对齐）

### Task 0.1: 确认服务级 runtime provider 语义

**Files:**
- `apps/api/src/config/config.service.ts`
- `apps/api/.env.example`
- `README.md`
- Existing tests if present

- [ ] 确认 `RUNTIME_PROVIDER` 只来自服务环境变量。
- [ ] 确认 workspace create/update API 不接收 runtime provider override。
- [ ] 确认 `AgentRunHandler` 不读取 workspace runtime 字段。
- [ ] 文档确认“一个 AgeWork 服务实例只启用一种 runtime provider”。

**Exit Criteria:**
- 业务层没有 workspace/provider 选择入口。
- `Run.runtimeType` 只作为运行事实记录。

### Task 0.2: 新增 isolation scope 配置读取

**Files:**
- `apps/api/src/config/config.service.ts`
- `apps/api/.env.example`
- `README.md`
- `apps/api/src/config/config.service.spec.ts`（如存在）

- [ ] 新增：

```ts
type RuntimeIsolationScope = "user" | "workspace";

getRuntimeIsolationScope(): RuntimeIsolationScope
```

- [ ] 默认值：

```text
RUNTIME_ISOLATION_SCOPE=user
```

- [ ] 非法值 fail fast，不静默 fallback：

```text
RUNTIME_ISOLATION_SCOPE expects "user" or "workspace"
```

- [ ] `.env.example` 增加说明：

```text
# Runtime 隔离粒度，可选 user / workspace，默认 user
# RUNTIME_ISOLATION_SCOPE=user
```

**Exit Criteria:**
- 配置层能稳定返回 `user|workspace`。
- 当前未使用该配置时，不改变现有运行行为。

---

## Phase 1 — RuntimePlacementService

### Task 1.1: 定义 RuntimePlacement

**Files:**
- `packages/shared/src/protocol/transport.ts` 或 `apps/api/src/runtime/core/runtime-placement.ts`

- [ ] 定义：

```ts
export type RuntimeIsolationScope = "user" | "workspace";

export type RuntimePlacement = {
  runtimeType: string;
  isolationScope: RuntimeIsolationScope;
  scopeId: string;
  userId: string;
  workspaceId: string;
  hostPath: string;
  runtimePath: string;
};
```

**Notes:**
- 如果 placement 只在 API 内部使用，先放 `apps/api/src/runtime/core/`。
- 如果 provider interface 在 shared package 中定义且需要 placement 参数，再放 shared。

### Task 1.2: 实现 placement 解析

**Files:**
- Add: `apps/api/src/runtime/core/runtime-placement.service.ts`
- Add: `apps/api/src/runtime/core/runtime-placement.service.spec.ts`
- Modify: `apps/api/src/runtime/runtime.module.ts`

- [ ] service 输入：

```ts
resolveForRun({
  userId,
  workspaceId,
  workspaceRootPath,
  userWorkspaceRootPath,
}): RuntimePlacement
```

- [ ] `RUNTIME_ISOLATION_SCOPE=user`：

```text
scopeId = userId
hostPath = userWorkspaceRootPath
runtimePath = /workspaces/{workspaceRelativePath}
```

- [ ] `RUNTIME_ISOLATION_SCOPE=workspace`：

```text
scopeId = workspaceId
hostPath = workspaceRootPath
runtimePath = /workspace
```

- [ ] 校验：
  - `workspaceRootPath` 必须在 `userWorkspaceRootPath` 内。
  - relative path 不能包含 `..`。
  - 传给 provider 的 host mount path 必须是绝对路径。

**Exit Criteria:**
- user scope 下，一个用户多个 workspace 解析到同一个 `scopeId=userId`，但不同 `runtimePath`。
- workspace scope 下，不同 workspace 解析到不同 `scopeId=workspaceId`。

### Task 1.3: AgentRunHandler 使用 placement

**Files:**
- Modify: `apps/api/src/agent/agent-run-handler.ts`
- Modify: `apps/api/src/agent/agent-run-handler.spec.ts`
- Modify: `apps/api/src/agent/agent-run-config-builder.ts`
- Modify: `apps/api/src/agent/agent-run-config-builder.spec.ts`

- [ ] `AgentRunHandler` 获取 workspace 信息后调用 `RuntimePlacementService.resolveForRun()`。
- [ ] `runConfigBuilder.buildRunConfig()` 使用 `placement.runtimePath`，不直接用 workspace root path。
- [ ] `RuntimeRunner.start()` 参数新增 `placement`。
- [ ] 测试覆盖：
  - service-level runtime provider 被传给 runner。
  - user scope 下 runConfig.runtimePath 是 workspace 子目录。
  - workspace scope 下 runConfig.runtimePath 是 `/workspace`。

**Exit Criteria:**
- 上层仍只关心 workspace/conversation/run。
- runtime path 的 provider 差异收口在 placement service。

---

## Phase 2 — RuntimeBinding 数据模型

### Task 2.1: 新增 RuntimeBinding

**Files:**
- Modify: `apps/api/prisma/schema.prisma`

- [ ] 新增：

```prisma
model RuntimeBinding {
  id                String    @id @default(cuid())
  runtimeType       String
  isolationScope    String
  scopeId           String
  runtimeResourceId String
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

- [ ] 暂不删除 `WorkspaceRuntimeBinding`，先并存一版，降低迁移风险。

**Exit Criteria:**
- Prisma generate 后类型可用。
- 旧 provider 仍可使用 `WorkspaceRuntimeBinding`，新 service 可使用 `RuntimeBinding`。

### Task 2.2: 新增 RuntimeBindingService

**Files:**
- Add: `apps/api/src/runtime/core/runtime-binding.service.ts`
- Add: `apps/api/src/runtime/core/runtime-binding.service.spec.ts`
- Modify: `apps/api/src/runtime/runtime.module.ts`

- [ ] 方法：

```ts
find(placement)
upsertRunning(placement, runtimeResourceId, metadata?)
markStopped(placement)
delete(placement)
deleteByScope(runtimeType, isolationScope, scopeId)
findActiveByScope(runtimeType, isolationScope, scopeId)
```

- [ ] 测试：
  - `runtimeType + isolationScope + scopeId` 唯一。
  - user 和 workspace scope 可以同时存在，不互相覆盖。
  - `markStopped` 幂等。

**Exit Criteria:**
- Provider 不直接拼 Prisma 查询条件。

### Task 2.3: 迁移 WorkspaceRuntimeBinding 读取路径

**Files:**
- Modify: `apps/api/src/runtime/providers/docker-runtime-provider.ts`
- Modify: `apps/api/src/runtime/providers/opensandbox-runtime-provider.ts`
- Modify tests

- [ ] 新 provider 逻辑优先查 `RuntimeBinding`。
- [ ] 过渡期可以 fallback 查 `WorkspaceRuntimeBinding`，并写入新的 `RuntimeBinding`。
- [ ] 确认 `Run.runtimeResourceId` 仍记录底层 resource id。

**Exit Criteria:**
- 新运行写入 `RuntimeBinding`。
- 旧 binding 不会导致运行失败。

---

## Phase 3 — Provider 支持 user/workspace scope

### Task 3.1: RuntimeProvider 接口接收 placement

**Files:**
- Modify: `packages/shared/src/protocol/transport.ts`
- Modify: `apps/api/src/runtime/core/runtime-runner.ts`
- Modify: provider implementations and specs

- [ ] 将 `RuntimeProvider.start()` 扩展为：

```ts
start(
  runConfig: RunConfig,
  placement: RuntimePlacement,
  onRuntimeResourceIdReady?: (runtimeResourceId: string) => void
): RuntimeHandle;
```

- [ ] `LocalRuntimeProvider` 可以忽略 placement，仅使用 `runConfig.runtimePath`。
- [ ] `DockerRuntimeProvider` / `OpenSandboxRuntimeProvider` 使用 placement 查 binding 和确定 mount。

**Exit Criteria:**
- Provider 不再自己推断 workspace/user scope。

### Task 3.2: DockerProvider 支持 user scope

**Files:**
- Modify: `apps/api/src/runtime/providers/docker-runtime-provider.ts`
- Modify: `apps/api/src/runtime/providers/docker-runtime-provider.spec.ts`

- [ ] state key 从 `workspaceId` 泛化为 `runtimeBindingId` 或 `placement.scopeKey`。
- [ ] user scope 容器命名：

```text
agework-user-{safeUserId}
```

- [ ] workspace scope 容器命名保留：

```text
agework-ws-{workspaceId}
```

- [ ] user scope 挂载用户 workspace root 到 `/workspaces`。
- [ ] workspace scope 挂载 workspace root 到 `/workspace`。
- [ ] `RunConfig.runtimePath` 已由 placement service 给出。

**Exit Criteria:**
- 同一用户不同 workspace 复用同一 Docker container。
- 不同用户不复用 container。
- workspace scope 行为保持兼容。

### Task 3.3: OpenSandboxProvider 支持 user scope

**Files:**
- Modify: `apps/api/src/runtime/providers/opensandbox-runtime-provider.ts`
- Modify: `apps/api/src/runtime/providers/opensandbox-runtime-provider.spec.ts`

- [ ] user scope 创建 sandbox 时挂载用户 workspace root。
- [ ] workspace scope 创建 sandbox 时挂载 workspace root。
- [ ] binding 使用 `RuntimeBindingService`。
- [ ] stale binding 检测按 placement 查。
- [ ] worker 启动 env 增加 runtime binding 信息：

```text
AGEWORK_RUNTIME_BINDING_ID=...
AGEWORK_RUNTIME_ISOLATION_SCOPE=user|workspace
```

**Exit Criteria:**
- 同一用户多个 workspace 可以共享同一 OpenSandbox sandbox。
- workspace scope 仍是每 workspace 一个 sandbox。

---

## Phase 4 — Internal API 泛化

### Task 4.1: 新增 runtime binding 级 endpoint

**Files:**
- Add: `apps/api/src/runtime/internal/runtime-runtime.controller.ts`
- Modify: `apps/api/src/runtime/runtime.module.ts`
- Add: `apps/api/src/runtime/internal/runtime-runtime.controller.spec.ts`

- [ ] 新增：

```text
GET  /internal/runtimes/:runtimeBindingId/controls?afterSeq=N
POST /internal/runtimes/:runtimeBindingId/heartbeat
```

- [ ] endpoint 用 runtime binding id 校验 access key。
- [ ] heartbeat 分发到服务级 provider：`RUNTIME_PROVIDER`。

**Exit Criteria:**
- runtime endpoint 与 workspace endpoint 并存。
- 新 provider/worker 可切到 runtime endpoint。

### Task 4.2: RuntimeControlQueue 泛化

**Files:**
- Modify: `apps/api/src/runtime/internal/runtime-control-queue.ts`
- Modify: tests

- [ ] 保留旧方法作为 wrapper：

```ts
pushForWorkspace(...)
pollByWorkspace(...)
cleanupWorkspace(...)
```

- [ ] 新增：

```ts
pushForRuntime(runtimeBindingId, envelope)
pollByRuntime(runtimeBindingId, afterSeq)
cleanupRuntime(runtimeBindingId)
```

- [ ] provider 新逻辑使用 runtime binding 分区。

**Exit Criteria:**
- user scope 下，一个 runtime queue 可承载多个 workspace 的 run。
- control payload 仍携带 `workspaceId`、`conversationId`、`runId`。

### Task 4.3: Worker 切到 runtime endpoint

**Files:**
- Modify: `apps/worker/src/persistent-http-client.ts`
- Modify: `apps/worker/src/main.ts`
- Modify tests

- [ ] worker 读取：

```text
AGEWORK_RUNTIME_BINDING_ID
AGEWORK_RUNTIME_ISOLATION_SCOPE
```

- [ ] 如果存在 runtime binding id，轮询 `/internal/runtimes/:id/controls`。
- [ ] 过渡期如果没有 binding id，继续走 `/internal/workspaces/:workspaceId/controls`。

**Exit Criteria:**
- 新 user scope worker 能处理同一 user sandbox 内多个 workspace 的 run。
- 旧 workspace worker 不断。

---

## Phase 5 — Lifecycle / Recovery / Cleanup

### Task 5.1: Workspace 删除语义

**Files:**
- Modify: `apps/api/src/workspaces/workspace.service.ts`
- Modify: `apps/api/src/workspaces/workspace.service.spec.ts`

- [ ] workspace scope：
  - 删除 workspace 时关闭并删除对应 runtime binding。
- [ ] user scope：
  - 删除 workspace 时不关闭 user runtime。
  - 清理该 workspace 目录和相关 conversations/runs。
  - 可向 user runtime 发送 cleanup control，停止该 workspace 下活跃进程。

**Exit Criteria:**
- user scope 不会因为删除一个 workspace 杀掉用户其他 workspace 的 run。

### Task 5.2: User 删除 / 禁用语义

**Files:**
- User service/controller if present
- Runtime binding service tests

- [ ] 用户删除或禁用时，关闭该用户 user scope runtime。
- [ ] workspace scope 下，关闭该用户所有 workspace runtime。

**Exit Criteria:**
- 用户生命周期可以清理 runtime 资源。

### Task 5.3: Recovery

**Files:**
- Modify: `apps/api/src/runtime/core/run-recovery.service.ts`
- Modify: tests

- [ ] 启动时扫描 active runs。
- [ ] 按 `run.runtimeType` resolve provider。
- [ ] 通过 `RuntimeBinding` 判断底层 runtime 是否仍可连接。
- [ ] user scope 下，不要因为一个 run orphan 就销毁整个 user runtime；只标记 run error。
- [ ] stale binding 标记 stopped。

**Exit Criteria:**
- API 重启后，user/workspace scope 都能恢复或安全清理。

---

## Phase 6 — Runtime Lifecycle Governance

### Task 6.1: Idle stop / pause

**Files:**
- Runtime workspace/controller services as appropriate
- Provider specs

- [ ] 新增配置：

```text
RUNTIME_IDLE_TIMEOUT_SECONDS=1800
```

- [ ] 每个 runtime binding 维护 lastHeartbeat / activeRuns。
- [ ] activeRuns 为 0 且超过 idle timeout 后 stop/pause。
- [ ] 下次 run 时 resume/recreate。

**Exit Criteria:**
- 停止后主要只占磁盘，不占 worker 内存。

---

## Phase 7 — UI / Admin 可见性

### Task 7.1: 管理页展示服务 runtime 策略

**Files:**
- `apps/web/src/pages/admin/...`
- Shared API if needed

- [ ] Admin 只读展示：

```text
Runtime Provider: opensandbox
Isolation Scope: user
Active Runtimes: N
```

- [ ] 不给普通 workspace 创建/编辑 UI 暴露 runtime 选择。

**Exit Criteria:**
- 运维可见当前策略，用户不被 runtime 细节干扰。

### Task 7.2: Runtime binding admin 列表

**Files:**
- API admin controller/service
- Web admin panel

- [ ] 展示 runtime bindings：
  - scope
  - scopeId
  - runtimeType
  - status
  - active runs
  - last heartbeat
- [ ] 提供 stop/restart 操作。

**Exit Criteria:**
- 管理员能处理卡住的 user/workspace runtime。

---

## Validation Plan

### Unit Tests

- `RuntimePlacementService`
  - user scope path mapping
  - workspace scope path mapping
  - unsafe path rejection
- `RuntimeBindingService`
  - upsert / markStopped / delete
  - user 与 workspace scope 不冲突
- Provider specs
  - user scope 复用同一 runtime
  - workspace scope 不同 workspace 不复用
- Internal controller specs
  - runtime binding endpoint controls / heartbeat
- Workspace lifecycle specs
  - user scope 删除 workspace 不杀 user runtime
  - workspace scope 删除 workspace 杀 workspace runtime

### Lightweight Commands

按任务范围运行：

```bash
pnpm --filter api typecheck
pnpm --filter api test runtime-placement
pnpm --filter api test runtime-binding
pnpm --filter api test runtime-workspace
```

不自动运行全量 build/lint，不自动打开浏览器。

### Manual Smoke

user scope：

```text
RUNTIME_PROVIDER=opensandbox
RUNTIME_ISOLATION_SCOPE=user
```

- 同一用户创建两个 workspace。
- 在 workspace A 发起 run，创建一个 sandbox。
- 在 workspace B 发起 run，复用同一个 sandbox，但 runtimePath 不同。
- 删除 workspace A，不影响 workspace B 的 run。

workspace scope：

```text
RUNTIME_PROVIDER=opensandbox
RUNTIME_ISOLATION_SCOPE=workspace
```

- 同一用户两个 workspace 分别创建两个 sandbox。
- 同一 workspace 多个 conversation 复用同一个 sandbox。
- 删除 workspace 时销毁对应 sandbox。

---

## Rollout Strategy

### Step 1: Hidden config

- 新增 `RUNTIME_ISOLATION_SCOPE`，默认 `user`。
- 不暴露 UI。
- provider 可以先只支持 workspace，配置保持 unused，确保兼容。

### Step 2: Workspace-compatible implementation

- 用 `RuntimePlacementService` 重写现有 workspace 级逻辑。
- 默认仍可先设 `workspace`，确认行为与现状一致。

### Step 3: Enable user scope for OpenSandbox

- 只对 OpenSandboxProvider 开启 user scope。
- DockerProvider 可随后补齐，或继续作为 local/debug fallback。

### Step 4: Default switch

- 服务器部署默认：

```text
RUNTIME_PROVIDER=opensandbox
RUNTIME_ISOLATION_SCOPE=user
```

- 高隔离部署文档推荐：

```text
RUNTIME_ISOLATION_SCOPE=workspace
```

---

## Risks

### User scope 中 workspace 间互相影响

风险：
- 端口冲突。
- 后台进程污染。
- 全局 cache/临时文件污染。

缓解：
- 每个 run 明确 `runtimePath`。
- 限制每 user runtime 并发 run。
- 未来为 workspace 注入独立 env prefix / port allocation。
- 高敏感部署使用 workspace scope。

### 凭证泄漏边界变粗

风险：
- user scope 下同一用户多个 workspace 共用 sandbox。

缓解：
- 不把真实 model API key 注入 sandbox 全局 env。
- 通过 AgeWork API 或 OpenSandbox Credential Vault 代理。
- workspace 级敏感凭证要求 workspace scope。

### Binding 迁移复杂

风险：
- `WorkspaceRuntimeBinding` 与 `RuntimeBinding` 并存期间逻辑混乱。

缓解：
- 新 service 统一读写。
- 旧表只做 fallback migration。
- 迁移完成后再删除旧表和旧 endpoint。

### Worker endpoint 双轨

风险：
- workspace endpoint 和 runtime endpoint 并存导致状态分叉。

缓解：
- provider 决定使用哪个 endpoint。
- worker 以 `AGEWORK_RUNTIME_BINDING_ID` 是否存在作为唯一分支。
- 切完 provider 后再移除旧 endpoint。

---

## Current Non-Goals

- 不做 conversation/run 级 sandbox。
- 不让普通用户或 workspace UI 选择 runtime provider。
- 不做按租户/套餐/风险动态选择 isolation scope。
- 不强行让 local provider 提供真实 workspace 隔离。
- 不在本阶段实现 runtime 数量配额，例如每用户活跃 runtime 数、每 runtime 并发 run 数；未来可作为管理员 runtime policy 能力。
- 不在本阶段实现内存或磁盘空间配额，也不新增磁盘 quota 配置。

---

## Definition of Done

- `RUNTIME_PROVIDER` 决定 runtime 类型。
- `RUNTIME_ISOLATION_SCOPE` 决定 runtime 绑定粒度。
- user scope 下同一用户多个 workspace 复用同一个 runtime。
- workspace scope 下每个 workspace 独立 runtime。
- `Run.runtimeType` / `Run.runtimeResourceId` 记录实际运行事实。
- workspace/conversation/run 上层不关心 provider 内部实现。
- 管理员可观察 active runtimes。
- 基础 typecheck 和相关单测通过。
