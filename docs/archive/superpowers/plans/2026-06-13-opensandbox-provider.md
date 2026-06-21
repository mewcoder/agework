# OpenSandboxProvider 实施计划

> **For agentic workers:** 按 task 顺序逐项实施；每个 task 只改列出的文件范围。不要自动 build、lint 或自动打开浏览器测试；必要时只运行相关 typecheck / 单测。

**Goal:** 在现有 `RuntimeProvider` 扩展点下新增 `OpenSandboxProvider`，让 workspace 级 sandbox 复用 OpenSandbox 的生命周期、命令执行、文件/端口/网络/凭证能力。`DockerRuntimeProvider` 暂时保留为 local fallback / debug provider。

**Architecture:** AgeWork 仍负责 `Workspace / Conversation / Run / ModelProvider` 编排。OpenSandbox 只作为底层 sandbox runtime：`workspaceId -> sandboxId`，同一 workspace 下多个 conversation/run 复用同一个 sandbox。Run 事件、AG-UI 聚合、SSE、conversation 状态仍走现有 AgeWork runtime 链路。

**Tech Stack:** NestJS 11、Prisma、Vitest、`@alibaba-group/opensandbox`、现有 `apps/worker` + `HttpTransport` + workspace 级 control queue。

**设计来源:** `docs/superpowers/specs/2026-06-12-opensandbox-provider-design.md`

**当前代码事实:**
- 当前命名已是 `Conversation` / `conversationId` / `activeRunStatus`，不是旧 `Thread`。
- `Workspace.runtimeType` 决定 workspace 使用哪个 runtime；全局默认来自 `RUNTIME_PROVIDER`。
- `Run.runtimeType` / `Run.runtimeResourceId` 是运行事实记录。
- `RuntimeProviderRegistry` 已能聚合多个 provider。
- `DockerRuntimeProvider` 已实现 workspace 级持久容器、workspace key、workspace control queue。
- `RuntimeWorkspaceController.heartbeat()` 当前写死 `resolve("docker")`，接 OpenSandbox 时必须改掉。

---

## File Structure

**配置 / 类型**
- `apps/api/src/config/config.service.ts` — 增加 OpenSandbox 配置读取。
- `packages/shared/src/protocol/transport.ts` — 如有必要，把 workspace 级方法命名泛化；MVP 可先复用现有 `shutdownContainer`。

**Prisma / Runtime binding**
- `apps/api/prisma/schema.prisma` — 新增 `WorkspaceRuntimeBinding`。
- `apps/api/src/runtime/core/workspace-runtime-binding.service.ts` — 新增：管理 `workspaceId + runtimeType -> runtimeResourceId`。
- `apps/api/src/runtime/core/workspace-runtime-binding.service.spec.ts` — 新增测试。

**Provider**
- `apps/api/src/runtime/providers/opensandbox-runtime-provider.ts` — 新增。
- `apps/api/src/runtime/providers/opensandbox-runtime-provider.spec.ts` — 新增。
- `apps/api/src/runtime/providers/runtime-provider-registry.spec.ts` — 增加 opensandbox 注册/解析测试。
- `apps/api/src/runtime/runtime.module.ts` — 注册 `OpenSandboxRuntimeProvider`。

**Internal runtime**
- `apps/api/src/runtime/internal/runtime-workspace.controller.ts` — heartbeat 不再写死 docker。
- `apps/api/src/runtime/internal/runtime-workspace.controller.spec.ts` — 补 opensandbox heartbeat 分发测试。
- `apps/api/src/runtime/internal/runtime-internal-access.service.ts` — 复用 workspace key；如 OpenSandbox 需要更长 TTL，扩展 metadata，不改变默认行为。

**Recovery / Workspace lifecycle**
- `apps/api/src/runtime/core/run-recovery.service.ts` — 恢复 active run 时按 `run.runtimeType` 调 provider；补 workspace runtime binding stale 清理。
- `apps/api/src/workspaces/workspace.service.ts` — workspace 删除时关闭对应 workspace runtime。
- 对应 `.spec.ts`。

**Worker**
- `apps/worker/src/main.ts` — MVP 尽量不改；确认 OpenSandbox sandbox 内可用现有 persistent HTTP worker 路径。
- `apps/worker/src/persistent-http-client.ts` — 如 API base/heartbeat 需要 OpenSandbox endpoint 特化，仅在这里收口。

---

## Phase 0 — OpenSandbox SDK 探针（不接业务）

### Task 0.1: 锁定 SDK API 形状

**Files:**
- Add: `docs/superpowers/specs/2026-06-13-opensandbox-sdk-notes.md`（可选）
- No production code changes

