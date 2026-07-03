# RuntimeType 扁平化 docker|opensandbox(计划二)实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `runtimeType` 从 `local | sandbox`(+ 独立 `sandboxEngine`)合并成单一 `local | docker | opensandbox`,删除 `sandboxEngine` 概念,并把计划一的单个 `SandboxRuntimeProvider` 拆成 `DockerRuntimeProvider` / `OpenSandboxRuntimeProvider` 两个 peer provider。

**Architecture:** 计划一已建好 `RuntimeProvider` 注册表(provider map 在 `RuntimeService`)。本计划:(1) 拆 sandbox provider 为按引擎的两个 provider,共享一个 `ContainerRuntimeProvider` 基类;(2) 迁移 `runtimeType` 值域,穿过 shared 契约、config、Prisma、placement、workspace 模块、run-launcher、前端;(3) 用 `placementKind`/container 集合替换所有 `=== "sandbox"` 硬判。DB 开发期重建(`pnpm db:push`),不做迁移。

**Tech Stack:** NestJS 11、Prisma、Vitest、pnpm workspace、`@agework/shared`、React 19 + Vite(前端)。

## Global Constraints

- `runtimeType` 新值域:`"local" | "docker" | "opensandbox"`。`sandboxEngine` 字段/类型/方法**全部删除**。
- container 运行形态 = `docker` + `opensandbox`;`local` = process。凡旧 `=== "sandbox"` 判断,改判"是否 container"(用 `placementKind === "container"` 或 `CONTAINER_RUNTIME_TYPES` 集合),不硬写字面量。
- 后端命名/架构规则:`.claude/rules/backend-naming.md`、`.claude/rules/backend-architecture.md`。root 白名单;runtime 不依赖 worker-manager。
- Prisma 开发期重建,不写 migration。`WorkerInstance.runtimeType` 仍是 `String` 列,值域变化不改列类型。
- 验证:每任务后 `pnpm --filter server typecheck` / 相关 spec;计划末尾 `pnpm typecheck`(含 web)+ `pnpm test:server` + `pnpm test:web` + eslint(server + web)。
- 本计划建立在计划一之上(branch `refactor`,commits 至 9de5dbb1)。

---

## 文件结构(计划二)

**runtime(拆 provider)**
- Create `apps/server/src/runtime/sandbox/container-runtime.provider.ts` — `ContainerRuntimeProvider` 基类(收 plan-one `SandboxRuntimeProvider` 的 `buildSandboxStartInput`/prepare/launch/teardown,持有单个 `SandboxEngine`,`placementKind="container"`)。
- Create `apps/server/src/runtime/sandbox/docker-runtime.provider.ts` — `DockerRuntimeProvider extends ContainerRuntimeProvider`(`type="docker"`,注入 `DockerSandboxEngine`)。
- Create `apps/server/src/runtime/sandbox/opensandbox-runtime.provider.ts` — `OpenSandboxRuntimeProvider extends ContainerRuntimeProvider`(`type="opensandbox"`,注入 `OpenSandboxEngine`)。
- Delete `apps/server/src/runtime/sandbox/sandbox-runtime.provider.ts`(+ spec)。
- Modify `apps/server/src/runtime/runtime.module.ts` — 注册 3 个 provider 进 `RUNTIME_PROVIDERS`;删 `SANDBOX_ENGINES` 聚合(container provider 各自注入引擎)。
- Modify `apps/server/src/runtime/runtime.types.ts` — `SandboxEngineType` 删除或改为 `string`;`ResolveRuntimeTargetInput` sandbox 分支去 `sandboxEngine`。
- Modify `apps/server/src/runtime/placement/runtime-resource.ts` — 按 container/local 分支(不判 `sandboxEngine`);`sandbox.sandboxEngineType = runtimeType`。
- Modify `apps/server/src/runtime/runtime.service.ts` — `resolveRuntimeTarget` 传入 placementKind(取 provider)。

