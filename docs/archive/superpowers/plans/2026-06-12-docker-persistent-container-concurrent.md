# Docker 工作空间级持久容器 + 并行 Thread 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Docker 模式下每个 workspace 复用一个长期运行的容器，容器内常驻 worker 同时并行执行该 workspace 下多个 thread 的 run，并支持跨 run resume。

**Architecture:** 容器以 `agework-ws-{workspaceId}` 命名、去掉 `--rm` 持久化。容器内 worker 是多路复用器，持有单个 `ClaudeAgentAdapter` 实例（内部状态按 threadId 分片，天然并发安全），用 `runs: Map<runId, Subscription>` 同时跑多个 run。Provider 按 workspaceId 维护容器和 `activeRuns` 并发集合，不再每 run 一容器、不做 409。Resume 走两层：容器存活时靠 adapter 内存 `sessions`，容器重建时靠 DB `agentResumeId`。

**Tech Stack:** NestJS 11 + Vitest（后端）、Node child_process / fetch（worker）、rxjs（adapter）、Docker CLI、Turborepo + pnpm。

**设计来源：** `docs/superpowers/specs/2026-06-12-docker-persistent-container-design.md`

**已完成（前置）：** 控制队列已从 thread 级收敛到 workspace 级（`RuntimeControlQueue.pushForWorkspace/pollByWorkspace/cleanupWorkspace`），`RuntimeWorkspaceController` 已注册并暴露 `GET /internal/workspaces/:workspaceId/controls`。本计划在此基础上接上生产者与消费者。

**命名约定（跨任务必须一致）：**
- `RunConfig.workspaceId: string`
- Provider 内部：`DockerWorkspaceState = { containerId: string; accessKey: string; activeRuns: Set<string> }`，`workspaceContainers: Map<string, DockerWorkspaceState>`
- Adapter：`interrupt(threadId?: string)`
- Access：`issueWorkspaceKey(workspaceId)` / `verifyWorkspaceKey(workspaceId, key)` / `registerRun(runId, key)` / `revokeWorkspace(workspaceId)`
- Worker：`RunMultiplexer`（`startRun(runId, input)` / `cancelRun(runId, threadId)` / `has(runId)` / `size()`）
- 容器命名：`agework-ws-${workspaceId}`

---

## File Structure

**协议 / 共享**
- `packages/shared/src/protocol/transport.ts` — 修改：`RunConfig` 加 `workspaceId`；`RuntimeProvider` 接口把 thread 级可选方法换成 workspace 级。

**Adapter**
- `packages/adapters/src/claude/base/adapter.ts` — 修改：`interrupt(threadId?)` 精确中断。
- `packages/adapters/src/claude/base/adapter.spec.ts` — 测试。

**后端 API**
- `apps/api/src/agent/agent-run-config-builder.ts` — 修改：`buildRunConfig` 增加 `workspaceId` 并写入 RunConfig。
- `apps/api/src/agent/agent-run-handler.ts` — 修改：传 `workspaceId`；去掉 `providerType !== "docker"` 的 resume 限制。
- `apps/api/src/runtime/internal/runtime-internal-access.service.ts` — 修改：workspace 级 key。
- `apps/api/src/runtime/internal/runtime-internal-auth.guard.ts` — 修改：按 runId / workspaceId 分支校验。
- `apps/api/src/runtime/providers/docker-runtime-provider.ts` — 重写：workspace 持久容器 + 并发。
- `apps/api/src/runtime/core/run-recovery.service.ts` — 修改：扫描 `agework-ws-*` 孤儿容器。
- 对应 `.spec.ts` 测试文件。

**Worker**
- `apps/worker/src/run-multiplexer.ts` — 新建：纯多路复用单元（可单测）。
- `apps/worker/src/run-multiplexer.spec.ts` — 新建：测试。
- `apps/worker/src/persistent-http-client.ts` — 新建：持久容器 HTTP 客户端（workspace 轮询 + 按 runId emit / fetch config）。
- `apps/worker/src/persistent-http-client.spec.ts` — 新建：测试。
- `apps/worker/src/main.ts` — 修改：检测持久模式，走多路复用路径；保留 IPC 单 run 路径。

---

## Phase 1 — 地基（additive，无行为变化，可独立合并）

### Task 1: RunConfig 增加 workspaceId

**Files:**
- Modify: `packages/shared/src/protocol/transport.ts:53-62`
- Modify: `apps/api/src/agent/agent-run-config-builder.ts:55-94`
- Modify: `apps/api/src/agent/agent-run-handler.ts:135-142`
- Test: `apps/api/src/agent/agent-run-config-builder.spec.ts`

- [ ] **Step 1: 写失败测试**

在 `agent-run-config-builder.spec.ts` 已有的 `buildRunConfig` 测试附近新增（沿用该文件已有的 `modelProviderService` mock 与 `builder` 实例；若文件无现成实例，仿照 docker-provider.spec 的构造方式 new 一个）：

```ts
it("includes workspaceId in the RunConfig", async () => {
  const config = await builder.buildRunConfig({
    agentType: "claude",
    modelProviderId: "mp-1",
    workspaceId: "ws-1",
    workspaceRootPath: "/tmp/ws",
    runId: "run-1",
    threadId: "thread-1",
    input: {},
  });
  expect(config.workspaceId).toBe("ws-1");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test:api -- agent-run-config-builder.spec.ts`
Expected: FAIL —类型报错 `workspaceId` 不在参数类型里 / `config.workspaceId` 为 undefined。

- [ ] **Step 3: 实现**

`transport.ts` 的 `RunConfig` 增加字段：

```ts
export type RunConfig = {
  runId: string;
  threadId: string;
  workspaceId: string;
  agentType: AgentType;
  runtimePath: string;
  env: Record<string, string>;
  input: unknown;
  adapter: AdapterRuntimeConfig;
};
```

`agent-run-config-builder.ts` 的参数与返回值：

```ts
async buildRunConfig(params: {
  agentType: string;
  modelProviderId: string;
  workspaceId: string;
  workspaceRootPath: string;
  runId: string;
  threadId: string;
  input: unknown;
}): Promise<RunConfig> {
  const {
    agentType,
    modelProviderId,
    workspaceId,
    workspaceRootPath,
    runId,
    threadId,
    input,
  } = params;
  // ... 其余不变 ...
  return {
    runId,
    threadId,
    workspaceId,
    agentType: agentType as AgentType,
    runtimePath: workspaceRootPath,
    env: {},
    input,
    adapter,
  };
}
```