- [ ] 查 `@alibaba-group/opensandbox` 当前版本的实际 API：create/get/delete/pause/resume/renew、commands、files、endpoints、volumes、credential vault、network policy。
- [ ] 明确 SDK import 方式、client 初始化参数、错误类型、timeout/cancel 支持。
- [ ] 明确 sandbox 创建参数是否支持：
  - image
  - env
  - resource limits
  - timeout / ttl
  - host volume / PVC / workspace mount
  - network policy
  - credential vault
- [ ] 明确 OpenSandbox Server 本地默认地址、Docker runtime 启动方式、API key 是否必需。
- [ ] 记录最小 MVP 调用序列：

```text
client.sandbox.create(...)
client.sandbox.get(sandboxId)
sandbox.commands.run(...)
sandbox.kill/delete(...)
```

**Exit Criteria:**
- 能写出 `OpenSandboxClientLike` 最小接口，不把真实 SDK 类型直接散进 provider 逻辑。

---

## Phase 1 — Runtime binding 与配置

### Task 1.1: 新增 WorkspaceRuntimeBinding

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Add: `apps/api/src/runtime/core/workspace-runtime-binding.service.ts`
- Add: `apps/api/src/runtime/core/workspace-runtime-binding.service.spec.ts`
- Modify: `apps/api/src/runtime/runtime.module.ts`

- [ ] 在 Prisma 新增：

```prisma
model WorkspaceRuntimeBinding {
  id                String    @id @default(cuid())
  workspaceId       String
  runtimeType       String
  runtimeResourceId String
  status            String    @default("running")
  expiresAt         DateTime?
  metadata          String    @default("{}")
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt

  @@unique([workspaceId, runtimeType])
  @@index([runtimeType, status])
}
```

- [ ] 新增 service 方法：
  - `find(workspaceId, runtimeType)`
  - `upsertRunning({ workspaceId, runtimeType, runtimeResourceId, expiresAt?, metadata? })`
  - `markStopped(workspaceId, runtimeType)`
  - `delete(workspaceId, runtimeType)`
  - `deleteAllForWorkspace(workspaceId)`
  - `findByWorkspace(workspaceId)`
- [ ] 测试覆盖 upsert 复用、markStopped、deleteAllForWorkspace。

**Notes:**
- 不把 `sandboxId` 塞进 `Workspace.runtimeType` 或 `Workspace` 主表。
- `Run.runtimeResourceId` 继续记录本次 run 关联的 sandbox id。

### Task 1.2: OpenSandbox 配置集中到 ConfigService

**Files:**
- Modify: `apps/api/src/config/config.service.ts`
- Add/Modify: `apps/api/src/config/config.service.spec.ts`（如果现有测试文件存在）

- [ ] 新增读取方法：

```ts
getOpenSandboxConfig(): {
  domain: string;
  protocol: "http" | "https";
  apiKey?: string;
  image: string;
  workspaceMountPath: string;
  timeoutSeconds: number;
  useServerProxy: boolean;
}
```

- [ ] 环境变量：

```text
OPENSANDBOX_DOMAIN=localhost:8080
OPENSANDBOX_PROTOCOL=http
OPENSANDBOX_API_KEY=
OPENSANDBOX_IMAGE=agework/worker:latest
OPENSANDBOX_WORKSPACE_MOUNT=/workspace
OPENSANDBOX_TIMEOUT_SECONDS=3600
OPENSANDBOX_USE_SERVER_PROXY=true
```

- [ ] `getDefaultRuntimeProviderType()` 不需要特殊分支；继续由 `RUNTIME_PROVIDER=opensandbox` 控制。

**Exit Criteria:**
- 不改 runtime 行为，只增加配置读取和测试。

---

## Phase 2 — OpenSandboxProvider MVP

### Task 2.1: 新增 SDK 适配边界

**Files:**
- Add: `apps/api/src/runtime/providers/opensandbox-client.ts`
- Add: `apps/api/src/runtime/providers/opensandbox-client.spec.ts`（可选，主要测试 factory 参数）

- [ ] 定义内部接口，避免 provider 直接依赖真实 SDK 的完整类型：

```ts
export interface OpenSandboxClientLike {
  createSandbox(input: OpenSandboxCreateInput): Promise<OpenSandboxSandboxLike>;
  getSandbox(id: string): Promise<OpenSandboxSandboxLike | null>;
  deleteSandbox(id: string): Promise<void>;
}

export interface OpenSandboxSandboxLike {
  id: string;
  runCommand(command: string, options?: OpenSandboxCommandOptions): Promise<void>;
  getEndpoint?(port: number): Promise<string>;
}
```