**shared / config / prisma**
- Modify `packages/shared/src/api/workspaces.ts` — `WorkspaceRuntimeType` 三值;删 `SandboxEngineType` + 三处 `sandboxEngine` 字段。
- Modify `apps/server/src/config/config.service.ts` — `RuntimeType` 三值 + `RUNTIME_TYPES`;删 `SandboxEngineType`/`getSandboxEngine`。
- Modify `apps/server/src/config/registry/defaults.ts` — 删 `DEFAULT_SANDBOX_ENGINE`;`DEFAULT_ALLOWED_RUNTIME_TYPES` 保持 `["local"]`。
- Modify `apps/server/prisma/schema.prisma` — 删 `Workspace.sandboxEngine`。

**workspace / run / worker-manager**
- Modify `apps/server/src/workspace/runtime/workspace-runtime.policy.ts` — 删 `normalizeSandboxEngine`;`supportsCustomRootPath`/`normalizeIsolationScope` 用 container 判断;capabilities 去 `sandboxEngine`。
- Modify `apps/server/src/workspace/{workspace.service.ts,workspace.repository.ts,workspace.controller.ts,workspace.types.ts,dto/create-workspace.dto.ts}` — 删 `sandboxEngine` 透传。
- Modify `apps/server/src/run/launch/run-launcher.ts` — `getPlacement` 去 sandbox/sandboxEngine 映射。
- Modify `apps/server/src/run/recovery/run-recovery.service.ts` — `=== "local"` 判断保持(local 不恢复)不变,确认无 sandbox 假设。
- Modify `apps/server/src/worker-manager/lifecycle/lifecycle.service.ts` — bootstrap seed 从 `findRunningByRuntimeType("sandbox")` 改 container 查询。
- Modify `apps/server/src/worker-manager/registry/worker-registry.repository.ts` — 加 `findRunningByPlacement`(或 `findRunningContainerRows`)。
- Modify `apps/server/src/run-event/run-event.service.ts` — `sandboxEngineType` 观测字段(改用 runtimeType 或保留 placement 值)。

**前端**
- Modify `apps/web/src/components/workspace-dialog.tsx` — `RUNTIME_TYPES` 三值;去 sandbox↔isolation 耦合。
- Modify `apps/web/src/components/sidebar/workspace-group.tsx` — `runtimeLabel`/`sandboxEngineLabel` 改用 runtimeType。
- Modify `apps/web/src/components/workspace-selector.tsx`、`assistant-ui/thread-composer.tsx`、`api/runtime.ts` — runtimeType 三值 / 去 `=== "sandbox"`。

---

## Phase A — runtime provider 拆分(docker / opensandbox)

### Task 1: ContainerRuntimeProvider 基类

**Files:**
- Create: `apps/server/src/runtime/sandbox/container-runtime.provider.ts`
- Test: `apps/server/src/runtime/sandbox/container-runtime.provider.spec.ts`

**Interfaces:**
- Consumes: `RuntimeProvider`/`RuntimeLaunchContext`/`RuntimeEnvHandle`/`RuntimeInstanceRef`(`../runtime.types`)、`SandboxEngine`(`./sandbox-engine`)、`SandboxStartInput`/`SandboxPlacement`(`../runtime.types`)、`ConfigService`。
- Produces: `abstract class ContainerRuntimeProvider implements RuntimeProvider`(`placementKind="container"`,abstract `type`,构造收单个 `engine: SandboxEngine`)。

把 plan-one `SandboxRuntimeProvider` 的 `prepareEnvironment`/`launchWorker`/`teardown`/`buildSandboxStartInput` 迁入,改动:引擎不再从 `placement.sandbox.sandboxEngineType` 查 map,而是用本类持有的 `this.engine`;`teardown` 直接 `this.engine.stop(ref.runtimeInstanceId)`(删 `ownerEngine` map 与"停所有引擎"兜底);env 里 `AGEWORK_WORKER_SANDBOX_ENGINE = this.type`。`isExpectedRuntimeInstance: ctx.isExpectedRuntimeInstance`(保留计划一 Critical 修复)。

- [ ] **Step 1: 写失败测试**

