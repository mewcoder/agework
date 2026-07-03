# Runtime Provider 注册表 + Worker Provisioner(计划一)实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 worker-manager 里两个复制粘贴的实例 executor 换成"runtime 侧 `RuntimeProvider` 注册表 + worker-manager 侧唯一泛型 `WorkerProvisioner`",顺带砍掉空闲回收复杂度、收窄 `AcquireInstanceResult` 契约。

**Architecture:** runtime 模块新增 `RuntimeProvider` 接口(prepareEnvironment/launchWorker/teardown/recoverOrphan)+ 按 `runtimeType` 注册的 `RuntimeProviderRegistry`;`LocalRuntimeProvider` 与新 `SandboxRuntimeProvider` 实现它,`RuntimeService` 泛型转发。worker-manager 把两个 executor 复制的启动握手序列抽成唯一泛型 `WorkerProvisioner`,门面去 `runtimeType` 分支。本计划**不改** `runtimeType` 域值(仍 `local|sandbox`);flat 化(→docker|opensandbox)是后续计划二。

**Tech Stack:** NestJS 11、Prisma、Vitest、pnpm workspace、`@agework/shared`。

## Global Constraints

- 后端命名/架构规则:`.claude/rules/backend-naming.md`、`.claude/rules/backend-architecture.md`。root 白名单、internal provider 不 export、`Provider` 例外沿用 runtime 模块既有 `LocalRuntimeProvider` 命名。
- `runtimeType` 值域本计划保持 `"local" | "sandbox"` 不变。engine(`docker|opensandbox`)仍是 sandbox 内部细节。
- 验证每个任务后跑:`pnpm --filter server typecheck` + 相关 `*.spec`;计划末尾跑 `pnpm typecheck` + `pnpm test:server` + eslint(type-aware,不能只信 tsc)。
- 反向依赖纪律:`worker-manager → runtime` 单向;`runtime` 不依赖 worker-manager。
- 不实现 `pause`;`recoverOrphan?` 为 optional。
- 命令:`pnpm --filter server test -- <spec-file>` 跑单个 spec。

---

## 文件结构(计划一)

**runtime 模块(新增/改)**
- Create `apps/server/src/runtime/runtime-provider.ts` — `RuntimeProvider` 接口 + `RuntimeLaunchContext`/`RuntimeEnvHandle`/`RuntimeInstanceRef` 类型 + `RUNTIME_PROVIDERS` token。
- Create `apps/server/src/runtime/runtime-provider.registry.ts` — `RuntimeProviderRegistry`(`resolve(type)`)。
- Modify `apps/server/src/runtime/local/local-runtime.provider.ts` — implements `RuntimeProvider`。
- Create `apps/server/src/runtime/sandbox/sandbox-runtime.provider.ts` — `SandboxRuntimeProvider` implements `RuntimeProvider`,内部按 placement 的 engine 调 `SandboxEngine`(收编原 executor 的 `buildSandboxStartInput`/create/resume/stop)。
- Modify `apps/server/src/runtime/runtime.service.ts` — 加泛型 `prepareEnvironment/launchWorker/teardown/recoverOrphan`,删旧 `startSandbox/resumeSandbox/stopSandbox/launchLocal/recoverOrphanLocal`。
- Modify `apps/server/src/runtime/runtime.module.ts` — 注册 registry + providers + `RUNTIME_PROVIDERS`。

**worker-manager 模块(新增/改/删)**
- Create `apps/server/src/worker-manager/instance/worker.provisioner.ts` — `WorkerProvisioner`。
- Modify `apps/server/src/worker-manager/worker-manager.service.ts` — 注入 provisioner,rewire `resolveInstance`/`releaseInstanceForRun`/`shutdownInstanceByOwnerId`/`fenceOwner`/`stopRuntimeInstance`;删两 executor 注入。
- Modify `apps/server/src/worker-manager/worker-manager.module.ts` — 删两 executor,加 provisioner。
- Modify `apps/server/src/worker-manager/lifecycle/lifecycle.service.ts` — `shutdownResource` 与 bootstrap 改用 provisioner(不再注入两 executor)。
- Modify `apps/server/src/worker-manager/registry/worker-registry.repository.ts` — `findActiveByOwnerId` 的 `select` 补 `runtimeInstanceId`/`isolationScope`/`ownerId`(供 teardown ref 与 fence 用)。
- Delete `apps/server/src/worker-manager/sandbox-instance/`(executor + spec)。
- Delete `apps/server/src/worker-manager/local-instance/`(executor + spec)。

**shared + run**
- Modify `packages/shared/src/protocol/channel.ts` — `AcquireInstanceResult` 删 `cancelledBeforeReady`。
- Modify `apps/server/src/run/execution/worker-run.executor.ts` — 删 `cancelledBeforeReady` 分支。
- Modify `apps/server/src/run/execution/worker-run.executor.spec.ts` — 去掉对该 outcome 的 mock 依赖(如需)。

---

## Phase A — runtime provider 抽象

### Task 1: RuntimeProvider 接口与契约类型

**Files:**
- Create: `apps/server/src/runtime/runtime-provider.ts`

**Interfaces:**
- Produces:
  - `RuntimeLaunchContext { runtimeType: string; ownerId: string; workspaceId: string; runId: string; placement: RuntimePlacement; workerEnv: Record<string,string> }`
  - `RuntimeEnvHandle { runtimeInstanceId?: string }`
  - `RuntimeInstanceRef { runtimeType: string; ownerId: string; runtimeInstanceId: string; isolationScope: string }`
  - `interface RuntimeProvider { readonly type: string; readonly placementKind: "container"|"process"; prepareEnvironment(ctx): Promise<RuntimeEnvHandle>; launchWorker(ctx, env): Promise<{runtimeInstanceId:string}>; teardown(ref): Promise<void>|void; recoverOrphan?(ref): Promise<void>|void }`
  - `const RUNTIME_PROVIDERS: unique symbol`

- [ ] **Step 1: 写接口文件**