- [ ] 真实 SDK factory 只在 `opensandbox-client.ts` 中 import `@alibaba-group/opensandbox`。
- [ ] 单测 provider 时 mock `OpenSandboxClientLike`，不启动 OpenSandbox Server。

### Task 2.2: Provider skeleton 注册

**Files:**
- Add: `apps/api/src/runtime/providers/opensandbox-runtime-provider.ts`
- Add: `apps/api/src/runtime/providers/opensandbox-runtime-provider.spec.ts`
- Modify: `apps/api/src/runtime/runtime.module.ts`
- Modify: `apps/api/src/runtime/providers/runtime-provider-registry.spec.ts`

- [ ] 新增 `OpenSandboxRuntimeProvider implements RuntimeProvider`：

```ts
readonly type = "opensandbox" as const;
```

- [ ] 先实现空壳方法，抛出明确错误或返回 no-op：
  - `start`
  - `sendControl`
  - `cancel`
  - `getHandle`
  - `heartbeat`
  - `cleanup`
  - `recoverOrphan`
  - `getStateByWorkspaceId`
  - `heartbeatWorkspace`
  - `shutdownContainer`
- [ ] 注册到 `RUNTIME_PROVIDERS`：

```ts
inject: [LocalRuntimeProvider, DockerRuntimeProvider, OpenSandboxRuntimeProvider]
```

- [ ] Registry 测试能 `resolve("opensandbox")`。

**Exit Criteria:**
- `RUNTIME_PROVIDER=opensandbox` 能解析到 provider，但还不要求真实 run 成功。

### Task 2.3: getOrCreateSandbox(workspaceId)

**Files:**
- Modify: `apps/api/src/runtime/providers/opensandbox-runtime-provider.ts`
- Modify: `apps/api/src/runtime/providers/opensandbox-runtime-provider.spec.ts`

- [ ] 注入：
  - `WorkspaceRuntimeBindingService`
  - `RuntimeConfigStore`
  - `RuntimeInternalAccessService`
  - `RuntimeControlQueue`
  - `ConfigService`
  - `RuntimeEventProcessor`
  - `OpenSandboxClientLike`
- [ ] 实现内部状态：

```ts
type OpenSandboxWorkspaceState = {
  sandboxId: string;
  accessKey: string;
  activeRuns: Map<string, string>; // runId -> conversationId
};

workspaceSandboxes: Map<string, OpenSandboxWorkspaceState>;
pendingSandboxes: Map<string, Promise<string>>;
controlSeqs: Map<string, number>;
```

- [ ] `getOrCreateSandbox(workspaceId, hostPath)` 行为：
  - 先看内存 state。
  - 再看 `WorkspaceRuntimeBinding`，存在则调用 `client.getSandbox()` 验证。
  - 不存在或失效则 `client.createSandbox(...)`。
  - 成功后 upsert binding。
- [ ] 单测覆盖：
  - 内存命中不调 SDK。
  - DB binding 命中且 SDK get 成功，复用。
  - DB binding stale，重新 create 并覆盖 binding。
  - create 失败时不写 binding。

---

## Phase 3 — 跑通现有 worker + HttpTransport

### Task 3.1: OpenSandboxProvider.start()

**Files:**
- Modify: `apps/api/src/runtime/providers/opensandbox-runtime-provider.ts`
- Modify: `apps/api/src/runtime/providers/opensandbox-runtime-provider.spec.ts`

- [ ] `start(runConfig, onRuntimeResourceIdReady)`：
  - 将 `runtimePath` 改成 OpenSandbox 内路径，默认 `/workspace`。
  - `runConfigStore.register(runId, sandboxRunConfig)`。
  - 为 workspace 签发/复用 workspace access key。
  - `runtimeAccess.registerRun(runId, accessKey)`。
  - `activeRuns.set(runId, conversationId)`。
  - push workspace `user_message` control。
  - 创建或复用 sandbox。
  - 返回 `RuntimeHandle { runId, runtimeType: "opensandbox", runtimeResourceId: sandboxId | "", conversationId }`。
  - sandboxId ready 后调用 `onRuntimeResourceIdReady(sandboxId)`。
- [ ] 如果 sandbox 创建失败：
  - publish `run.status:error`。
  - 清理 `runConfigStore`、access、activeRuns、control queue 中当前 run 相关状态。
- [ ] 单测覆盖：
  - 复用 sandbox。
  - 创建 pending 期间第二个 run 不重复 create。
  - create 失败发布错误。
  - 返回 handle 的 `runtimeType/runtimeResourceId/conversationId` 正确。

### Task 3.2: 在 sandbox 内启动常驻 worker