```ts
// container-runtime.provider.spec.ts
import { describe, it, expect, vi } from "vitest";
import { ContainerRuntimeProvider } from "./container-runtime.provider";
import type { SandboxEngine } from "./sandbox-engine";
import type { RuntimeLaunchContext } from "../runtime.types";

class TestContainerProvider extends ContainerRuntimeProvider {
  readonly type = "docker";
}

const engine = (): SandboxEngine => ({
  type: "docker",
  getOrCreate: vi.fn().mockResolvedValue({ engineType: "docker", runtimeInstanceId: "c1", workspaceMountPath: "/w" }),
  startWorker: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
});

const cfg = { getRuntimeLogDir: () => "/host/logs" } as any;
const ctx = (): RuntimeLaunchContext => ({
  runtimeType: "docker", ownerId: "ws-1", workspaceId: "ws-1", runId: "run-1",
  placement: { runtimeType: "sandbox", userId: "u1", workspaceId: "ws-1", hostPath: "/host", runtimePath: "/rt", runtimeLogDir: "/logs",
    sandbox: { isolationScope: "workspace", mountTarget: "/rt", sandboxEngineType: "docker" } },
  workerEnv: { AGEWORK_WORKER_OWNER_ID: "ws-1" },
  isExpectedRuntimeInstance: async () => true,
});

describe("ContainerRuntimeProvider", () => {
  it("declares container placement and its engine's type", () => {
    const p = new TestContainerProvider(cfg, engine());
    expect(p.placementKind).toBe("container");
    expect(p.type).toBe("docker");
  });
  it("prepareEnvironment creates + starts worker via its engine and threads isExpectedRuntimeInstance", async () => {
    const e = engine();
    const p = new TestContainerProvider(cfg, e);
    const handle = await p.prepareEnvironment(ctx());
    expect(e.getOrCreate).toHaveBeenCalledOnce();
    const passedInput = (e.getOrCreate as any).mock.calls[0][0];
    expect(typeof passedInput.isExpectedRuntimeInstance).toBe("function");
    expect(passedInput.env.AGEWORK_WORKER_SANDBOX_ENGINE).toBe("docker");
    expect(handle.runtimeInstanceId).toBe("c1");
  });
  it("teardown stops via its engine", async () => {
    const e = engine();
    const p = new TestContainerProvider(cfg, e);
    await p.teardown({ runtimeType: "docker", ownerId: "ws-1", runtimeInstanceId: "c1", isolationScope: "workspace" });
    expect(e.stop).toHaveBeenCalledWith("c1");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter server test -- container-runtime.provider.spec.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 写实现**

```ts
// apps/server/src/runtime/sandbox/container-runtime.provider.ts
import { Logger } from "@nestjs/common";
import type {
  RuntimeProvider, RuntimeLaunchContext, RuntimeEnvHandle, RuntimeInstanceRef,
} from "../runtime.types";
import type { SandboxEngine } from "./sandbox-engine";
import type { SandboxPlacement, SandboxStartInput } from "../runtime.types";
import type { SandboxRuntimePlacement } from "@agework/shared/protocol";
import { ConfigService } from "../../config/config.service";
import { DEFAULT_WORKER_IMAGE } from "../../config/registry/defaults";
import { resolveDockerApiBase } from "./sandbox-utils";
import { safePathPart } from "../../common/safe-path";
import { swallow } from "../../common/swallow";

/** 容器运行形态的共享实现:docker / opensandbox 各持有一个 SandboxEngine 的子类。
 *  子类只声明 `type` 并由 DI 注入对应引擎。 */
export abstract class ContainerRuntimeProvider implements RuntimeProvider {
  abstract readonly type: string;
  readonly placementKind = "container" as const;
  protected readonly logger = new Logger(ContainerRuntimeProvider.name);

  constructor(
    protected readonly configService: ConfigService,
    protected readonly engine: SandboxEngine
  ) {}

  async prepareEnvironment(ctx: RuntimeLaunchContext): Promise<RuntimeEnvHandle> {
    const placement = ctx.placement as SandboxRuntimePlacement;
    const input = this.buildSandboxStartInput(ctx, placement);
    const runtime = await this.engine.getOrCreate(input);
    await this.engine.startWorker(runtime, input);
    return { runtimeInstanceId: runtime.runtimeInstanceId };
  }