`agent-run-handler.ts` 调用处传入（`workspaceId` 在该函数里已从 `thread.workspaceId` 取到，见 `agent-run-handler.ts:59,71`；此处 `workspaceId!` 因为上方第 90 行已校验非空）：

```ts
runConfig = await this.runConfigBuilder.buildRunConfig({
  agentType,
  modelProviderId,
  workspaceId: workspaceId!,
  workspaceRootPath,
  runId,
  threadId,
  input: runInput,
});
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test:api -- agent-run-config-builder.spec.ts` Expected: PASS
Run: `pnpm typecheck` Expected: 全部通过（注意 agent-run-handler.spec 里若构造了 RunConfig，需补 `workspaceId`）。

- [ ] **Step 5: 提交**

```bash
git add packages/shared/src/protocol/transport.ts apps/api/src/agent/agent-run-config-builder.ts apps/api/src/agent/agent-run-handler.ts apps/api/src/agent/agent-run-config-builder.spec.ts
git commit -m "feat(runtime): add workspaceId to RunConfig"
```

---

### Task 2: RuntimeProvider 接口换成 workspace 级可选方法

**Files:**
- Modify: `packages/shared/src/protocol/transport.ts:135-139`

- [ ] **Step 1: 实现（纯类型，无单测）**

把现有 thread 级可选方法替换：

```ts
  /** 查找该 workspace 是否已有活跃持久容器（Docker 复用）。 */
  getStateByWorkspaceId?(workspaceId: string): { containerId: string } | undefined;
  /** 收到 worker 心跳时喂 workspace/容器级 watchdog。 */
  heartbeatWorkspace?(workspaceId: string): void;
  /** 停止并删除该 workspace 的持久容器（workspace 删除时调用）。 */
  shutdownContainer?(workspaceId: string): void;
```

删除 `getHandleByThreadId?` 与 `heartbeatThread?`。

- [ ] **Step 2: 确认无引用残留**

Run: `rg -n "getHandleByThreadId|heartbeatThread" apps packages`
Expected: 无输出。

- [ ] **Step 3: typecheck**

Run: `pnpm typecheck` Expected: 通过。

- [ ] **Step 4: 提交**

```bash
git add packages/shared/src/protocol/transport.ts
git commit -m "refactor(runtime): switch provider optional methods to workspace level"
```

---

### Task 3: Adapter 按 thread 精确中断

**Files:**
- Modify: `packages/adapters/src/claude/base/adapter.ts:126-130`
- Test: `packages/adapters/src/claude/base/adapter.spec.ts`

- [ ] **Step 1: 写失败测试**

`adapter.spec.ts` 新增（用 `as any` 直接访问私有 `activeQueries`，沿用该文件已有的 internals 访问风格）：

```ts
it("interrupt(threadId) only interrupts that thread's query", async () => {
  const adapter = new ClaudeAgentAdapter({});
  const interruptA = vi.fn().mockResolvedValue(undefined);
  const interruptB = vi.fn().mockResolvedValue(undefined);
  const internals = adapter as unknown as {
    activeQueries: Map<string, { interrupt: () => Promise<void> }>;
  };
  internals.activeQueries.set("thread-a", { interrupt: interruptA } as never);
  internals.activeQueries.set("thread-b", { interrupt: interruptB } as never);

  await adapter.interrupt("thread-a");

  expect(interruptA).toHaveBeenCalledTimes(1);
  expect(interruptB).not.toHaveBeenCalled();
});

it("interrupt() with no arg interrupts all queries", async () => {
  const adapter = new ClaudeAgentAdapter({});
  const interruptA = vi.fn().mockResolvedValue(undefined);
  const interruptB = vi.fn().mockResolvedValue(undefined);
  const internals = adapter as unknown as {
    activeQueries: Map<string, { interrupt: () => Promise<void> }>;
  };
  internals.activeQueries.set("thread-a", { interrupt: interruptA } as never);
  internals.activeQueries.set("thread-b", { interrupt: interruptB } as never);

  await adapter.interrupt();

  expect(interruptA).toHaveBeenCalledTimes(1);
  expect(interruptB).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test -- adapter.spec.ts` （在 `packages/adapters` 下，或根目录 `pnpm --filter @agework/adapters test`）
Expected: FAIL — `interrupt("thread-a")` 仍中断全部，第一个用例失败。

- [ ] **Step 3: 实现**

```ts
public async interrupt(threadId?: string): Promise<void> {
  if (threadId) {
    await this.activeQueries.get(threadId)?.interrupt();
    return;
  }
  for (const q of this.activeQueries.values()) {
    await q.interrupt();
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @agework/adapters test -- adapter.spec.ts` Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/adapters/src/claude/base/adapter.ts packages/adapters/src/claude/base/adapter.spec.ts
git commit -m "feat(adapter): support per-thread interrupt"
```

---

## Phase 2 — Workspace 级 Access Key

### Task 4: Access Service 支持 workspace key + Guard 分支

**Files:**
- Modify: `apps/api/src/runtime/internal/runtime-internal-access.service.ts`
- Modify: `apps/api/src/runtime/internal/runtime-internal-auth.guard.ts`
- Test: `apps/api/src/runtime/internal/runtime-internal-access.service.spec.ts`

**背景：** Guard 现在只按 `params.runId` 校验。持久容器一个 workspace 一个 key，且 worker 用同一个 key 访问 per-run 端点（config fetch / events）和 workspace controls 端点。做法：每个 run 在 provider 启动时把「该 run 属于的 workspace key」注册进来，per-run 校验保持原样工作；controls 端点按 workspaceId 校验。

- [ ] **Step 1: 写失败测试**

```ts
it("verifies a run using its workspace key after registerRun", () => {
  const svc = new RuntimeInternalAccessService();
  const key = svc.issueWorkspaceKey("ws-1");
  svc.registerRun("run-1", key);

  expect(svc.verifyAccessKey("run-1", key)).toBe(true);
  expect(svc.verifyAccessKey("run-1", "wrong")).toBe(false);
});

it("verifies the workspace controls key", () => {
  const svc = new RuntimeInternalAccessService();
  const key = svc.issueWorkspaceKey("ws-1");

  expect(svc.verifyWorkspaceKey("ws-1", key)).toBe(true);
  expect(svc.verifyWorkspaceKey("ws-1", "wrong")).toBe(false);
});