**Files:**
- Modify: `apps/api/src/runtime/providers/opensandbox-runtime-provider.ts`
- Maybe Modify: `apps/worker/src/persistent-http-client.ts`

- [ ] 使用 OpenSandbox command API 启动 worker 常驻进程。命令形态由 Phase 0 SDK 探针确认，目标等价于：

```text
RUNTIME_TRANSPORT=http
AGEWORK_RUNTIME_MODE=persistent
AGEWORK_WORKSPACE_ID=<workspaceId>
AGEWORK_API_BASE=<apiBase>
AGEWORK_RUNTIME_ACCESS_KEY=<workspaceAccessKey>
node apps/worker/dist/main.js
```

- [ ] 如果使用 `OPENSANDBOX_IMAGE=agework/worker:latest`，镜像入口可以直接是 worker；provider 只需确认进程已启动。
- [ ] 如果 SDK 只支持 command run，不支持 background command，则记录限制并先走 per-run command MVP，不做常驻复用。
- [ ] 确认 sandbox 到 AgeWork API 的 `AGEWORK_API_BASE` 可达；本地 Docker runtime 下不能默认用 `localhost` 指向宿主 API。

**Decision Gate:**
- 如果常驻 background command 可用：继续 workspace 级 persistent worker。
- 如果不可用：退到 OpenSandbox per-run command，但保留 `WorkspaceRuntimeBinding`，后续再补常驻模式。

### Task 3.3: workspace heartbeat 分发去 docker hardcode

**Files:**
- Modify: `apps/api/src/runtime/internal/runtime-workspace.controller.ts`
- Modify: `apps/api/src/runtime/internal/runtime-workspace.controller.spec.ts`

- [ ] 当前逻辑：

```ts
this.runtimeProviderRegistry.resolve("docker").heartbeatWorkspace?.(workspaceId);
```

- [ ] 改为按 workspace 当前活跃 runtime 分发。优先方案：
  - 从 `WorkspaceRuntimeBindingService.findByWorkspace(workspaceId)` 找 `status=running` 的 binding。
  - 对每个 binding 调 `runtimeProviderRegistry.resolve(binding.runtimeType).heartbeatWorkspace?.(workspaceId)`。
- [ ] 单测覆盖：
  - docker binding 调 docker provider。
  - opensandbox binding 调 opensandbox provider。
  - 无 binding 时不抛错。

### Task 3.4: cancel / cleanup / getHandle

**Files:**
- Modify: `apps/api/src/runtime/providers/opensandbox-runtime-provider.ts`
- Modify: `apps/api/src/runtime/providers/opensandbox-runtime-provider.spec.ts`

- [ ] `sendControl(handle, control)`：按 run 找 workspace，push workspace control。
- [ ] `cancel(handle)`：发送 `{ type: "cancel", runId, conversationId }`；不要 delete sandbox。
- [ ] `cleanup(runId)`：
  - `runConfigStore.unregister(runId)`。
  - `runtimeAccess.revokeAccess(runId)` 或只解除 run 绑定。
  - `activeRuns.delete(runId)`。
  - sandbox 保留。
- [ ] `getHandle(runId)`：从 `activeRuns` 反查 workspace state。
- [ ] 单测覆盖 cancel 不删除 sandbox，cleanup 不删除 sandbox。

---

## Phase 4 — Workspace 生命周期与恢复

### Task 4.1: workspace 删除时关闭 runtime

**Files:**
- Modify: `apps/api/src/workspaces/workspace.service.ts`
- Modify: `apps/api/src/workspaces/workspace.service.spec.ts`
- Modify: `apps/api/src/runtime/core/workspace-runtime-binding.service.ts`

- [ ] 在 workspace soft delete 后，关闭该 workspace 的所有 runtime binding：
  - 对每个 binding resolve provider。
  - 调 `provider.shutdownContainer?.(workspaceId)`。
  - 删除或 mark stopped binding。
- [ ] 如果 provider shutdown 失败：
  - 记录 warn。
  - workspace 删除不应整体失败，避免用户无法移除 workspace。
- [ ] 单测覆盖 opensandbox/docker binding 都会被 shutdown。

### Task 4.2: recoverOrphan 支持 OpenSandbox

**Files:**
- Modify: `apps/api/src/runtime/providers/opensandbox-runtime-provider.ts`
- Modify: `apps/api/src/runtime/core/run-recovery.service.ts`
- Modify: corresponding specs

- [ ] `OpenSandboxRuntimeProvider.recoverOrphan(runtimeResourceId)`：
  - 调 `client.getSandbox(runtimeResourceId)`。
  - 存在则 delete/kill。
  - 不存在则 no-op。