  launchWorker(_ctx: RuntimeLaunchContext, env: RuntimeEnvHandle): Promise<{ runtimeInstanceId: string }> {
    return Promise.resolve({ runtimeInstanceId: env.runtimeInstanceId ?? "" });
  }

  async teardown(ref: RuntimeInstanceRef): Promise<void> {
    await this.engine
      .stop(ref.runtimeInstanceId)
      .catch(swallow(this.logger, `stop container ${ref.runtimeInstanceId}`));
  }

  private buildSandboxStartInput(
    ctx: RuntimeLaunchContext,
    placement: SandboxRuntimePlacement
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
        AGEWORK_WORKER_SANDBOX_ENGINE: this.type,
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
      isExpectedRuntimeInstance: ctx.isExpectedRuntimeInstance,
    };
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter server test -- container-runtime.provider.spec.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/runtime/sandbox/container-runtime.provider.ts apps/server/src/runtime/sandbox/container-runtime.provider.spec.ts
git commit -m "feat(runtime): add ContainerRuntimeProvider base for per-engine providers"
```

### Task 2: Docker / OpenSandbox provider + module wiring + 删 SandboxRuntimeProvider

**Files:**
- Create: `apps/server/src/runtime/sandbox/docker-runtime.provider.ts`
- Create: `apps/server/src/runtime/sandbox/opensandbox-runtime.provider.ts`
- Delete: `apps/server/src/runtime/sandbox/sandbox-runtime.provider.ts`(+ `.spec.ts`)
- Modify: `apps/server/src/runtime/runtime.module.ts`

**Interfaces:**
- Produces: `DockerRuntimeProvider`(`type="docker"`)、`OpenSandboxRuntimeProvider`(`type="opensandbox"`),均 `extends ContainerRuntimeProvider`。

- [ ] **Step 1: 写两个 provider**

```ts
// docker-runtime.provider.ts
import { Injectable } from "@nestjs/common";
import { ContainerRuntimeProvider } from "./container-runtime.provider";
import { ConfigService } from "../../config/config.service";
import { DockerSandboxEngine } from "./docker-engine";

@Injectable()
export class DockerRuntimeProvider extends ContainerRuntimeProvider {
  readonly type = "docker";
  constructor(configService: ConfigService, engine: DockerSandboxEngine) {
    super(configService, engine);
  }
}
```

```ts
// opensandbox-runtime.provider.ts
import { Injectable } from "@nestjs/common";
import { ContainerRuntimeProvider } from "./container-runtime.provider";
import { ConfigService } from "../../config/config.service";
import { OpenSandboxEngine } from "./opensandbox-engine";

@Injectable()
export class OpenSandboxRuntimeProvider extends ContainerRuntimeProvider {
  readonly type = "opensandbox";
  constructor(configService: ConfigService, engine: OpenSandboxEngine) {
    super(configService, engine);
  }
}
```

- [ ] **Step 2: 删 SandboxRuntimeProvider**

```bash
git rm apps/server/src/runtime/sandbox/sandbox-runtime.provider.ts apps/server/src/runtime/sandbox/sandbox-runtime.provider.spec.ts
```

- [ ] **Step 3: 改 runtime.module.ts**

```ts
providers: [
  DockerSandboxEngine,
  { provide: OPENSANDBOX_CLIENT, useFactory: (c: ConfigService) => new OpenSandboxClient(c), inject: [ConfigService] },
  OpenSandboxEngine,
  LocalRuntimeProvider,
  DockerRuntimeProvider,
  OpenSandboxRuntimeProvider,
  { provide: RUNTIME_PROVIDERS, useFactory: (...p: RuntimeProvider[]) => p,
    inject: [LocalRuntimeProvider, DockerRuntimeProvider, OpenSandboxRuntimeProvider] },
  RuntimeService,
],
exports: [RuntimeService],
```

删 `SANDBOX_ENGINES` provider 与 `SandboxEngine`/`SANDBOX_ENGINES` import(container provider 直接注入具体引擎);更新 `runtime.module.spec.ts` 对 token 的断言(去掉 `SANDBOX_ENGINES`,加 3 个 provider 可解析)。

- [ ] **Step 4: typecheck**

Run: `pnpm --filter server typecheck`
Expected: runtime 内部干净。可能有下游对 `SandboxEngineType` / `getSandboxEngine` 的引用报错(Phase B 处理),确认报错都在 config/workspace/run-launcher/前端,不在 runtime provider 层。

- [ ] **Step 5: Commit**

```bash
git add -A apps/server/src/runtime
git commit -m "feat(runtime): split sandbox into docker/opensandbox peer providers"
```

---

## Phase B — runtimeType 域值迁移(shared / config / prisma / placement)

### Task 3: shared 契约三值 + 删 sandboxEngine

**Files:**
- Modify: `packages/shared/src/api/workspaces.ts`

- [ ] **Step 1: 改类型**

```ts
export type WorkspaceRuntimeType = "local" | "docker" | "opensandbox";
// 删除: export type SandboxEngineType = ...
```
- `WorkspaceResponse`:删 `sandboxEngine?: ... | null` 字段。
- `CreateWorkspaceRequest`:删 `sandboxEngine?: SandboxEngineType`。
- `WorkspaceCapabilitiesResponse`:删 `sandboxEngine: SandboxEngineType`。

- [ ] **Step 2: build/typecheck shared**

Run: `pnpm --filter shared typecheck`
Expected: PASS(shared 内部无其它引用)。

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/api/workspaces.ts
git commit -m "refactor(shared): runtimeType local|docker|opensandbox, drop sandboxEngine"
```

### Task 4: config 三值 + 删 getSandboxEngine

**Files:**
- Modify: `apps/server/src/config/config.service.ts`
- Modify: `apps/server/src/config/registry/defaults.ts`
- Modify: `apps/server/src/config/config.service.spec.ts`(相关断言)

- [ ] **Step 1: 改 config**

`config.service.ts`:
```ts
export type RuntimeType = "local" | "docker" | "opensandbox";
// 删除: export type SandboxEngineType = ...
const RUNTIME_TYPES = ["local", "docker", "opensandbox"] as const satisfies readonly RuntimeType[];
```
- `getAllowedRuntimeTypes` 的错误信息字符串更新为 `"local", "docker", "opensandbox"`。
- 删除 `getSandboxEngine()` 方法。
`defaults.ts`:删 `DEFAULT_SANDBOX_ENGINE`;`DEFAULT_ALLOWED_RUNTIME_TYPES = ["local"] as const` 保持。

- [ ] **Step 2: typecheck**

Run: `pnpm --filter server typecheck`
Expected: 报错集中在 workspace policy / run-launcher(调 `getSandboxEngine`)——Phase D/E 修。确认不在 config 内部。

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/config/config.service.ts apps/server/src/config/registry/defaults.ts apps/server/src/config/config.service.spec.ts
git commit -m "refactor(config): runtimeType three-value, remove sandboxEngine"
```

### Task 5: Prisma 删 sandboxEngine 列 + 重建

**Files:**
- Modify: `apps/server/prisma/schema.prisma`

- [ ] **Step 1: 删列**

`Workspace` model 删 `sandboxEngine String?` 一行。`runtimeType String?` 保留(值域变化不改列类型)。`WorkerInstance` 不动(`runtimeType String` + `@@unique([runtimeType, runtimeInstanceId])` 值域变化不改结构)。

- [ ] **Step 2: 重建 + 生成 client**

Run: `pnpm db:push` 然后 `pnpm --filter server exec prisma generate`(或仓库对应命令)。
Expected: 成功;Prisma client 类型里 `Workspace.sandboxEngine` 消失。

- [ ] **Step 3: Commit**

```bash
git add apps/server/prisma/schema.prisma
git commit -m "refactor(prisma): drop Workspace.sandboxEngine (dev rebuild, no migration)"
```

### Task 6: placement + runtime.types + RuntimeService.resolveRuntimeTarget

**Files:**
- Modify: `apps/server/src/runtime/runtime.types.ts`
- Modify: `apps/server/src/runtime/placement/runtime-resource.ts`
- Modify: `apps/server/src/runtime/runtime.service.ts`
- Modify: relevant specs

**Interfaces:**
- Produces: `CONTAINER_RUNTIME_TYPES` 常量(或 RuntimeService 用 provider `placementKind`);`ResolveRuntimeTargetInput` sandbox 分支去 `sandboxEngine`,改为 container 分支带 `isolationScope` + `runtimeType`(docker|opensandbox)。

- [ ] **Step 1: runtime.types.ts**

- `SandboxEngineType`:改为 `export type SandboxEngineType = string;`(或删除并把 `SandboxRuntime.engineType`/`SandboxPlacement`/`SANDBOX_ENGINE env` 改用 `string`;推荐保留为 `string` 别名,减少改动)。
- `ResolveRuntimeTargetInput`:
```ts
} & (
  | { runtimeType: "local" }
  | { runtimeType: string; isolationScope: ConfigIsolationScope } // container: docker|opensandbox
);
```
`isSandboxPlacement`(line 50):改名/改判为 container——`placement.runtimeType !== "local"` 或依据 `sandbox` 字段存在。保留函数名 `isSandboxPlacement` 但语义=容器(注释说明),或引入 `isContainerPlacement`。

- [ ] **Step 2: runtime-resource.ts `resolveRuntimeTarget`**

按 `runtimeType === "local"` → process placement;否则(container)→ sandbox placement,`sandbox.sandboxEngineType = input.runtimeType`(不再从 `input.sandboxEngine` 取)。删 `sandboxEngine` 解构。

- [ ] **Step 3: RuntimeService.resolveRuntimeTarget**

保持直通 `resolveRuntimeTarget(input)`;若 placement 计算需要区分 container/local,由 `runtimeType === "local"` 决定即可(不需要 provider);无需注入 provider 到纯函数。

- [ ] **Step 4: typecheck + specs**

Run: `pnpm --filter server test -- runtime-resource.spec.ts`
Expected: 改后 PASS(spec 里 sandbox case 的 `sandboxEngine` 入参去掉,`runtimeType` 用 `"docker"`)。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/runtime
git commit -m "refactor(runtime): placement resolves container by runtimeType, drop sandboxEngine input"
```