```ts
// apps/server/src/runtime/runtime-provider.ts
import type { RuntimePlacement } from "@agework/shared/protocol";

/** provisioner 交给 provider 的一次启动上下文。workerEnv 是共享的 worker 协议
 *  env（AGEWORK_WORKER_* + startToken），provider 内部再合并自己的 infra env。 */
export type RuntimeLaunchContext = {
  runtimeType: string;
  ownerId: string;
  workspaceId: string;
  runId: string;
  placement: RuntimePlacement;
  workerEnv: Record<string, string>;
};

/** prepareEnvironment 的产物：container 返回容器 id，process 返回空。 */
export type RuntimeEnvHandle = { runtimeInstanceId?: string };

/** 停止/回收一个实例所需的最小信息，由调用方从 WorkerRegistry DB 行派生。 */
export type RuntimeInstanceRef = {
  runtimeType: string;
  ownerId: string;
  runtimeInstanceId: string;
  isolationScope: string;
};

/** 某一 runtimeType 的运行形态：自声明类型 + 备环境/拉 worker/拆除/回收孤儿。 */
export interface RuntimeProvider {
  readonly type: string;
  readonly placementKind: "container" | "process";
  prepareEnvironment(ctx: RuntimeLaunchContext): Promise<RuntimeEnvHandle>;
  launchWorker(
    ctx: RuntimeLaunchContext,
    env: RuntimeEnvHandle
  ): Promise<{ runtimeInstanceId: string }>;
  teardown(ref: RuntimeInstanceRef): Promise<void> | void;
  recoverOrphan?(ref: RuntimeInstanceRef): Promise<void> | void;
}

export const RUNTIME_PROVIDERS = Symbol("RUNTIME_PROVIDERS");
```

- [ ] **Step 2: typecheck**

Run: `pnpm --filter server typecheck`
Expected: PASS(新文件无被引用,单独编译通过)。

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/runtime/runtime-provider.ts
git commit -m "feat(runtime): add RuntimeProvider interface and launch context types"
```

### Task 2: RuntimeProviderRegistry

**Files:**
- Create: `apps/server/src/runtime/runtime-provider.registry.ts`
- Test: `apps/server/src/runtime/runtime-provider.registry.spec.ts`

**Interfaces:**
- Consumes: `RuntimeProvider`, `RUNTIME_PROVIDERS`(Task 1)。
- Produces: `class RuntimeProviderRegistry { resolve(type: string): RuntimeProvider }`。

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/src/runtime/runtime-provider.registry.spec.ts
import { describe, it, expect } from "vitest";
import { RuntimeProviderRegistry } from "./runtime-provider.registry";
import type { RuntimeProvider } from "./runtime-provider";

const fake = (type: string): RuntimeProvider => ({
  type,
  placementKind: "process",
  prepareEnvironment: async () => ({}),
  launchWorker: async () => ({ runtimeInstanceId: "x" }),
  teardown: () => {},
});

describe("RuntimeProviderRegistry", () => {
  it("resolves a registered provider by type", () => {
    const reg = new RuntimeProviderRegistry([fake("local"), fake("sandbox")]);
    expect(reg.resolve("sandbox").type).toBe("sandbox");
  });

  it("throws on unknown type", () => {
    const reg = new RuntimeProviderRegistry([fake("local")]);
    expect(() => reg.resolve("nope")).toThrow(/Unknown runtime provider/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter server test -- runtime-provider.registry.spec.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 写实现**

```ts
// apps/server/src/runtime/runtime-provider.registry.ts
import { Inject, Injectable } from "@nestjs/common";
import {
  RUNTIME_PROVIDERS,
  type RuntimeProvider,
} from "./runtime-provider";

/** 按 runtimeType 注册 provider 的多态实现表;加一种 runtime = 新增 provider 并进
 *  module providers/RUNTIME_PROVIDERS inject 数组,零 switch。 */
@Injectable()
export class RuntimeProviderRegistry {
  private readonly map: Map<string, RuntimeProvider>;

  constructor(@Inject(RUNTIME_PROVIDERS) providers: RuntimeProvider[]) {
    this.map = new Map(providers.map((p) => [p.type, p]));
  }