- [ ] `RunRecoveryService.recoverOrphanRuns()` 已按 `run.runtimeType` resolve provider，保持。
- [ ] `recoverOrphanContainers()` 仍只处理 Docker CLI orphan，命名可以后续改为 `recoverDockerOrphanContainers()`。
- [ ] 增加 workspace binding stale 清理：
  - 启动时扫描 running binding。
  - 对 opensandbox binding 调 SDK get；不存在则 mark stopped/delete。

### Task 4.3: RuntimeResourceId 命名收口

**Files:**
- Maybe Modify: docs only or code comments

- [ ] 在 OpenSandboxProvider 中统一使用：
  - `runtimeResourceId = sandboxId`
  - `workspace binding.external id = sandboxId`
  - command/execution id 放 `metadata`，不要覆盖 `Run.runtimeResourceId`
- [ ] 代码注释避免再出现 `containerId` 指代 OpenSandbox sandbox。

---

## Phase 5 — Credential Vault 与 network policy

### Task 5.1: 最小网络策略

**Files:**
- Modify: `apps/api/src/runtime/providers/opensandbox-runtime-provider.ts`
- Add/Modify: tests

- [ ] sandbox create 时默认配置 egress allowlist：
  - 模型 API 域名。
  - git host。
  - npm/pnpm registry。
  - OpenSandbox/AgeWork internal API。
- [ ] 如果 OpenSandbox 本地 Docker runtime 暂不支持细粒度策略，provider 应明确降级并记录 warn。

### Task 5.2: Credential Vault 集成

**Files:**
- Modify: `apps/api/src/runtime/providers/opensandbox-runtime-provider.ts`
- Maybe Modify: `apps/api/src/agent/agent-run-config-builder.ts`
- Add/Modify: tests

- [ ] 从 `RunConfig.adapter` 中识别模型服务：
  - Claude: Anthropic compatible endpoint。
  - Codex/OpenAI: OpenAI compatible endpoint。
- [ ] 将真实 API key 写入 OpenSandbox Credential Vault / sidecar。
- [ ] sandbox env 只放 fake key。
- [ ] `RunConfig.adapter` 传入 sandbox 前不再包含真实 key，或仅包含 sidecar 所需 fake key。
- [ ] trace/logger 确认不会记录真实 key。

**Decision Gate:**
- 如果 Credential Vault 对当前 Claude Code / Codex CLI 请求路径不兼容，先保留现有 env 注入，但必须把该限制写入 spec 并标记为上线风险。

---

## Phase 6 — 验证清单

不要自动执行完整 build/lint。实施者在对应阶段手动执行必要检查：

- [ ] `pnpm --filter api typecheck`
- [ ] `pnpm test:api -- workspace-runtime-binding.service.spec.ts`
- [ ] `pnpm test:api -- opensandbox-runtime-provider.spec.ts`
- [ ] `pnpm test:api -- runtime-workspace.controller.spec.ts`
- [ ] 手动启动 OpenSandbox Server，本地创建一个 workspace，设置 `runtimeType=opensandbox`。
- [ ] 同一 workspace 同一 conversation 连续两轮消息能 resume。
- [ ] 同一 workspace 两个 conversation 并发 run，事件按 runId 回到各自 conversation。
- [ ] cancel 一个 conversation 的 run，不影响另一个 conversation。
- [ ] workspace 删除后 sandbox 被删除，binding 被清理。
- [ ] API 重启后 active run 标记 error，orphan sandbox 被清理或 stale binding 被清理。
- [ ] Credential Vault 模式下，sandbox 内读不到真实模型 API key，但模型请求成功。

---

## Rollout Strategy

1. 默认仍保持 `RUNTIME_PROVIDER=local` 或现有值。
2. 先允许单个 workspace 手动设置 `runtimeType=opensandbox`。
3. OpenSandbox 主链路稳定后，将开发/测试环境默认 runtime 切到 `opensandbox` 做灰度。
4. 生产默认切换前必须完成 Credential Vault / network policy 验证。
5. 切换后 `DockerRuntimeProvider` 保留一个版本周期，作为 fallback / debug provider。
6. 如果 OpenSandbox 运行稳定，再把 DockerProvider 标记为 legacy，停止扩展 Docker 专属能力。

## Out of Scope

- 不删除 `DockerRuntimeProvider`。
- 不重写 worker 协议。
- 不改前端聊天 UI。
- 不引入每 conversation 独立 sandbox。
- 不把 OpenSandbox 的 code interpreter/browser/desktop 能力暴露到产品 UI。
- 不在本计划中实现 K8s 部署文档。