---

## Phase C — worker-manager / run 层收尾

### Task 7: lifecycle bootstrap seed 按 container 查询

**Files:**
- Modify: `apps/server/src/worker-manager/registry/worker-registry.repository.ts`
- Modify: `apps/server/src/worker-manager/lifecycle/lifecycle.service.ts`
- Modify: specs

- [ ] **Step 1: repository 加查询**

加 `findRunningContainerRows()`:`findMany({ where: { status: "running", runtimeType: { in: ["docker", "opensandbox"] } } })`(或参数化 container 类型集合)。

- [ ] **Step 2: lifecycle seed**

`onApplicationBootstrap`:把 `findRunningByRuntimeType("sandbox")` 换成 `findRunningContainerRows()`;其余(`markAllStartingAsError`、local orphan recover、`livenessStore.touch`)不变。

- [ ] **Step 3: test**

Run: `pnpm --filter server test -- lifecycle.service.spec.ts worker-registry.repository.spec.ts`
Expected: PASS。

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/worker-manager
git commit -m "refactor(worker-manager): seed liveness from container rows not runtimeType=sandbox"
```

### Task 8: run-launcher + run-recovery + run-event 观测

**Files:**
- Modify: `apps/server/src/run/launch/run-launcher.ts`
- Modify: `apps/server/src/run/recovery/run-recovery.service.ts`
- Modify: `apps/server/src/run-event/run-event.service.ts`
- Modify: specs

- [ ] **Step 1: run-launcher `getPlacement`**

去掉 sandbox 分支里 `sandboxEngine: (workspace.sandboxEngine ...) ?? getSandboxEngine()`。新逻辑:`runtimeType = workspace.runtimeType ?? getDefaultRuntimeType()`;`local` → `resolveRuntimeTarget({...base, runtimeType:"local"})`;否则 container → 需要 `isolationScope`,`resolveRuntimeTarget({...base, runtimeType, isolationScope})`。删 `as "docker"|"opensandbox"` cast。

- [ ] **Step 2: run-recovery**

`run.runtimeType === "local"` 判断保持(local 不恢复);确认无其它 sandbox 假设(container 类型走恢复路径,行为同原 sandbox)。

- [ ] **Step 3: run-event**

`sandboxEngineType` 观测:改用 `runtimeType`(现在就是引擎名)或从 placement 取 `sandbox.sandboxEngineType`(= runtimeType)。保持观测字段名或改名,按现有前端/dashboard 消费决定;若无消费,直接用 runtimeType。

- [ ] **Step 4: typecheck + test**

Run: `pnpm --filter server typecheck` → server 全绿。
Run: `pnpm --filter server test -- run-launcher.spec.ts`(若有)+ 全量 server 套件。
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/run apps/server/src/run-event
git commit -m "refactor(run): resolve placement by runtimeType, drop sandboxEngine mapping"
```