  resolve(type: string): RuntimeProvider {
    const provider = this.map.get(type);
    if (!provider) {
      throw new Error(`Unknown runtime provider: ${type}`);
    }
    return provider;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter server test -- runtime-provider.registry.spec.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/runtime/runtime-provider.registry.ts apps/server/src/runtime/runtime-provider.registry.spec.ts
git commit -m "feat(runtime): add RuntimeProviderRegistry keyed by runtimeType"
```

### Task 3: LocalRuntimeProvider 实现 RuntimeProvider

**Files:**
- Modify: `apps/server/src/runtime/local/local-runtime.provider.ts`
- Test: `apps/server/src/runtime/local/local-runtime.provider.spec.ts`(已存在,补用例)

**Interfaces:**
- Consumes: `RuntimeProvider`,现有 `launch(input: LocalLaunchInput): LocalInstanceHandle`、`recoverOrphan(runtimeInstanceId): Promise<void>`。
- Produces: `LocalRuntimeProvider` 现在满足 `RuntimeProvider`(`type="local"`, `placementKind="process"`)。

现状:`LocalRuntimeProvider` 有 `launch(input)`(fork,返回 `{ runtimeInstanceId: \`${pid}:${token}\`, channel }`)与 `recoverOrphan(runtimeInstanceId)`。本任务在其上加接口方法;`launch/recoverOrphan` 内部实现保留(供接口方法调用)。local 的进程句柄 `channel` 现在由 provider 自己持有(owner→channel),供 teardown kill 与 exit 监听——这段逻辑从被删的 `LocalInstanceExecutor` 迁进来。

- [ ] **Step 1: 写失败测试(接口形状)**

在 `local-runtime.provider.spec.ts` 追加:

```ts
it("implements RuntimeProvider surface (type/placementKind)", () => {
  const provider = new LocalRuntimeProvider();
  expect(provider.type).toBe("local");
  expect(provider.placementKind).toBe("process");
});

it("prepareEnvironment is a no-op returning empty handle", async () => {
  const provider = new LocalRuntimeProvider();
  await expect(
    provider.prepareEnvironment({
      runtimeType: "local",
      ownerId: "ws-1",
      workspaceId: "ws-1",
      runId: "run-1",
      placement: {
        runtimeType: "local",
        userId: "u1",
        workspaceId: "ws-1",
        hostPath: "/w",
        runtimePath: "/w",
        runtimeLogDir: "/logs",
      },
      workerEnv: {},
    })
  ).resolves.toEqual({});
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter server test -- local-runtime.provider.spec.ts`
Expected: FAIL(`type`/`placementKind`/`prepareEnvironment` 不存在)。

- [ ] **Step 3: 实现接口方法**

在 `LocalRuntimeProvider` 顶部加 `implements RuntimeProvider` 与 owner→channel map,并加四个接口方法。`launchWorker` 复用现有 `launch`,把 `ctx.workerEnv` 当 env 传入,并接管进程句柄:

```ts
// import 补:
import {
  type RuntimeProvider,
  type RuntimeLaunchContext,
  type RuntimeEnvHandle,
  type RuntimeInstanceRef,
} from "../runtime-provider";
import type { ChildProcess } from "node:child_process";
import { swallow } from "../../common/swallow";
import { safeLogJson } from "../../common/logging";

// 类声明改为:
export class LocalRuntimeProvider implements RuntimeProvider {
  readonly type = "local";
  readonly placementKind = "process" as const;
  private readonly channels = new Map<string, ChildProcess>();
  // ...(保留现有 logger / launch / recoverOrphan)

  async prepareEnvironment(_ctx: RuntimeLaunchContext): Promise<RuntimeEnvHandle> {
    return {};
  }

  async launchWorker(
    ctx: RuntimeLaunchContext,
    _env: RuntimeEnvHandle
  ): Promise<{ runtimeInstanceId: string }> {
    const { runtimeInstanceId, channel } = this.launch({
      runId: ctx.runId,
      env: ctx.workerEnv,
    });
    this.channels.set(ctx.ownerId, channel);
    channel.on("exit", () => this.channels.delete(ctx.ownerId));
    return { runtimeInstanceId };
  }

  teardown(ref: RuntimeInstanceRef): void {
    const channel = this.channels.get(ref.ownerId);
    if (channel && !channel.killed) {
      try {
        channel.kill("SIGTERM");
      } catch (err) {
        this.logger.warn(
          `terminate local worker failed ${safeLogJson({ ownerId: ref.ownerId, error: err instanceof Error ? err.message : String(err) })}`
        );
      }
    }
    this.channels.delete(ref.ownerId);
  }

  recoverOrphan(ref: RuntimeInstanceRef): Promise<void> {
    // 保留原按 pid 杀孤儿逻辑;把原 recoverOrphan(runtimeInstanceId) 改名为
    // 私有并由此调用,或直接内联:入参从 ref.runtimeInstanceId 取 pid。
    return this.recoverOrphanByInstanceId(ref.runtimeInstanceId);
  }
}
```

> 说明:把现有的 `recoverOrphan(runtimeInstanceId: string)` 改名为私有 `recoverOrphanByInstanceId(runtimeInstanceId: string)`,`launch(input)` 保持不变(仍被 `launchWorker` 调用)。原来 `runtime.service.ts` 里 `launchLocal`/`recoverOrphanLocal` 的调用点会在 Task 5 一并改掉。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter server test -- local-runtime.provider.spec.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/runtime/local/local-runtime.provider.ts apps/server/src/runtime/local/local-runtime.provider.spec.ts
git commit -m "feat(runtime): make LocalRuntimeProvider implement RuntimeProvider"
```

### Task 4: SandboxRuntimeProvider(收编原 sandbox executor 的物理编排)

**Files:**
- Create: `apps/server/src/runtime/sandbox/sandbox-runtime.provider.ts`
- Test: `apps/server/src/runtime/sandbox/sandbox-runtime.provider.spec.ts`

**Interfaces:**
- Consumes: `SANDBOX_ENGINES`/`SandboxEngine`(现有)、`SandboxStartInput`/`SandboxRuntime`(runtime.types)、`RuntimeProvider` 契约。
- Produces: `SandboxRuntimeProvider`(`type="sandbox"`, `placementKind="container"`)。

职责:`prepareEnvironment` = 按 `placement.sandbox.sandboxEngineType` 取引擎,`getOrCreate`(必要时 `resume`)容器 + `startWorker`,返回 `{runtimeInstanceId}`;`launchWorker` = no-op 回传 `env.runtimeInstanceId`;`teardown(ref)` = 取引擎 `stop(ref.runtimeInstanceId)`。engine 从 placement 取(本计划 engine 仍在 placement 里;teardown-by-ref 的 engine 缺口与现状一致,计划二 flat 化后由 runtimeType 补齐)。`buildSandboxStartInput`(从被删的 `sandbox-instance.executor.ts:437-485` 迁入)负责把 `ctx.placement` + `ctx.workerEnv` + 引擎 infra env 合成 `SandboxStartInput`。

- [ ] **Step 1: 写失败测试**

```ts
// apps/server/src/runtime/sandbox/sandbox-runtime.provider.spec.ts
import { describe, it, expect, vi } from "vitest";
import { SandboxRuntimeProvider } from "./sandbox-runtime.provider";
import type { SandboxEngine } from "./sandbox-engine";
import type { RuntimeLaunchContext } from "../runtime-provider";

const engine = (type: "docker" | "opensandbox"): SandboxEngine => ({
  type,
  getOrCreate: vi.fn().mockResolvedValue({ engineType: type, runtimeInstanceId: "c1", workspaceMountPath: "/w" }),
  startWorker: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
});

const ctx = (): RuntimeLaunchContext => ({
  runtimeType: "sandbox",
  ownerId: "ws-1",
  workspaceId: "ws-1",
  runId: "run-1",
  placement: {
    runtimeType: "sandbox",
    userId: "u1",
    workspaceId: "ws-1",
    hostPath: "/host",
    runtimePath: "/rt",
    runtimeLogDir: "/logs",
    sandbox: { isolationScope: "workspace", mountTarget: "/rt", sandboxEngineType: "docker" },
  },
  workerEnv: { AGEWORK_WORKER_OWNER_ID: "ws-1" },
});

const cfg = { getRuntimeLogDir: () => "/host/logs" } as any;

describe("SandboxRuntimeProvider", () => {
  it("declares container placement", () => {
    const p = new SandboxRuntimeProvider(cfg, [engine("docker")]);
    expect(p.type).toBe("sandbox");
    expect(p.placementKind).toBe("container");
  });

  it("prepareEnvironment creates container + starts worker via engine", async () => {
    const docker = engine("docker");
    const p = new SandboxRuntimeProvider(cfg, [docker]);
    const handle = await p.prepareEnvironment(ctx());
    expect(docker.getOrCreate).toHaveBeenCalledOnce();
    expect(docker.startWorker).toHaveBeenCalledOnce();
    expect(handle.runtimeInstanceId).toBe("c1");
  });

  it("launchWorker echoes the prepared instance id", async () => {
    const p = new SandboxRuntimeProvider(cfg, [engine("docker")]);
    const res = await p.launchWorker(ctx(), { runtimeInstanceId: "c1" });
    expect(res.runtimeInstanceId).toBe("c1");
  });

  it("teardown stops via the engine", async () => {
    const docker = engine("docker");
    const p = new SandboxRuntimeProvider(cfg, [docker]);
    await p.teardown({ runtimeType: "sandbox", ownerId: "ws-1", runtimeInstanceId: "c1", isolationScope: "workspace" });
    expect(docker.stop).toHaveBeenCalledWith("c1");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter server test -- sandbox-runtime.provider.spec.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 写实现**

从被删 `sandbox-instance.executor.ts` 迁 `buildSandboxStartInput`(行 437-485)与 create/resume/stop 时序(参考 `runtime.service.ts` 原 `startSandbox`)。engine 由 placement 取。teardown 的 engine:本计划从 placement 无法拿(ref 无 placement),故 teardown 时按"已知的两个引擎都 `stop` 一次幂等"或保留 owner→engineType 记忆——**采用**:provider 内部维护 `owner→engineType` map(prepareEnvironment 时写入),teardown 用它取引擎;取不到(重启后)时对所有引擎 `stop(runtimeInstanceId)` 幂等兜底。

```ts
// apps/server/src/runtime/sandbox/sandbox-runtime.provider.ts
import { Inject, Injectable, Logger } from "@nestjs/common";
import type {
  RuntimeProvider,
  RuntimeLaunchContext,
  RuntimeEnvHandle,
  RuntimeInstanceRef,
} from "../runtime-provider";
import { SANDBOX_ENGINES, type SandboxEngine } from "./sandbox-engine";
import type {
  SandboxEngineType,
  SandboxPlacement,
  SandboxStartInput,
} from "../runtime.types";
import type { SandboxRuntimePlacement } from "@agework/shared/protocol";
import { ConfigService } from "../../config/config.service";
import { DEFAULT_WORKER_IMAGE } from "../../config/registry/defaults";
import { resolveDockerApiBase } from "../../worker-manager/sandbox-instance/sandbox-utils"; // 见 Step 3a
import { safePathPart } from "../../common/safe-path";
import { swallow } from "../../common/swallow";

@Injectable()
export class SandboxRuntimeProvider implements RuntimeProvider {
  readonly type = "sandbox";
  readonly placementKind = "container" as const;
  private readonly logger = new Logger(SandboxRuntimeProvider.name);
  private readonly engines: Map<SandboxEngineType, SandboxEngine>;
  private readonly ownerEngine = new Map<string, SandboxEngineType>();

  constructor(
    private readonly configService: ConfigService,
    @Inject(SANDBOX_ENGINES) engines: SandboxEngine[]
  ) {
    this.engines = new Map(engines.map((e) => [e.type, e]));
  }

  async prepareEnvironment(ctx: RuntimeLaunchContext): Promise<RuntimeEnvHandle> {
    const placement = ctx.placement as SandboxRuntimePlacement;
    const engineType = placement.sandbox.sandboxEngineType;
    const engine = this.resolveEngine(engineType);
    const input = this.buildSandboxStartInput(ctx, placement, engineType);
    const runtime = await engine.getOrCreate(input);
    await engine.startWorker(runtime, input);
    this.ownerEngine.set(ctx.ownerId, engineType);
    return { runtimeInstanceId: runtime.runtimeInstanceId };
  }

  async launchWorker(
    _ctx: RuntimeLaunchContext,
    env: RuntimeEnvHandle
  ): Promise<{ runtimeInstanceId: string }> {
    return { runtimeInstanceId: env.runtimeInstanceId ?? "" };
  }

  async teardown(ref: RuntimeInstanceRef): Promise<void> {
    const engineType = this.ownerEngine.get(ref.ownerId);
    const engines = engineType
      ? [this.resolveEngine(engineType)]
      : [...this.engines.values()];
    for (const engine of engines) {
      await engine
        .stop(ref.runtimeInstanceId)
        .catch(swallow(this.logger, `stop sandbox ${ref.runtimeInstanceId}`));
    }
    this.ownerEngine.delete(ref.ownerId);
  }

  private resolveEngine(engineType: SandboxEngineType): SandboxEngine {
    const engine = this.engines.get(engineType);
    if (!engine) throw new Error(`Unknown sandbox engine: ${engineType}`);
    return engine;
  }

  private buildSandboxStartInput(
    ctx: RuntimeLaunchContext,
    placement: SandboxRuntimePlacement,
    engineType: SandboxEngineType
  ): SandboxStartInput {
    const apiBase = resolveDockerApiBase();
    const runtimeLogDir = placement.runtimeLogDir;
    const sandboxPlacement: SandboxPlacement = {
      isolationScope: placement.sandbox.isolationScope,
      ownerId: ctx.ownerId,
      workspaceId: ctx.workspaceId,
      workspaceHostPath: placement.hostPath,
      workspaceMountPath: placement.sandbox.mountTarget,
    };
    return {
      placement: sandboxPlacement,
      image: DEFAULT_WORKER_IMAGE,
      apiBaseUrl: apiBase,
      env: {
        ...ctx.workerEnv,
        AGEWORK_WORKER_API_BASE: apiBase,
        AGEWORK_WORKER_SANDBOX_ENGINE: engineType,
        AGEWORK_WORKER_RUNTIME_RESOURCE_NAME: `agework-worker-${safePathPart(ctx.ownerId)}`,
        AGEWORK_WORKER_LOG_DIR: runtimeLogDir,
        AGEWORK_WORKER_LOG_FILE: `${runtimeLogDir}/${safePathPart(ctx.ownerId)}.runtime.worker.log`,
      },
      metadata: {
        "agework.io/runtime-owner-id": ctx.ownerId,
        "agework.io/isolation-scope": placement.sandbox.isolationScope,
      },
      runtimeLogHostPath: this.configService.getRuntimeLogDir(),
      runtimeLogMountPath: runtimeLogDir,
    };
  }
}
```

- [ ] **Step 3a: 迁移 `sandbox-utils`**

把 `apps/server/src/worker-manager/sandbox-instance/sandbox-utils.ts` 里被 provider 依赖的 `resolveDockerApiBase`(与其它 sandbox 相关纯工具)移到 `apps/server/src/runtime/sandbox/sandbox-utils.ts`,更新本文件 import。`IdleWatchdog`(idle 回收用)**不迁**——回收本计划砍掉,随原文件一起删。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter server test -- sandbox-runtime.provider.spec.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/runtime/sandbox/sandbox-runtime.provider.ts apps/server/src/runtime/sandbox/sandbox-runtime.provider.spec.ts apps/server/src/runtime/sandbox/sandbox-utils.ts
git commit -m "feat(runtime): add SandboxRuntimeProvider wrapping sandbox engines"
```

### Task 5: RuntimeService 泛型化 + module 注册

**Files:**
- Modify: `apps/server/src/runtime/runtime.service.ts`
- Modify: `apps/server/src/runtime/runtime.module.ts`
- Modify: `apps/server/src/runtime/runtime.service.spec.ts`(改断言)

**Interfaces:**
- Produces(RuntimeService 新公开面):
  - `prepareEnvironment(ctx: RuntimeLaunchContext): Promise<RuntimeEnvHandle>`
  - `launchWorker(ctx: RuntimeLaunchContext, env: RuntimeEnvHandle): Promise<{runtimeInstanceId:string}>`
  - `teardown(ref: RuntimeInstanceRef): Promise<void>|void`
  - `recoverOrphan(ref: RuntimeInstanceRef): Promise<void>|void`
  - 保留 `resolveRuntimeTarget`、`getRuntimePolicy`。
- 删除:`startSandbox`/`resumeSandbox`/`stopSandbox`/`launchLocal`/`recoverOrphanLocal`/`resolveSandboxEngine` 及 `sandboxEngines` map、`localProvider` 直注。

- [ ] **Step 1: 改 RuntimeService**

```ts
// 构造改为注入 registry:
constructor(
  private readonly configService: ConfigService,
  private readonly registry: RuntimeProviderRegistry
) {}

// 保留 resolveRuntimeTarget / getRuntimePolicy 原样。删除 sandbox/local 具体方法,新增:
prepareEnvironment(ctx: RuntimeLaunchContext): Promise<RuntimeEnvHandle> {
  return Promise.resolve(this.registry.resolve(ctx.runtimeType).prepareEnvironment(ctx));
}
launchWorker(ctx: RuntimeLaunchContext, env: RuntimeEnvHandle) {
  return Promise.resolve(this.registry.resolve(ctx.runtimeType).launchWorker(ctx, env));
}
teardown(ref: RuntimeInstanceRef): Promise<void> | void {
  return this.registry.resolve(ref.runtimeType).teardown(ref);
}
recoverOrphan(ref: RuntimeInstanceRef): Promise<void> | void {
  return this.registry.resolve(ref.runtimeType).recoverOrphan?.(ref);
}
```

import 补 `RuntimeProviderRegistry`、`RuntimeLaunchContext`/`RuntimeEnvHandle`/`RuntimeInstanceRef`;删掉 `SANDBOX_ENGINES`/`SandboxEngine`/`LocalRuntimeProvider`/`SandboxStartInput` 等不再用的 import。

- [ ] **Step 2: 改 runtime.module.ts**

```ts
providers: [
  DockerSandboxEngine,
  { provide: OPENSANDBOX_CLIENT, useFactory: (c: ConfigService) => new OpenSandboxClient(c), inject: [ConfigService] },
  OpenSandboxEngine,
  { provide: SANDBOX_ENGINES, useFactory: (...e: SandboxEngine[]) => e, inject: [DockerSandboxEngine, OpenSandboxEngine] },
  LocalRuntimeProvider,
  SandboxRuntimeProvider,
  { provide: RUNTIME_PROVIDERS, useFactory: (...p: RuntimeProvider[]) => p, inject: [LocalRuntimeProvider, SandboxRuntimeProvider] },
  RuntimeProviderRegistry,
  RuntimeService,
],
exports: [RuntimeService],
```

- [ ] **Step 3: 改 runtime.service.spec.ts**

把针对 `startSandbox`/`launchLocal` 的断言改为针对 `prepareEnvironment`/`launchWorker`/`teardown` 经 registry 转发(mock `RuntimeProviderRegistry.resolve` 返回 fake provider,断言被调)。

- [ ] **Step 4: typecheck + test**

Run: `pnpm --filter server test -- runtime.service.spec.ts runtime-provider.registry.spec.ts`
Expected: PASS。
Run: `pnpm --filter server typecheck`
Expected: **仍会报错** —— worker-manager 的两个 executor 还在引用 `runtimeService.startSandbox` 等已删方法。这是预期的,Phase B 会删掉这些引用。**本步只需确认错误全部来自 worker-manager 的 `sandbox-instance`/`local-instance`,不是 runtime 内部。**

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/runtime/runtime.service.ts apps/server/src/runtime/runtime.module.ts apps/server/src/runtime/runtime.service.spec.ts
git commit -m "refactor(runtime): make RuntimeService dispatch via RuntimeProviderRegistry"
```

---

## Phase B — worker-manager provisioner + 去执行器

### Task 6: 扩 findActiveByOwnerId 的 select

**Files:**
- Modify: `apps/server/src/worker-manager/registry/worker-registry.repository.ts`
- Modify: `apps/server/src/worker-manager/registry/worker-registry.repository.spec.ts`

**Interfaces:**
- Produces: `findActiveByOwnerId(ownerId)` 返回 `{ startToken: string|null; runtimeType: string; runtimeInstanceId: string; isolationScope: string; ownerId: string } | null`。

现状只 select `{ startToken, runtimeType }`。teardown-by-ref 与 fence 需要 `runtimeInstanceId`/`isolationScope`/`ownerId`。

- [ ] **Step 1: 改 select**

把 `findActiveByOwnerId` 的 `select` 从 `{ startToken: true, runtimeType: true }` 改为:

```ts
select: {
  startToken: true,
  runtimeType: true,
  runtimeInstanceId: true,
  isolationScope: true,
  ownerId: true,
},
```

- [ ] **Step 2: 补/改 spec**

在 `worker-registry.repository.spec.ts` 里断言返回含新字段。

- [ ] **Step 3: test**

Run: `pnpm --filter server test -- worker-registry.repository.spec.ts`
Expected: PASS。

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/worker-manager/registry/worker-registry.repository.ts apps/server/src/worker-manager/registry/worker-registry.repository.spec.ts
git commit -m "feat(worker-manager): widen findActiveByOwnerId select for teardown ref"
```

### Task 7: WorkerProvisioner

**Files:**
- Create: `apps/server/src/worker-manager/instance/worker.provisioner.ts`
- Test: `apps/server/src/worker-manager/instance/worker.provisioner.spec.ts`

**Interfaces:**
- Consumes: `RuntimeService`(prepareEnvironment/launchWorker/teardown)、`WorkerRegistryRepository`(insertStarting/upsertRunning/markErrorByOwner/markStoppedByOwner)、`WorkerHandshakeStore`(waitForRegister/cancel)、`WorkerCommandDispatcher`(cleanupByOwnerId)、`ConfigService`(getLaunchTimeoutSeconds)。
- Produces:
  - `acquireInstanceForRun(input: WorkerExecutionStartInput): Promise<AcquireInstanceResult>`(只回 ready|error)
  - `teardown(ref: RuntimeInstanceRef): Promise<void>`
  - `resolveWorkerEnv` 私有

职责:两个 executor 复制的启动序列的**唯一副本**,泛型无 runtimeType 分支。owner 状态:`ready`(runtimeInstanceId 已知)/`pending`(promise 去重)。**不含** activeRunCount/idle watchdog/AcquireRunState settle/idle-resume。撞 pending → await 同一个 promise;已 ready → 直接返回。撞 DB `running` 行(insertStarting 冲突)→ 复用 existing.runtimeInstanceId(Q1 决策)。

- [ ] **Step 1: 写失败测试(ready 主路径 + 并发去重 + error)**

```ts
// apps/server/src/worker-manager/instance/worker.provisioner.spec.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { WorkerProvisioner } from "./worker.provisioner";

function deps() {
  return {
    runtime: {
      prepareEnvironment: vi.fn().mockResolvedValue({ runtimeInstanceId: "c1" }),
      launchWorker: vi.fn().mockResolvedValue({ runtimeInstanceId: "c1" }),
      teardown: vi.fn().mockResolvedValue(undefined),
    },
    registry: {
      insertStarting: vi.fn().mockResolvedValue({ ok: true }),
      upsertRunning: vi.fn().mockResolvedValue(undefined),
      markErrorByOwner: vi.fn().mockResolvedValue(undefined),
      markStoppedByOwner: vi.fn().mockResolvedValue(undefined),
    },
    handshake: {
      waitForRegister: vi.fn().mockResolvedValue({ pid: 1, registeredAt: "t" }),
      cancel: vi.fn(),
    },
    dispatcher: { cleanupByOwnerId: vi.fn() },
    config: { getLaunchTimeoutSeconds: () => 30 },
  };
}

const input = (runId = "run-1") => ({
  runConfig: { runId, workspaceId: "ws-1", conversationId: "c" },
  runtimeTarget: {
    runtimeType: "local",
    ownerId: "ws-1",
    userId: "u1",
    workspaceId: "ws-1",
    hostPath: "/w",
    runtimePath: "/w",
    runtimeLogDir: "/logs",
  },
}) as any;

function make(d = deps()) {
  return new WorkerProvisioner(d.runtime as any, d.registry as any, d.handshake as any, d.dispatcher as any, d.config as any);
}

describe("WorkerProvisioner", () => {
  it("runs insertStarting → prepare → launch → waitForRegister → upsertRunning and returns ready", async () => {
    const d = deps();
    const res = await make(d).acquireInstanceForRun(input());
    expect(d.registry.insertStarting).toHaveBeenCalledOnce();
    expect(d.runtime.prepareEnvironment).toHaveBeenCalledOnce();
    expect(d.runtime.launchWorker).toHaveBeenCalledOnce();
    expect(d.handshake.waitForRegister).toHaveBeenCalledOnce();
    expect(d.registry.upsertRunning).toHaveBeenCalledOnce();
    expect(res).toEqual({ outcome: "ready", runtimeInstanceId: "c1" });
  });

  it("dedups concurrent runs for the same owner to one launch", async () => {
    const d = deps();
    const p = make(d);
    const [a, b] = await Promise.all([p.acquireInstanceForRun(input("r1")), p.acquireInstanceForRun(input("r2"))]);
    expect(a).toEqual({ outcome: "ready", runtimeInstanceId: "c1" });
    expect(b).toEqual({ outcome: "ready", runtimeInstanceId: "c1" });
    expect(d.runtime.prepareEnvironment).toHaveBeenCalledOnce();
  });

  it("returns error and marks error when launch fails", async () => {
    const d = deps();
    d.runtime.prepareEnvironment.mockRejectedValueOnce(new Error("boom"));
    const res = await make(d).acquireInstanceForRun(input());
    expect(res.outcome).toBe("error");
    expect(d.registry.markErrorByOwner).toHaveBeenCalledOnce();
  });

  it("reuses an existing running row on insertStarting conflict", async () => {
    const d = deps();
    d.registry.insertStarting.mockResolvedValueOnce({ ok: false, existing: { runtimeInstanceId: "old", status: "running" } });
    const res = await make(d).acquireInstanceForRun(input());
    expect(res).toEqual({ outcome: "ready", runtimeInstanceId: "old" });
    expect(d.runtime.prepareEnvironment).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter server test -- worker.provisioner.spec.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 写实现**

```ts
// apps/server/src/worker-manager/instance/worker.provisioner.ts
import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type {
  AcquireInstanceResult,
  WorkerExecutionStartInput,
} from "@agework/shared/protocol";
import type {
  RuntimeInstanceRef,
  RuntimeLaunchContext,
} from "../../runtime/runtime-provider";
import { RuntimeService } from "../../runtime/runtime.service";
import { WorkerRegistryRepository } from "../registry/worker-registry.repository";
import { WorkerHandshakeStore } from "../handshake/worker-handshake.store";
import { WorkerCommandDispatcher } from "../command/command-dispatcher.service";
import { ConfigService } from "../../config/config.service";
import { withTimeout } from "../../common/with-timeout";
import { swallow } from "../../common/swallow";
import { errorLogFields, safeLogJson } from "../../common/logging";

type OwnerInstance =
  | { status: "pending"; promise: Promise<AcquireInstanceResult> }
  | { status: "ready"; runtimeInstanceId: string; isolationScope: string; runtimeType: string };

/** worker 实例编排(泛型,不认识 runtimeType):两个旧 executor 复制的启动握手
 *  序列的唯一副本。无回收(引用计数/idle/settle 全砍)。 */
@Injectable()
export class WorkerProvisioner {
  private readonly logger = new Logger(WorkerProvisioner.name);
  private readonly owners = new Map<string, OwnerInstance>();

  constructor(
    private readonly runtimeService: RuntimeService,
    private readonly registry: WorkerRegistryRepository,
    private readonly handshakeStore: WorkerHandshakeStore,
    private readonly commandDispatcher: WorkerCommandDispatcher,
    private readonly configService: ConfigService
  ) {}

  acquireInstanceForRun(
    input: WorkerExecutionStartInput
  ): Promise<AcquireInstanceResult> {
    const ownerId = input.runtimeTarget.ownerId;
    const existing = this.owners.get(ownerId);
    if (existing?.status === "ready") {
      return Promise.resolve({ outcome: "ready", runtimeInstanceId: existing.runtimeInstanceId });
    }
    if (existing?.status === "pending") return existing.promise;

    const promise = this.launch(input);
    this.owners.set(ownerId, { status: "pending", promise });
    return promise;
  }

  private async launch(
    input: WorkerExecutionStartInput
  ): Promise<AcquireInstanceResult> {
    const { runtimeTarget, runConfig } = input;
    const ownerId = runtimeTarget.ownerId;
    const { runtimeType, isolationScope } = this.identity(input);
    const startToken = randomUUID();

    const insert = await this.registry.insertStarting(
      { runtimeType, isolationScope, workspaceId: runConfig.workspaceId, ownerId },
      randomUUID(),
      "http",
      startToken
    );
    if (!insert.ok) {
      if (insert.existing.status === "running") {
        this.owners.set(ownerId, { status: "ready", runtimeInstanceId: insert.existing.runtimeInstanceId, isolationScope, runtimeType });
        return { outcome: "ready", runtimeInstanceId: insert.existing.runtimeInstanceId };
      }
      this.owners.delete(ownerId);
      return { outcome: "error", error: `owner ${ownerId} has a concurrent launch already starting` };
    }

    const ctx: RuntimeLaunchContext = {
      runtimeType,
      ownerId,
      workspaceId: runConfig.workspaceId,
      runId: runConfig.runId,
      placement: runtimeTarget,
      workerEnv: this.buildWorkerEnv(input, startToken, runtimeType, isolationScope),
    };

    try {
      const { runtimeInstanceId } = await withTimeout(
        (async () => {
          const env = await this.runtimeService.prepareEnvironment(ctx);
          const launched = await this.runtimeService.launchWorker(ctx, env);
          await this.handshakeStore.waitForRegister(ownerId, startToken);
          return launched;
        })(),
        this.configService.getLaunchTimeoutSeconds() * 1000,
        `worker launch timed out for owner ${ownerId}`
      );

      await this.registry
        .upsertRunning({ runtimeType, isolationScope, workspaceId: runConfig.workspaceId, ownerId }, runtimeInstanceId, "http")
        .catch(swallow(this.logger, `upsert running for owner ${ownerId}`));

      this.owners.set(ownerId, { status: "ready", runtimeInstanceId, isolationScope, runtimeType });
      return { outcome: "ready", runtimeInstanceId };
    } catch (err) {
      this.handshakeStore.cancel(ownerId, `worker launch failed for owner ${ownerId}`);
      await this.registry
        .markErrorByOwner(runtimeType, isolationScope, ownerId, err instanceof Error ? err.message : String(err))
        .catch(swallow(this.logger, `mark launch error for owner ${ownerId}`));
      this.owners.delete(ownerId);
      this.logger.warn(`worker launch failed ${safeLogJson({ ownerId, runtimeType, ...errorLogFields(err) })}`);
      return { outcome: "error", error: `worker launch failed: ${String(err)}` };
    }
  }

  /** 拆除某 owner 的实例:清内存态 + command dispatcher + registry markStopped +
   *  provider.teardown。ref 由调用方从 DB 行派生(重启后无内存态也能停)。 */
  async teardown(ref: RuntimeInstanceRef): Promise<void> {
    this.owners.delete(ref.ownerId);
    this.commandDispatcher.cleanupByOwnerId(ref.ownerId);
    await Promise.resolve(this.runtimeService.teardown(ref)).catch(
      swallow(this.logger, `provider teardown for owner ${ref.ownerId}`)
    );
    await this.registry
      .markStoppedByOwner(ref.runtimeType, ref.isolationScope, ref.ownerId)
      .catch(swallow(this.logger, `mark stopped for owner ${ref.ownerId}`));
  }

  private identity(input: WorkerExecutionStartInput): { runtimeType: string; isolationScope: string } {
    const target = input.runtimeTarget;
    const isolationScope =
      target.runtimeType === "sandbox" ? target.sandbox.isolationScope : "workspace";
    return { runtimeType: target.runtimeType, isolationScope };
  }

  private buildWorkerEnv(
    input: WorkerExecutionStartInput,
    startToken: string,
    runtimeType: string,
    isolationScope: string
  ): Record<string, string> {
    const { runConfig } = input;
    const env: Record<string, string> = {
      AGEWORK_WORKER_ROLE: "worker",
      AGEWORK_WORKER_OWNER_ID: input.runtimeTarget.ownerId,
      AGEWORK_WORKER_START_TOKEN: startToken,
      AGEWORK_WORKER_RUNTIME_TYPE: runtimeType,
      AGEWORK_WORKER_ISOLATION_SCOPE: isolationScope,
    };
    if (runConfig.workerLogFilePath) {
      env.AGEWORK_WORKER_LOG_FILE = runConfig.workerLogFilePath;
    }
    return env;
  }
}
```

> 说明:local 的 `AGEWORK_WORKER_API_BASE`(loopback)不在共享 env 里——它是 process infra env,应由 `LocalRuntimeProvider.launchWorker` 内部补(把原 `resolveLocalApiBase()` 迁进 local provider,launch 时并入 env)。sandbox 的 `API_BASE`/`SANDBOX_ENGINE` 已在 `SandboxRuntimeProvider.buildSandboxStartInput` 里补。**在 Task 3 追加**:local provider `launchWorker` 合并 `{ AGEWORK_WORKER_API_BASE: resolveLocalApiBase() }` 到 env。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter server test -- worker.provisioner.spec.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/worker-manager/instance/worker.provisioner.ts apps/server/src/worker-manager/instance/worker.provisioner.spec.ts
git commit -m "feat(worker-manager): add generic WorkerProvisioner replacing per-type executors"
```

### Task 8: 门面 rewire + 删两 executor + module

**Files:**
- Modify: `apps/server/src/worker-manager/worker-manager.service.ts`
- Modify: `apps/server/src/worker-manager/worker-manager.module.ts`
- Modify: `apps/server/src/worker-manager/lifecycle/lifecycle.service.ts`
- Delete: `apps/server/src/worker-manager/sandbox-instance/`(全目录)
- Delete: `apps/server/src/worker-manager/local-instance/`(全目录)
- Modify: 相关 `worker-manager.service.spec.ts`、`lifecycle.service.spec.ts`

**Interfaces:**
- Consumes: `WorkerProvisioner.acquireInstanceForRun`/`teardown`(Task 7)、`findActiveByOwnerId`(Task 6)。

- [ ] **Step 1: 改 WorkerManagerService**

- 构造:删 `sandboxInstances: SandboxInstanceExecutor`、`localInstances: LocalInstanceExecutor`,加 `provisioner: WorkerProvisioner`。
- `resolveInstance(input)`:去 `if (local)` 分支,直接 `registerRun(...)` + `return this.provisioner.acquireInstanceForRun(input)`。
- `releaseInstanceForRun(runId)`:改成只清 fence 索引(`unregisterRun(runId)`),不再调实例释放(回收已砍)。
- `shutdownInstanceByOwnerId(runtimeType, ownerId)` → 改为 `async shutdownInstanceByOwnerId(ref)` 或内部先 `findActiveByOwnerId(ownerId)` 拿 ref 再 `provisioner.teardown(ref)`。**采用**:新增私有 `async teardownOwner(ownerId)`:`const row = await registry.findActiveByOwnerId(ownerId); if (!row) return; await provisioner.teardown({ runtimeType: row.runtimeType, ownerId: row.ownerId, runtimeInstanceId: row.runtimeInstanceId, isolationScope: row.isolationScope });`
- `fenceOwner`:把原 `shutdownInstanceByOwnerId(active.runtimeType, ownerId)` + `commandDispatcher.cleanupByOwnerId` 换成 `await this.teardownOwner(ownerId)`(teardown 内部已含 dispatcher 清理);其余(notifyWorkerLost 循环、livenessStore.remove)不变。`active` 现在来自 `findActiveByOwnerId`,已含所需字段。
- `stopRuntimeInstance(id)`:`findById` 拿到 resource(全列),改为 `await this.provisioner.teardown({ runtimeType: resource.runtimeType, ownerId: resource.ownerId, runtimeInstanceId: resource.runtimeInstanceId, isolationScope: resource.isolationScope })` + `markStoppedById`。

- [ ] **Step 2: 改 lifecycle.service.ts**

- 构造:删 `sandboxInstances`/`localInstances` 两 executor,改注入 `WorkerProvisioner`(或经门面;但 lifecycle 是 internal,注入 provisioner 直用)。
- `shutdownResource(resource)`:去 `if sandbox / else local` 分支,直接 `await this.provisioner.teardown({ runtimeType: resource.runtimeType, ownerId: resource.ownerId, runtimeInstanceId: resource.runtimeInstanceId, isolationScope: resource.isolationScope })` + `markStoppedById`。注意 `shutdownResource` 入参需补 `runtimeInstanceId`——`shutdownForWorkspace`/`shutdownForUser` 传入的 resource 来自 `findBindingWithResource`/`findRunningByOwners`,均为全列 `WorkerInstance`,含 `runtimeInstanceId`,直接可用。
- `onApplicationBootstrap`:`recoverOrphan` local 行改为 `this.provisioner`... 实际 local 孤儿恢复现在走 `runtimeService.recoverOrphan(ref)`——bootstrap 里对 local running 行构造 ref 调 `provisioner`? provisioner 无 recoverOrphan。**采用**:bootstrap 直接调 `runtimeService.recoverOrphan({ runtimeType:"local", ownerId: row.ownerId, runtimeInstanceId: row.runtimeInstanceId, isolationScope: row.isolationScope })`(runtimeService 注入 lifecycle)。sandbox seed 那段 `findRunningByRuntimeType("sandbox")` + `touch` 不变(本计划域值未变)。

- [ ] **Step 3: 删两 executor 目录**

```bash
git rm -r apps/server/src/worker-manager/sandbox-instance apps/server/src/worker-manager/local-instance
```

- [ ] **Step 4: 改 module**

`worker-manager.module.ts`:providers 删 `SandboxInstanceExecutor`/`LocalInstanceExecutor`,加 `WorkerProvisioner`。删对应 import。

- [ ] **Step 5: 修 spec**

`worker-manager.service.spec.ts` / `lifecycle.service.spec.ts`:把对两 executor 的 mock 换成 mock `WorkerProvisioner`;断言 `resolveInstance` 转发 provisioner、teardown 路径经 provisioner。

- [ ] **Step 6: typecheck + 相关 test**

Run: `pnpm --filter server typecheck`
Expected: PASS(runtime 侧 A5 遗留的报错现在应消失,因为 worker-manager 不再引用旧方法)。
Run: `pnpm --filter server test -- worker-manager.service.spec.ts lifecycle.service.spec.ts`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add -A apps/server/src/worker-manager
git commit -m "refactor(worker-manager): route instance lifecycle through WorkerProvisioner, delete executors"
```

---

## Phase C — 契约收窄 + run

### Task 9: AcquireInstanceResult 去 cancelledBeforeReady

**Files:**
- Modify: `packages/shared/src/protocol/channel.ts`
- Modify: `apps/server/src/run/execution/worker-run.executor.ts`
- Modify: `apps/server/src/run/execution/worker-run.executor.spec.ts`

**Interfaces:**
- Produces: `AcquireInstanceResult = { outcome:"ready"; runtimeInstanceId:string } | { outcome:"error"; error:string }`。

- [ ] **Step 1: 改 shared 契约**

`channel.ts` 里 `AcquireInstanceResult` 删中间那行:

```ts
export type AcquireInstanceResult =
  | { outcome: "ready"; runtimeInstanceId: string }
  | { outcome: "error"; error: string };
```

- [ ] **Step 2: build shared**

Run: `pnpm --filter @agework/shared build`(若有 build;否则 `pnpm --filter shared typecheck`)
Expected: PASS。

- [ ] **Step 3: 删 run 的 cancelledBeforeReady 分支**

`worker-run.executor.ts` `onAcquired`:删掉 `if (result.outcome === "cancelledBeforeReady") { ... }`(行 86-90)。保留 `ready` 分支里 `state.cancelled` → `releaseInstanceForRun` + `notifyCancelledBeforeReady`(取消由 run 层自处理,`RunEventPort.notifyCancelledBeforeReady` 保留不动)。

- [ ] **Step 4: 修 spec**

`worker-run.executor.spec.ts`:mock receiver 里 `notifyCancelledBeforeReady` 保留(ready+cancelled 路径仍用);无需针对已删 outcome 的用例(现状本就没有,见提取报告)。若 TS 因 union 收窄报未覆盖分支,清理即可。

- [ ] **Step 5: typecheck + test**

Run: `pnpm --filter server typecheck`
Expected: PASS。
Run: `pnpm --filter server test -- worker-run.executor.spec.ts`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/protocol/channel.ts apps/server/src/run/execution/worker-run.executor.ts apps/server/src/run/execution/worker-run.executor.spec.ts
git commit -m "refactor(shared,run): drop cancelledBeforeReady from AcquireInstanceResult"
```

---

## Phase D — 全量验证

### Task 10: 全量 typecheck + test + eslint

- [ ] **Step 1: typecheck**

Run: `pnpm typecheck`
Expected: PASS(web/server/shared 全绿)。

- [ ] **Step 2: server 单测**

Run: `pnpm test:server`
Expected: PASS。

- [ ] **Step 3: eslint(type-aware,不能只信 tsc)**

Run: `pnpm --filter server lint`(或仓库对应 eslint 命令)
Expected: PASS,无 type-aware 规则报错(如未用变量、floating promise)。

- [ ] **Step 4: 冒烟(可选,若环境允许)**

按 `/run` 或 `pnpm dev:server` 起服务,发一次 local run,确认 worker 注册 → ready → 收到 user_message;发一次 sandbox run(docker),确认容器起来、复用第二次同 owner run。

- [ ] **Step 5: 收尾 Commit(若有 lint 修复)**

```bash
git add -A && git commit -m "chore: lint fixes for runtime provider refactor"
```

---

## Self-Review 结果

- **Spec 覆盖**:runtime 扁平化的"provider 注册表 + RuntimeService 泛型"→Task 1-A5;worker-manager 去执行器 + provisioner + 砍回收→B2-B3;teardown 收 ref→A1/B1/B2;契约收窄→C1;`recoverOrphan?` optional→A1/A3/B3。**未覆盖(移交计划二)**:runtimeType flat 化(→docker|opensandbox)、config/prisma/shared-workspaces/前端迁移、placement trait(`placementKind` 已在接口备好但本计划 placement 分支仍用 `isSandboxPlacement`/runtimeType,计划二切换)、lifecycle seed 改 `findRunningByPlacement`。
- **占位符**:无 TODO/TBD;每个改代码步给了完整代码或精确前后对照。
- **类型一致**:`RuntimeLaunchContext`/`RuntimeEnvHandle`/`RuntimeInstanceRef` 三处(A1 定义、providers 消费、provisioner/RuntimeService 消费)签名一致;`AcquireInstanceResult` 收窄后 provisioner 只产 ready|error,与 C1 一致。

> 计划二(flat 化)在计划一落地后另起 `docs/superpowers/plans/` 文档。