it("revokeWorkspace invalidates the key and bound runs", () => {
  const svc = new RuntimeInternalAccessService();
  const key = svc.issueWorkspaceKey("ws-1");
  svc.registerRun("run-1", key);
  svc.revokeWorkspace("ws-1");

  expect(svc.verifyWorkspaceKey("ws-1", key)).toBe(false);
  expect(svc.verifyAccessKey("run-1", key)).toBe(false);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test:api -- runtime-internal-access.service.spec.ts`
Expected: FAIL — 方法未定义。

- [ ] **Step 3: 实现 access service**

在现有类基础上增加（保留 `issueAccessKey`/`revokeAccess` 供回归兼容，但 docker 改用 workspace key）：

```ts
private readonly accessKeys = new Map<string, string>();      // runId -> key
private readonly workspaceKeys = new Map<string, string>();   // workspaceId -> key
private readonly runWorkspace = new Map<string, string>();    // runId -> workspaceId

issueWorkspaceKey(workspaceId: string): string {
  const key = randomBytes(ACCESS_KEY_BYTES).toString("base64url");
  this.workspaceKeys.set(workspaceId, key);
  return key;
}

/** 把某个 run 绑定到 workspace key，使 per-run 端点用 workspace key 即可通过。 */
registerRun(runId: string, workspaceKey: string): void {
  this.accessKeys.set(runId, workspaceKey);
}

verifyWorkspaceKey(workspaceId: string, key: string): boolean {
  return this.constantTimeEqual(this.workspaceKeys.get(workspaceId), key);
}

revokeWorkspace(workspaceId: string): void {
  const key = this.workspaceKeys.get(workspaceId);
  this.workspaceKeys.delete(workspaceId);
  if (key) {
    for (const [runId, k] of this.accessKeys) {
      if (k === key) this.accessKeys.delete(runId);
    }
  }
}
```

把现有 `verifyAccessKey` 内联的比较抽成私有 `constantTimeEqual(expected: string | undefined, actual: string): boolean`，并让 `verifyAccessKey`/`verifyWorkspaceKey` 复用：

```ts
verifyAccessKey(runId: string, accessKey: string): boolean {
  return this.constantTimeEqual(this.accessKeys.get(runId), accessKey);
}

private constantTimeEqual(expected: string | undefined, actual: string): boolean {
  if (!expected) return false;
  const e = Buffer.from(expected);
  const a = Buffer.from(actual);
  if (e.length !== a.length) return false;
  return timingSafeEqual(e, a);
}
```

- [ ] **Step 4: 实现 guard 分支**

`runtime-internal-auth.guard.ts` 的 `canActivate` 改为：

```ts
const accessKey = extractBearerToken(request.headers);
if (!accessKey) throw new UnauthorizedException("Missing runtime access key");

const { runId, workspaceId } = request.params;
if (runId && this.runtimeAccess.verifyAccessKey(runId, accessKey)) {
  request.runId = runId;
  return true;
}
if (workspaceId && this.runtimeAccess.verifyWorkspaceKey(workspaceId, accessKey)) {
  return true;
}
throw new UnauthorizedException("Invalid runtime access key");
```

`RequestWithRunId` 的 `params` 类型已是 `Record<string, string>`，`workspaceId` 直接取即可。

- [ ] **Step 5: 运行确认通过 + typecheck**

Run: `pnpm test:api -- runtime-internal-access.service.spec.ts` Expected: PASS
Run: `pnpm typecheck` Expected: 通过。

- [ ] **Step 6: 提交**

```bash
git add apps/api/src/runtime/internal/runtime-internal-access.service.ts apps/api/src/runtime/internal/runtime-internal-auth.guard.ts apps/api/src/runtime/internal/runtime-internal-access.service.spec.ts
git commit -m "feat(runtime): workspace-scoped internal access keys"
```

---

## Phase 3 — Docker Provider 持久容器 + 并发

### Task 5: Docker Provider 重写为 workspace 持久容器

**Files:**
- Modify: `apps/api/src/runtime/providers/docker-runtime-provider.ts`
- Test: `apps/api/src/runtime/providers/docker-runtime-provider.spec.ts`

**关键行为：**
1. `start()`：无容器→`docker run`（**去 `--rm`**、加 `--name agework-ws-{wsId}`、传 `AGEWORK_WORKSPACE_ID`、`AGEWORK_RUNTIME_ACCESS_KEY`=workspace key），有容器→复用；两种情况都 `runConfigStore.register(runId)`、`accessService.registerRun(runId, wsKey)`、`controlQueue.pushForWorkspace(wsId, user_message{runId,input})`、`activeRuns.add(runId)`。
2. `cancel()`：发 cancel 控制（worker 据 threadId 精确中断），`activeRuns.delete(runId)`，**不杀容器**。
3. `cleanup(runId)`：`activeRuns.delete(runId)` + 清 per-run 状态，容器保留。
4. 心跳 watchdog **按 workspaceId/容器**，不再 per-run。
5. `shutdownContainer(wsId)`：停容器 + `revokeWorkspace` + 删状态。

- [ ] **Step 1: 写失败测试**

替换/扩展 `docker-runtime-provider.spec.ts`，沿用现有 execFile mock 风格。RunConfig 现在带 `workspaceId`，mock 依赖加 `pushForWorkspace`、`issueWorkspaceKey`、`registerRun`、`revokeWorkspace`：

```ts
function makeProvider() {
  const eventProcessor = {
    forceErrorStatus: vi.fn().mockResolvedValue(undefined),
    forceCancelledStatus: vi.fn().mockResolvedValue(undefined),
    isTerminalOrFinalizing: vi.fn().mockReturnValue(false),
  };
  const configStore = { register: vi.fn(), unregister: vi.fn() };
  const access = {
    issueWorkspaceKey: vi.fn().mockReturnValue("ws-key"),
    registerRun: vi.fn(),
    revokeWorkspace: vi.fn(),
  };
  const controlQueue = {
    pushForWorkspace: vi.fn(),
    cleanupWorkspace: vi.fn(),
    cleanup: vi.fn(),
  };
  const config = { getWorkerImage: vi.fn().mockReturnValue("agework/worker:latest"), getWorkspace: vi.fn().mockReturnValue("/tmp/workspace") };
  const provider = new DockerRuntimeProvider(
    eventProcessor as never, configStore as never, access as never,
    controlQueue as never, config as never
  );
  return { provider, access, controlQueue, configStore };
}

const baseRun = { runId: "run-1", threadId: "t-1", workspaceId: "ws-1", runtimePath: "" };

it("first run for a workspace starts a persistent container without --rm", async () => {
  const { provider } = makeProvider();
  mockExecFile.mockImplementation(((...args: any[]) => {
    args[args.length - 1](null, { stdout: "container-abc\n", stderr: "" });
  }) as any);

  provider.start(baseRun as never);
  await vi.runOnlyPendingTimersAsync();

  const runCall = mockExecFile.mock.calls.find((c) => (c[1] as string[])[0] === "run");
  const runArgs = runCall![1] as string[];
  expect(runArgs).not.toContain("--rm");
  expect(runArgs).toContain("--name");
  expect(runArgs).toContain("agework-ws-ws-1");
  expect(runArgs).toContain("AGEWORK_WORKSPACE_ID=ws-1");
});

it("pushes a user_message control and tracks the run", async () => {
  const { provider, controlQueue } = makeProvider();
  mockExecFile.mockImplementation(((...args: any[]) => {
    args[args.length - 1](null, { stdout: "container-abc\n", stderr: "" });
  }) as any);

  provider.start(baseRun as never);
  await vi.runOnlyPendingTimersAsync();

  expect(controlQueue.pushForWorkspace).toHaveBeenCalledWith(
    "ws-1",
    expect.objectContaining({
      payload: expect.objectContaining({ type: "user_message", runId: "run-1" }),
    })
  );
});

it("reuses the existing container for a second run (no second docker run)", async () => {
  const { provider, controlQueue } = makeProvider();
  mockExecFile.mockImplementation(((...args: any[]) => {
    args[args.length - 1](null, { stdout: "container-abc\n", stderr: "" });
  }) as any);

  provider.start(baseRun as never);
  await vi.runOnlyPendingTimersAsync();
  provider.start({ ...baseRun, runId: "run-2", threadId: "t-2" } as never);
  await vi.runOnlyPendingTimersAsync();

  const runCalls = mockExecFile.mock.calls.filter((c) => (c[1] as string[])[0] === "run");
  expect(runCalls).toHaveLength(1); // 只起一次容器
  expect(controlQueue.pushForWorkspace).toHaveBeenCalledTimes(2); // 两个 run 都 push
});

it("cancel does not stop the container", async () => {
  const { provider } = makeProvider();
  mockExecFile.mockImplementation(((...args: any[]) => {
    args[args.length - 1](null, { stdout: "container-abc\n", stderr: "" });
  }) as any);

  const handle = provider.start(baseRun as never);
  await vi.runOnlyPendingTimersAsync();
  provider.cancel(handle);

  const stopCalls = mockExecFile.mock.calls.filter((c) => (c[1] as string[])[0] === "stop");
  expect(stopCalls).toHaveLength(0);
});

it("shutdownContainer stops the container and revokes the workspace key", async () => {
  const { provider, access } = makeProvider();
  mockExecFile.mockImplementation(((...args: any[]) => {
    args[args.length - 1](null, { stdout: "container-abc\n", stderr: "" });
  }) as any);

  provider.start(baseRun as never);
  await vi.runOnlyPendingTimersAsync();
  provider.shutdownContainer!("ws-1");
  await vi.runOnlyPendingTimersAsync();

  const stopCalls = mockExecFile.mock.calls.filter((c) => (c[1] as string[])[0] === "stop");
  expect(stopCalls.length).toBeGreaterThan(0);
  expect(access.revokeWorkspace).toHaveBeenCalledWith("ws-1");
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test:api -- docker-runtime-provider.spec.ts`
Expected: FAIL — 新 API 未实现。

- [ ] **Step 3: 实现 provider 重写**

核心结构（保留 `dockerStop/dockerKill/stopContainerOrKill/recoverOrphan/assertSafeMountPath/getApiBaseUrl/getWorkerImage` 不变）。状态与方法替换为：

```ts
type DockerWorkspaceState = {
  containerId: string;        // 容器就绪后填入；启动中为 ""
  accessKey: string;
  activeRuns: Set<string>;
  startPromise: Promise<string>;
};

private readonly workspaceContainers = new Map<string, DockerWorkspaceState>();
private readonly controlSeqs = new Map<string, number>(); // 按 workspaceId 计序

start(runConfig: RunConfig, onRuntimeIdReady?: (runtimeId: string) => void): RuntimeHandle {
  const { runId, threadId, workspaceId } = runConfig;
  const containerRunConfig = { ...runConfig, runtimePath: "/workspace" };
  this.runConfigStore.register(runId, containerRunConfig);

  let state = this.workspaceContainers.get(workspaceId);
  if (!state) {
    const accessKey = this.runtimeAccess.issueWorkspaceKey(workspaceId);
    const startPromise = this.startContainer(
      workspaceId, this.getWorkerImage(), runConfig.runtimePath,
      this.getApiBaseUrl(), accessKey
    );
    state = { containerId: "", accessKey, activeRuns: new Set(), startPromise };
    this.workspaceContainers.set(workspaceId, state);
    this.controlSeqs.set(workspaceId, 0);

    startPromise
      .then((containerId) => {
        state!.containerId = containerId;
        onRuntimeIdReady?.(containerId);
        this.heartbeats.start(workspaceId, () => {
          this.logger.error(`Heartbeat timeout for workspace=${workspaceId}, stopping container`);
          this.stopContainerOrKill(containerId, "heartbeat timeout container");
          this.shutdownContainer(workspaceId);
        });
      })
      .catch((err) => {
        this.logger.error(`Failed to start container for workspace=${workspaceId}: ${String(err)}`);
        this.workspaceContainers.delete(workspaceId);
        publishWorkerErrorStatus(this.runEventProcessor, runId, `docker run failed: ${String(err)}`);
      });
  }

  // 注册 run、绑定 key、发 user_message 复用（容器是否就绪都先 push，worker 起来后会拉到）
  state.activeRuns.add(runId);
  this.runtimeAccess.registerRun(runId, state.accessKey);
  this.pushWorkspaceControl(workspaceId, {
    type: "user_message",
    commandId: randomUUID(),
    runId,
    input: containerRunConfig.input,
  });

  return { runId, providerType: "docker", runtimeId: state.containerId, threadId };
}

private pushWorkspaceControl(workspaceId: string, control: ControlPayload): void {
  const envelope = nextControlEnvelope(this.controlSeqs, workspaceId, control);
  this.controlQueue.pushForWorkspace(workspaceId, envelope);
}

sendControl(handle: RuntimeHandle, control: ControlPayload): void {
  const wsId = this.findWorkspaceByRun(handle.runId);
  if (wsId) this.pushWorkspaceControl(wsId, control);
}

cancel(handle: RuntimeHandle): void {
  this.sendControl(handle, { type: "cancel", commandId: randomUUID() });
  const wsId = this.findWorkspaceByRun(handle.runId);
  if (wsId) this.workspaceContainers.get(wsId)?.activeRuns.delete(handle.runId);
}

getHandle(runId: string): RuntimeHandle | undefined {
  const wsId = this.findWorkspaceByRun(runId);
  if (!wsId) return undefined;
  const state = this.workspaceContainers.get(wsId)!;
  return { runId, providerType: "docker", runtimeId: state.containerId, threadId: "" };
}

getStateByWorkspaceId(workspaceId: string): { containerId: string } | undefined {
  const s = this.workspaceContainers.get(workspaceId);
  return s ? { containerId: s.containerId } : undefined;
}

heartbeat(runId: string): void {
  const wsId = this.findWorkspaceByRun(runId);
  if (wsId) this.heartbeats.beat(wsId);
}

heartbeatWorkspace(workspaceId: string): void {
  this.heartbeats.beat(workspaceId);
}

cleanup(runId: string): void {
  const wsId = this.findWorkspaceByRun(runId);
  if (wsId) this.workspaceContainers.get(wsId)?.activeRuns.delete(runId);
  this.runConfigStore.unregister(runId);
  this.controlQueue.cleanup(runId);
}

shutdownContainer(workspaceId: string): void {
  const state = this.workspaceContainers.get(workspaceId);
  if (!state) return;
  this.heartbeats.stop(workspaceId);
  if (state.containerId) this.stopContainerOrKill(state.containerId, "workspace shutdown container");
  this.runtimeAccess.revokeWorkspace(workspaceId);
  this.controlQueue.cleanupWorkspace(workspaceId);
  this.controlSeqs.delete(workspaceId);
  this.workspaceContainers.delete(workspaceId);
}

private findWorkspaceByRun(runId: string): string | undefined {
  for (const [wsId, state] of this.workspaceContainers) {
    if (state.activeRuns.has(runId)) return wsId;
  }
  return undefined;
}
```

`startContainer` 改签名 `(workspaceId, image, hostPath, apiBase, accessKey)`，args 改为：

```ts
const args = [
  "run", "-d", "--init",
  "--name", `agework-ws-${workspaceId}`,
  "-e", "RUNTIME_TRANSPORT=http",
  "-e", `PLATFORM_API_BASE=${apiBase}`,
  "-e", `AGEWORK_RUNTIME_ACCESS_KEY=${accessKey}`,
  "-e", `AGEWORK_WORKSPACE_ID=${workspaceId}`,
];
if (hostPath) {
  this.assertSafeMountPath(hostPath);
  args.push("-v", `${hostPath}:/workspace`);
}
args.push(image);
```

> 去掉 `--rm` 和 `AGEWORK_RUN_ID`。`HeartbeatWatchdog` 现在的 key 是 workspaceId 而非 runId（用法不变，只是 key 含义变了）。

- [ ] **Step 4: 运行确认通过 + typecheck**

Run: `pnpm test:api -- docker-runtime-provider.spec.ts` Expected: PASS
Run: `pnpm typecheck` Expected: 通过（`RuntimeProvider` 接口的 `shutdownContainer?`/`getStateByWorkspaceId?`/`heartbeatWorkspace?` 现在被 docker 实现）。

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/runtime/providers/docker-runtime-provider.ts apps/api/src/runtime/providers/docker-runtime-provider.spec.ts
git commit -m "feat(runtime): workspace-level persistent docker containers with concurrent runs"
```

---

## Phase 4 — Worker 多路复用

### Task 6: RunMultiplexer 纯单元

**Files:**
- Create: `apps/worker/src/run-multiplexer.ts`
- Test: `apps/worker/src/run-multiplexer.spec.ts`

**职责：** 持有一个 adapter，维护 `runs: Map<runId, Subscription>`，每个 run 的事件按自己的 runId 回报；run 完成/出错从 map 移除；按 threadId 精确 cancel。与传输/HTTP 解耦，便于单测。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, vi } from "vitest";
import { Observable } from "rxjs";
import { RunMultiplexer } from "./run-multiplexer";

function fakeAdapter() {
  const subjects = new Map<string, { next: (e: unknown) => void; complete: () => void; error: (e: Error) => void }>();
  const interrupt = vi.fn().mockResolvedValue(undefined);
  const adapter = {
    run: (input: any) =>
      new Observable((sub) => {
        subjects.set(input.threadId, {
          next: (e) => sub.next(e),
          complete: () => sub.complete(),
          error: (e) => sub.error(e),
        });
      }),
    interrupt,
  };
  return { adapter, subjects, interrupt };
}

it("emits events tagged with the run's runId", () => {
  const { adapter, subjects } = fakeAdapter();
  const emit = vi.fn();
  const status = vi.fn();
  const mux = new RunMultiplexer(adapter as never, emit, status);

  mux.startRun("run-1", { threadId: "t-1" });
  subjects.get("t-1")!.next({ type: "X" });

  expect(emit).toHaveBeenCalledWith("run-1", { type: "X" });
});

it("runs two threads concurrently and isolates their events", () => {
  const { adapter, subjects } = fakeAdapter();
  const emit = vi.fn();
  const mux = new RunMultiplexer(adapter as never, emit, vi.fn());

  mux.startRun("run-1", { threadId: "t-1" });
  mux.startRun("run-2", { threadId: "t-2" });
  subjects.get("t-2")!.next({ type: "B" });
  subjects.get("t-1")!.next({ type: "A" });

  expect(emit).toHaveBeenCalledWith("run-2", { type: "B" });
  expect(emit).toHaveBeenCalledWith("run-1", { type: "A" });
  expect(mux.size()).toBe(2);
});

it("reports finished and drops the run on complete", () => {
  const { adapter, subjects } = fakeAdapter();
  const status = vi.fn();
  const mux = new RunMultiplexer(adapter as never, vi.fn(), status);

  mux.startRun("run-1", { threadId: "t-1" });
  subjects.get("t-1")!.complete();

  expect(status).toHaveBeenCalledWith("run-1", { status: "finished" });
  expect(mux.has("run-1")).toBe(false);
});

it("cancelRun interrupts only that thread", async () => {
  const { adapter, interrupt } = fakeAdapter();
  const mux = new RunMultiplexer(adapter as never, vi.fn(), vi.fn());

  mux.startRun("run-1", { threadId: "t-1" });
  await mux.cancelRun("run-1", "t-1");

  expect(interrupt).toHaveBeenCalledWith("t-1");
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @agework/worker test -- run-multiplexer.spec.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现**

```ts
import type { Subscription } from "rxjs";

type MinimalAdapter = {
  run(input: unknown): { subscribe(o: {
    next: (e: unknown) => void;
    complete: () => void;
    error: (e: Error) => void;
  }): Subscription };
  interrupt(threadId?: string): Promise<void>;
};

type StatusPayload =
  | { status: "finished" }
  | { status: "error"; error: string }
  | { status: "cancelled" };

export class RunMultiplexer {
  private readonly runs = new Map<string, { threadId: string; sub: Subscription }>();
  private readonly cancelled = new Set<string>();

  constructor(
    private readonly adapter: MinimalAdapter,
    private readonly emit: (runId: string, event: unknown) => void,
    private readonly reportStatus: (runId: string, payload: StatusPayload) => void
  ) {}

  startRun(runId: string, input: { threadId: string } & Record<string, unknown>): void {
    if (this.runs.has(runId)) return; // 去重
    const sub = this.adapter.run(input).subscribe({
      next: (event) => this.emit(runId, event),
      complete: () => {
        this.reportStatus(runId, this.cancelled.has(runId) ? { status: "cancelled" } : { status: "finished" });
        this.drop(runId);
      },
      error: (err: Error) => {
        this.reportStatus(runId, this.cancelled.has(runId) ? { status: "cancelled" } : { status: "error", error: err.message });
        this.drop(runId);
      },
    });
    this.runs.set(runId, { threadId: input.threadId, sub });
  }

  async cancelRun(runId: string, threadId: string): Promise<void> {
    this.cancelled.add(runId);
    await this.adapter.interrupt(threadId);
  }

  has(runId: string): boolean {
    return this.runs.has(runId);
  }

  size(): number {
    return this.runs.size;
  }

  private drop(runId: string): void {
    this.runs.delete(runId);
    this.cancelled.delete(runId);
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @agework/worker test -- run-multiplexer.spec.ts` Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/worker/src/run-multiplexer.ts apps/worker/src/run-multiplexer.spec.ts
git commit -m "feat(worker): add RunMultiplexer for concurrent runs"
```

---

### Task 7: 持久容器 HTTP 客户端

**Files:**
- Create: `apps/worker/src/persistent-http-client.ts`
- Test: `apps/worker/src/persistent-http-client.spec.ts`

**职责：** 封装持久容器 worker 的 HTTP 交互——按 workspaceId 轮询 controls、按 runId emit 事件、按 runId fetch RunConfig。与 `HttpTransport` 区别在于 controls 是 workspace 级、emit/fetch 带 runId 参数。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PersistentHttpClient } from "./persistent-http-client";

describe("PersistentHttpClient", () => {
  beforeEach(() => {
    vi.stubEnv("PLATFORM_API_BASE", "http://api");
    vi.stubEnv("AGEWORK_WORKSPACE_ID", "ws-1");
    vi.stubEnv("AGEWORK_RUNTIME_ACCESS_KEY", "ws-key");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("polls the workspace controls endpoint with afterSeq", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ controls: [{ seq: 3, payload: { type: "user_message", runId: "run-1" } }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new PersistentHttpClient();

    const controls = await client.pollControls();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://api/internal/workspaces/ws-1/controls?afterSeq=0",
      expect.objectContaining({ headers: { Authorization: "Bearer ws-key" } })
    );
    expect(controls[0].payload).toMatchObject({ type: "user_message", runId: "run-1" });
    // 下一次 poll 用更新后的 afterSeq
    await client.pollControls();
    expect(fetchMock).toHaveBeenLastCalledWith(
      "http://api/internal/workspaces/ws-1/controls?afterSeq=3",
      expect.anything()
    );
  });

  it("fetches run config by runId", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ config: { runId: "run-1", threadId: "t-1" } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new PersistentHttpClient();

    const config = await client.fetchRunConfig("run-1");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://api/internal/runs/run-1",
      expect.objectContaining({ headers: { Authorization: "Bearer ws-key" } })
    );
    expect(config).toMatchObject({ runId: "run-1" });
  });

  it("emits an event to the run's events endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const client = new PersistentHttpClient();

    await client.emit("run-1", { runId: "run-1", seq: 0, type: "agui.event", payload: { type: "X" }, ts: "" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://api/internal/runs/run-1/events",
      expect.objectContaining({ method: "POST" })
    );
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @agework/worker test -- persistent-http-client.spec.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 实现**

```ts
import type { RunConfig, ControlPayload, Envelope, UpstreamMessage } from "@agework/shared/protocol";

export class PersistentHttpClient {
  private readonly apiBase: string;
  private readonly workspaceId: string;
  private readonly accessKey: string;
  private controlSeq = 0;

  constructor() {
    this.apiBase = process.env.PLATFORM_API_BASE ?? "http://localhost:3000";
    this.workspaceId = process.env.AGEWORK_WORKSPACE_ID ?? "";
    this.accessKey = process.env.AGEWORK_RUNTIME_ACCESS_KEY ?? "";
    if (!this.workspaceId) throw new Error("AGEWORK_WORKSPACE_ID is required for persistent worker");
    if (!this.accessKey) throw new Error("AGEWORK_RUNTIME_ACCESS_KEY is required for persistent worker");
  }

  private get authHeaders() {
    return { Authorization: `Bearer ${this.accessKey}` };
  }

  async pollControls(): Promise<Envelope<ControlPayload>[]> {
    const url = `${this.apiBase}/internal/workspaces/${this.workspaceId}/controls?afterSeq=${this.controlSeq}`;
    const res = await fetch(url, { headers: this.authHeaders });
    if (!res.ok) {
      if (res.status === 401) { console.error("Runtime access key invalid, exiting"); process.exit(1); }
      return [];
    }
    const data = (await res.json()) as { controls: Envelope<ControlPayload>[] };
    for (const c of data.controls) if (c.seq > this.controlSeq) this.controlSeq = c.seq;
    return data.controls;
  }

  async fetchRunConfig(runId: string): Promise<RunConfig> {
    const res = await fetch(`${this.apiBase}/internal/runs/${runId}`, { headers: this.authHeaders });
    if (!res.ok) throw new Error(`Failed to fetch run config: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { config: RunConfig };
    return data.config;
  }

  async emit(runId: string, msg: UpstreamMessage): Promise<void> {
    await fetch(`${this.apiBase}/internal/runs/${runId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.authHeaders },
      body: JSON.stringify(msg),
    }).catch(() => {});
  }
}
```

> MVP 先不抄 `HttpTransport` 的重试逻辑（emit 失败吞掉）。若验证阶段发现丢事件再补重试。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @agework/worker test -- persistent-http-client.spec.ts` Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/worker/src/persistent-http-client.ts apps/worker/src/persistent-http-client.spec.ts
git commit -m "feat(worker): add persistent HTTP client for workspace containers"
```

---

### Task 8: main.ts 接入持久多路复用路径

**Files:**
- Modify: `apps/worker/src/main.ts`

**判定：** 当 `RUNTIME_TRANSPORT === "http"` 且存在 `AGEWORK_WORKSPACE_ID` 时走持久路径；否则保留现有单 run 路径（IPC / 旧 HTTP 单 run）不动。

- [ ] **Step 1: 实现持久入口**

在 `main.ts` 顶部 `main()` 内分流（保留现有 `main()` 逻辑作为 `runSingle()`，新增 `runPersistent()`）：

```ts
async function main() {
  if (process.env.RUNTIME_TRANSPORT === "http" && process.env.AGEWORK_WORKSPACE_ID) {
    return runPersistent();
  }
  return runSingle(); // 现有逻辑整体抽到 runSingle()
}
```

`runPersistent()`：

```ts
async function runPersistent() {
  const client = new PersistentHttpClient();
  let adapter: ReturnType<typeof createAdapter> | undefined;

  const mux = new RunMultiplexer(
    {
      run: (input) => adapter!.run(input as Parameters<NonNullable<typeof adapter>["run"]>[0]),
      interrupt: (threadId) => adapter!.interrupt(threadId),
    },
    (runId, event) => {
      void client.emit(runId, { runId, seq: 0, type: "agui.event", payload: event as AGUIEvent, ts: "" });
    },
    (runId, payload) => {
      void client.emit(runId, { runId, seq: 0, type: "run.status", payload, ts: "" });
    }
  );

  const processed = new Set<string>();

  // 心跳：容器存活就一直发（任选一个 runId 或省略 runId 由 API 端按 workspace 计；
  // 简化用一个固定 heartbeat 端点——见下方说明）
  setInterval(() => {
    void client.emitWorkspaceHeartbeat?.();
  }, HEARTBEAT_INTERVAL_MS);

  // 轮询控制
  for (;;) {
    const controls = await client.pollControls();
    for (const env of controls) {
      const c = env.payload;
      if (processed.has(c.commandId)) continue;
      processed.add(c.commandId);
      if (c.type === "user_message") {
        const config = await client.fetchRunConfig(c.runId);
        if (!adapter) adapter = createAdapter(config, undefined as never); // adapter 只建一次
        mux.startRun(c.runId, config.input as { threadId: string });
      } else if (c.type === "cancel") {
        const threadId = mux.threadIdOf?.(/* runId 未知，cancel 控制需带 runId/threadId */);
        // 见下方说明：cancel 控制需要带 runId
      } else if (c.type === "approval_resolved") {
        resolveQuestion(c.threadId, c.answers);
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
}
```

> **两个收尾点（实现时必须处理，否则功能不完整）：**
> 1. **cancel 控制需带 runId+threadId**：`ControlPayload.cancel` 当前只有 `commandId`。在 `transport.ts` 给 `cancel` 加可选 `runId?: string; threadId?: string`，docker provider 的 `cancel()` push 时带上（它有 handle.runId / handle.threadId），worker 据此调用 `mux.cancelRun(runId, threadId)`。
> 2. **createAdapter 的 transport 依赖**：现有 `createAdapter` 用 `transport.emit` 做 `pendingActionSink`。持久路径要把 `pendingActionSink` 改成 `(runId)=>client.emit(runId, run.status...)`。给 `createAdapter` 增加一个 `emitStatus: (runId, payload)=>void` 注入参数，单 run 路径传基于 transport 的版本、持久路径传基于 client 的版本。pendingActionSink 需要知道当前 runId——由 adapter 的 input.runId 透传（adapter 的 `pendingActionSink` 事件含 threadId，可由 mux 维护 threadId→runId 反查后 emit）。
> 3. **心跳端点**：API 侧 `RuntimeWorkspaceController` 增加 `POST /internal/workspaces/:workspaceId/heartbeat` → `provider.heartbeatWorkspace(workspaceId)`；`PersistentHttpClient` 增加 `emitWorkspaceHeartbeat()` 打这个端点。

- [ ] **Step 2: typecheck + worker 单测回归**

Run: `pnpm typecheck` Expected: 通过。
Run: `pnpm --filter @agework/worker test` Expected: 既有 + 新增测试全过。

- [ ] **Step 3: 提交**

```bash
git add apps/worker/src/main.ts packages/shared/src/protocol/transport.ts apps/api/src/runtime/internal/runtime-workspace.controller.ts apps/worker/src/persistent-http-client.ts
git commit -m "feat(worker): wire persistent multiplexer worker path"
```

---

## Phase 5 — Resume 打通 + 孤儿回收

### Task 9: 去掉 docker resume 限制

**Files:**
- Modify: `apps/api/src/agent/agent-run-handler.ts:115-123`
- Test: `apps/api/src/agent/agent-run-handler.spec.ts`

- [ ] **Step 1: 写失败测试**

`agent-run-handler.spec.ts` 已有「passes resume props when the thread has an agentResumeId」用例。新增 docker 场景：

```ts
it("passes resume for docker provider too", async () => {
  // 构造 thread 带 agentResumeId、workspaceInfo.runtimeProvider = "docker"
  // 断言传给 runConfigBuilder 的 input.forwardedProps.resume === agentResumeId
  // （沿用该文件已有的 mock 装配方式）
  // expect(capturedInput.forwardedProps.resume).toBe("session-1");
});
```

> 按该 spec 现有的 mock 风格补全（mock `threadService.getWorkspaceInfo` 返回 `{ runtimeProvider: "docker", rootPath: "/tmp/ws" }`，捕获 `runConfigBuilder.buildRunConfig` 的入参）。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test:api -- agent-run-handler.spec.ts`
Expected: FAIL — docker 下 resume 未透传。

- [ ] **Step 3: 实现**

`agent-run-handler.ts` 把：

```ts
if (agentResumeId) {
  forwardedProps.agentResumeId = agentResumeId;
  const providerType = runtimeProvider ?? this.configService.getDefaultRuntimeProviderType();
  if (agentType === "claude" && providerType !== "docker") {
    forwardedProps.resume = agentResumeId;
  }
}
```

改成：

```ts
if (agentResumeId) {
  forwardedProps.agentResumeId = agentResumeId;
  if (agentType === "claude") {
    forwardedProps.resume = agentResumeId;
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test:api -- agent-run-handler.spec.ts` Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/agent/agent-run-handler.ts apps/api/src/agent/agent-run-handler.spec.ts
git commit -m "feat(runtime): enable resume for docker persistent containers"
```

---

### Task 10: 孤儿容器回收扫描 agework-ws-*

**Files:**
- Modify: `apps/api/src/runtime/core/run-recovery.service.ts`
- Test: `apps/api/src/runtime/core/run-recovery.service.spec.ts`

- [ ] **Step 1: 写失败测试**

沿用该 spec 现有风格（mock execFile / provider.recoverOrphan）。新增：

```ts
it("stops orphaned agework-ws-* containers on recovery", async () => {
  // mock `docker ps --filter name=agework-ws- --format {{.Names}}` 返回两行容器名
  // 断言对每个容器调用了 docker stop（或 provider.recoverOrphan）
});
```

> 具体断言按该文件已有 mock 装配；核心：`recoverOrphanRuns()` 调用一次 `docker ps --filter name=agework-ws-`，对返回的每个容器执行停止。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test:api -- run-recovery.service.spec.ts`
Expected: FAIL — 未扫描 ws 容器。

- [ ] **Step 3: 实现**

在 `recoverOrphanRuns()` 末尾（或独立私有方法 `recoverOrphanContainers()`）增加：

```ts
private async recoverOrphanContainers(): Promise<void> {
  try {
    const { stdout } = await execFileAsync("docker", [
      "ps", "-a", "--filter", "name=agework-ws-", "--format", "{{.Names}}",
    ]);
    const names = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    for (const name of names) {
      await this.dockerProvider.recoverOrphan(name);
    }
  } catch (err) {
    this.logger.warn(`recover orphan containers failed: ${String(err)}`);
  }
}
```

并在 `recoverOrphanRuns()` 调用它。`recoverOrphan(name)` 已能 stop→kill（容器名即可作为 docker stop 目标）。

> 若 `RunRecoveryService` 当前未注入 `DockerRuntimeProvider`/execFile，按该服务现有依赖装配补上（参考 docker-provider 的 `execFileAsync` 用法）。相关 run 标记 error 复用现有 `markError` 逻辑。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test:api -- run-recovery.service.spec.ts` Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/runtime/core/run-recovery.service.ts apps/api/src/runtime/core/run-recovery.service.spec.ts
git commit -m "feat(runtime): recover orphaned workspace containers on restart"
```

---

## Phase 6 — 全量验证

### Task 11: 集成与手动验证

**Files:** 无（执行验证清单）

- [ ] **Step 1: 全量类型检查与单测**

Run: `pnpm typecheck` Expected: 通过
Run: `pnpm test:api` Expected: 全绿
Run: `pnpm --filter @agework/worker test` Expected: 全绿

- [ ] **Step 2: 构建 worker 镜像并起服务**

Run: `pnpm build`（确保 worker 镜像/产物可用）；本地起后端，配置某 workspace 的 `runtimeProvider = "docker"`。

- [ ] **Step 3: 手动验证（对照 spec「验证」节）**

- [ ] 同一 thread 连发两条消息，第二条能 resume（容器内 adapter session 保持；观察无 "No conversation found"）。
- [ ] 同一 workspace 两个不同 thread **同时**发 run，能并行执行，两个对话事件按各自 runId 正确回报、互不阻塞（`docker ps` 只有一个 `agework-ws-*` 容器）。
- [ ] 并行两个 run 各自 cancel 互不影响，且 `docker ps` 容器仍在。
- [ ] 删除 workspace → 对应 `agework-ws-*` 容器被 stop+rm。
- [ ] 重启后端服务 → 残留 `agework-ws-*` 容器被清理，相关 run 标记 error。
- [ ] Local 模式（`runtimeProvider = "local"`）连发消息、resume 正常，不受影响。

- [ ] **Step 4: 提交（若有验证期修复）**

```bash
git add -A
git commit -m "test: verify docker persistent concurrent containers"
```

---

## Self-Review 备注（写计划时已核对）

- **Spec 覆盖：** 容器粒度(Task5)、并行多 thread(Task5/6/8)、共享 fs(无需代码，设计接受)、复用方式(Task5/6/8)、Resume 两层(Task9 + 容器持久=Task5)、Worker 多路复用(Task6/8)、HttpTransport workspace 级(Task7)、Provider 改造(Task5)、Runner(无门控可删，已确认现状无 409，故无对应任务)、AgentRunHandler resume(Task9)、控制队列/端点 workspace 级(前置已完成)、接口扩展(Task2)、孤儿回收(Task10)、Access Key workspace 级(Task4)。
- **已知需在 Task8 收尾的两处协议补强：** `ControlPayload.cancel` 加 `runId?/threadId?`；`createAdapter` 的 `pendingActionSink`/`emitStatus` 注入改造 + workspace 心跳端点。这些在 Task8 的「收尾点」明确列出，非 placeholder。
- **类型一致性：** `workspaceId`、`DockerWorkspaceState.activeRuns`、`pushForWorkspace`、`issueWorkspaceKey/registerRun/verifyWorkspaceKey/revokeWorkspace`、`RunMultiplexer.startRun/cancelRun/has/size`、`interrupt(threadId?)` 跨任务命名统一。