### Task 9: workspace 模块去 sandboxEngine

**Files:**
- Modify: `apps/server/src/workspace/runtime/workspace-runtime.policy.ts`
- Modify: `apps/server/src/workspace/workspace.service.ts`
- Modify: `apps/server/src/workspace/workspace.repository.ts`
- Modify: `apps/server/src/workspace/workspace.controller.ts`
- Modify: `apps/server/src/workspace/workspace.types.ts`
- Modify: `apps/server/src/workspace/dto/create-workspace.dto.ts`
- Modify: specs

- [ ] **Step 1: policy**

- 删 `normalizeSandboxEngine`。
- `supportsCustomRootPath`(line 82-83):`runtimeType === "local" || (isContainer && isolationScope === "workspace")` —— 用 container 判断(`runtimeType !== "local"`)替代 `=== "sandbox"`。
- `normalizeIsolationScope`(line 120):`runtimeType === "local"`(local 禁 isolationScope)→ 用 `runtimeType === "local"` 直接判(non-local = container = 允许 isolationScope)。
- capabilities(line 30):删 `sandboxEngine: getSandboxEngine()`。

- [ ] **Step 2: service / repository / controller / types / dto**

- `create-workspace.dto.ts`:删 `sandboxEngine?: "docker"|"opensandbox"`;`runtimeType` DTO 值域校验更新为三值(若用 `@IsIn`)。
- `workspace.service.ts`(line 33,99,130,136-162,233):删 `sandboxEngine` 解构/透传/入库;`resolveCreateRuntime` 去 engine。
- `workspace.repository.ts`(line 30,93):删 `sandboxEngine` 字段/写入。
- `workspace.controller.ts`(line 32):删 `sandboxEngine: body.sandboxEngine`。
- `workspace.types.ts`(line 11):删 `sandboxEngine?`。

- [ ] **Step 3: typecheck + test**

Run: `pnpm --filter server typecheck` → 全绿。
Run: `pnpm --filter server test -- workspace` 相关 spec + 全量。
Expected: PASS。

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/workspace
git commit -m "refactor(workspace): drop sandboxEngine, runtimeType drives container/isolation"
```

---

## Phase D — 前端

### Task 10: 前端 runtimeType 三值 + 去 sandboxEngine

**Files:**
- Modify: `apps/web/src/components/workspace-dialog.tsx`
- Modify: `apps/web/src/components/sidebar/workspace-group.tsx`
- Modify: `apps/web/src/components/workspace-selector.tsx`
- Modify: `apps/web/src/components/assistant-ui/thread-composer.tsx`
- Modify: `apps/web/src/api/runtime.ts`
- Modify: `apps/web/src/api/workspaces.test.ts`

- [ ] **Step 1: workspace-dialog.tsx**

- `RUNTIME_TYPES`(line 44):`["local", "docker", "opensandbox"] as const`。
- ToggleGroup 选项文案(line 417-466):`local → "本地"`、`docker → "Docker"`、`opensandbox → "OpenSandbox"`。
- isolationScope 耦合(line 228-230、468+):`runtimeType === "sandbox"` → `runtimeType !== "local"`(container 才带 isolationScope)。
- 辅助函数(line 696-717)`isWorkspaceRuntimeType`/`resolveRuntimeTypeChange`/`supportsCustomRootPath`:`=== "local" | "sandbox"` → 三值 / `!== "local"`。
- 无 sandboxEngine 选择器(本就没有),提交 payload 不再含 sandboxEngine(本就没提交)。

- [ ] **Step 2: workspace-group.tsx**

- `runtimeLabel`(line 308-311):`local → "本地"`,`docker → "Docker"`,`opensandbox → "OpenSandbox"`(直接映射 runtimeType,不再 `=== "sandbox"` + sandboxEngineLabel)。
- 删 `sandboxEngineLabel`(line 319-325)与 line 254-257 对它的调用及 `workspace.sandboxEngine` 读取。

- [ ] **Step 3: workspace-selector.tsx / thread-composer.tsx / runtime.ts**

- `workspace-selector.tsx`(line 31,178):`runtimeType?: "local"|"docker"|"opensandbox"`;`=== "sandbox"` → `!== "local"`。
- `thread-composer.tsx`(line 280):`runtimeType === "sandbox"` → `!== "local"`。
- `api/runtime.ts`(line 10-11):`runtimeType: string` 保持(已宽松)。
- `workspaces.test.ts`(line 54):`runtimeType: 'local'` 保持;若有断言 sandboxEngine 则删。

- [ ] **Step 4: typecheck + test**

Run: `pnpm --filter web typecheck` → 绿。
Run: `pnpm --filter web test` → PASS。
Run: `pnpm --filter web exec eslint src` → clean。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src
git commit -m "refactor(web): runtimeType local|docker|opensandbox, drop sandboxEngine UI"
```

---

## Phase E — 全量验证

### Task 11: 全量 typecheck + test + eslint + 冒烟

- [ ] **Step 1: 全量 typecheck**

Run: `pnpm typecheck`
Expected: 7/7 包全绿。

- [ ] **Step 2: server + web 测试**

Run: `pnpm test:server` 与 `pnpm test:web`
Expected: 全 PASS。

- [ ] **Step 3: eslint(type-aware)**

Run: server + web 的 eslint。
Expected: 0 errors。

- [ ] **Step 4: grep 残留**

Run: `grep -rn "sandboxEngine\|\"sandbox\"\|'sandbox'" apps/server/src apps/web/src packages/shared/src | grep -v ".spec.\|.test."`
Expected: 无遗留 `sandboxEngine` 或对 `"sandbox"` runtimeType 的判断(引擎实现类名 DockerSandboxEngine/OpenSandboxEngine 除外)。

- [ ] **Step 5: 冒烟(环境允许时)**

创建一个 `docker` runtimeType 的 workspace,发一次 run,确认容器起来、worker 注册 ready;创建 `local` workspace 发 run 确认 fork 路径。

---

## Self-Review 结果

- **Spec 覆盖(§4.7)**:shared/config/prisma/run-launcher/前端 迁移→Task 3-10;provider 拆分→Task 1-2;placement trait→Task 6(用 `runtimeType==="local"` 区分 container/process,`placementKind` 已在 provider 上但纯 placement 函数用 local 判断即可);lifecycle seed→Task 7。
- **占位符**:无 TODO/TBD;新单元给完整代码,迁移点给精确文件:行 + 前后值。
- **类型一致**:`RuntimeType`/`WorkspaceRuntimeType` 三处(shared/config/前端)同为 `local|docker|opensandbox`;`ContainerRuntimeProvider` 子类 `type` 与引擎 `type` 对齐(docker/opensandbox)。
- **风险**:DB 重建丢数据(dev 可接受);`isSandboxPlacement` 语义从"sandbox"变"container",若别处依赖其精确含义需核;`run-event` 观测字段改名可能影响 dashboard(Task 8 Step 3 已标注按消费决定)。
