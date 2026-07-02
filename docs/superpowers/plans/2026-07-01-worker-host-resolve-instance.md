# WorkerHostService.resolveInstance() 落地 — Run 依赖收拢为唯一 worker-host(Phase 4)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `run` 模块对"取得/释放/回收 runtime 实例"这件事的认知,从"自己按 runtimeType 选择 `SandboxRunExecutor` 还是 `LocalRunExecutor` 两个类、各自分别调用 `WorkerHostService` 上八个 sandbox/local 专属方法"收拢成"调用 `WorkerHostService` 上四个统一方法(`resolveInstance`/`releaseInstanceForRun`/`recoverOrphanInstance`/`shutdownInstanceByOwnerId`),runtimeType 判断完全被 `worker-host` 内部吸收"。这是设计文档 `docs/superpowers/specs/2026-06-30-agent-run-new-architecture-design.md` 第一节明确要的目标状态("`run` 只依赖 `worker-host` 一个模块"),也是 `apps/api/src/worker-host/worker-host.service.ts:100-103` 里 Phase 1 就留下的路标注释("后续 resolveInstance() 落地后,部分方法可能会被更贴合业务语义的编排方法取代")。

**Architecture:**

现状核实(Phase 1-3 结束时,已用 Explore 核实过代码):`run` 模块目前仍然**同时**依赖 `RuntimeModule`(`RunLauncher` 直接注入 `RuntimeService`,调用 `resolveRuntimeTarget()` 算 placement)和 `WorkerHostModule`(经 `ExecutionService` → `RunExecutorRegistry` 按 `runtimeType` 选出 `SandboxRunExecutor` 或 `LocalRunExecutor`,两个类各自直接调用 `WorkerHostService` 的 `acquireSandboxInstanceForRun`/`acquireLocalInstanceForRun` 等八个 sandbox/local 专属方法)。这正是设计文档第一节说明确要收窄掉的:"`run` 现在只依赖 `worker-host` 一个模块——不是'只调一个方法'就完事……这些都是 `worker-host` 内部的事,不摊在调用方面前"(spec 38 行)。

比对 `SandboxRunExecutor`/`LocalRunExecutor` 两个文件(已逐行核实),除了各自调用的 `WorkerHostService` 方法名不同(sandbox 版 vs local 版)之外,`start`/`sendCommand`/`cancel`/`cleanup` 的控制流完全同构;唯一的行为差异点(sandbox 的 `cancel()`/`onAcquired` 取消分支会调 `releaseSandboxInstanceForRun`,local 版因为 `releaseLocalInstanceForRun` 本来就是 no-op 而省略了调用)在统一之后收敛成"两边都调 `releaseInstanceForRun`,local 分支内部照样是 no-op"——不改变任何可观察行为。

搬家后的落点:

1. **`WorkerHostService` 新增四个统一方法**:`resolveRuntimeTarget(input)`(placement 计算的直通转发,替代 `run` 直接注入 `RuntimeService`)、`resolveInstance(input)`(替代 `acquireSandboxInstanceForRun`/`acquireLocalInstanceForRun`,按 `input.runtimeTarget.runtimeType` 内部分流)、`releaseInstanceForRun(runtimeType, runId)`(替代 `releaseSandboxInstanceForRun`/`releaseLocalInstanceForRun`)、`recoverOrphanInstance(runtimeType, runtimeInstanceId)`(替代 `recoverOrphanSandboxInstance`/`recoverOrphanLocalInstance`)。`shutdownInstanceByOwnerId(runtimeType, ownerId)` 替代 `shutdownSandboxInstanceByOwnerId`/`shutdownLocalInstanceByOwnerId`,顺带把 `stopRuntimeInstance()` 里手写的 if/else 收成一次调用。
2. **`run/execution/` 下 `SandboxRunExecutor` + `LocalRunExecutor` 合并成一个 `WorkerRunExecutor`**:因为 runtimeType 判断已经被 `WorkerHostService` 内部吸收,`run` 侧不再需要按类型选择不同执行器——`RunExecutorRegistry`/`RUN_EXECUTORS` 这个按类型查找的注册表因此失去存在意义(只剩一个实现,是死抽象),一并删除。`ExecutionService` 直接持有唯一的 `WorkerRunExecutor` 实例,不再经过 registry 查找。
3. **`RunLauncher` 改注入 `WorkerHostService`,不再注入 `RuntimeService`**:placement 计算这一步(`getPlacement()`)从直接调 `RuntimeService.resolveRuntimeTarget()` 改成调 `WorkerHostService.resolveRuntimeTarget()`。
4. **`run.module.ts` 摘掉 `RuntimeModule` import**:改造完成后,`run` 模块 `imports` 只剩 `WorkerHostModule`/`RunEventModule`/`ConversationModule`。

**本轮明确排除、留给后续阶段的范围(记录在案,不是遗漏)**:
- **3.7 节"启动握手状态机"(`starting`/`missing` 状态、并发 launch 防重、`runtime_instance_active_owner_idx` 唯一索引的真正使用)**——这条索引已在 Phase 1 建好但从未被任何写路径用到;真正落地需要设计"插入 starting 行 → 等待就绪 → 超时/失败转 error"这一整套状态机,并且和"仍待讨论"第 2 条(Worker 自注册协议字段)有交叉,细节比这次的纯搬家改动重得多,值得单独一个阶段处理。
- **"仍待讨论"第 12 条**(重启后不再物理拆实例,改发 `cancel` 命令)与**第 13 条**(重启后 local 残留 `starting`/`running` 行的清理)——这两条互相牵连(第 13 条的解法依赖第 12 条把 `RunRecoveryService` 里"物理拆实例"这条路径先挪走),且第 13 条明确写着"不设计具体替代方案,实现落地前必须处理"——处理它需要新写一段"API 启动时清理残留 local 行"的逻辑,同样值得单独一个阶段,不跟这次的纯搬家改动混在一起。
- 除了内部调用路径的重组(`run` 侧从两个 executor 类收成一个、`WorkerHostService` 方法从八个收成四个)之外,**本轮不改变任何现有可观察行为**——sandbox 的 owner 复用/idle 超时逻辑、local 的 keep-alive 复用逻辑、admin 查询的 URL 与响应形状,全部保持不变。

**Tech Stack:** NestJS 11、TypeScript、Vitest(手搓 mock + 构造函数注入,除 `run.module.spec.ts` 本身验证 module wiring 用 `Test.createTestingModule`)。

## Global Constraints

- 后端命名规则见 `.claude/rules/backend-naming.md`,模块边界规则见 `.claude/rules/backend-architecture.md`——repository/internal provider 不导出,跨模块只调对方导出的根 Service,禁止 `forwardRef`,禁止循环依赖。`ResolveRuntimeTargetInput` 这个类型目前定义在 `runtime/placement/runtime-resource.ts`(非 `runtime.types.ts`),不是合法的跨模块契约面——本轮 Task 1 要先把它挪进 `runtime.types.ts`,`worker-host` 才能合法引用。
- 每个 task 结束时代码库必须能通过 `pnpm --filter api typecheck`、`pnpm --filter api lint`、`pnpm --filter api test`。Task 1-2 只做新增(旧方法/旧文件原样保留),现有测试全部原样通过;Task 3 是"翻转"任务,删除旧文件、切换调用点,完成后现有 + 新增测试全部通过。
- 不做本轮范围外的事:不新增 `starting`/`missing` 状态或任何 WorkerRegistry 状态机改动,不碰 `RunRecoveryService` 的物理清理逻辑,不加自注册鉴权,不改 sandbox/local 的 owner 复用或 idle 超时语义。
- 改动只涉及 `apps/api`,不涉及 `apps/worker`/`packages/*`/前端。

---

### Task 1: `WorkerHostService` 新增四个统一方法(纯新增,旧方法保留)

**Files:**
- Modify: `apps/api/src/runtime/placement/runtime-resource.ts`(把 `ResolveRuntimeTargetInput` 挪到 `runtime.types.ts`,这里改成 import)
- Modify: `apps/api/src/runtime/runtime.types.ts`(新增 `ResolveRuntimeTargetInput` 类型定义)
- Modify: `apps/api/src/runtime/runtime.service.ts`(`resolveRuntimeTarget` 的入参类型改成从 `./runtime.types` 引入)
- Modify: `apps/api/src/worker-host/worker-host.service.ts`(新增四个方法,旧的八个方法原样保留)
- Modify: `apps/api/src/worker-host/worker-host.service.spec.ts`(新增对应测试)

**Interfaces:**
- Produces:
  - `WorkerHostService.resolveRuntimeTarget(input: ResolveRuntimeTargetInput): RuntimeTarget`
  - `WorkerHostService.resolveInstance(input: WorkerExecutionStartInput): Promise<AcquireInstanceResult>`
  - `WorkerHostService.releaseInstanceForRun(runtimeType: string, runId: string): void`
  - `WorkerHostService.recoverOrphanInstance(runtimeType: string, runtimeInstanceId: string): Promise<void>`
  - `WorkerHostService.shutdownInstanceByOwnerId(runtimeType: string, ownerId: string): void`
  - Task 2 消费这五个方法。

- [ ] **Step 1: 把 `ResolveRuntimeTargetInput`/`RuntimeTargetDefaults` 挪进 `runtime.types.ts`**

在 `apps/api/src/runtime/runtime.types.ts` 顶部新增 import 与类型定义(文件末尾追加,其余内容不变):

```ts
import type { IsolationScope as ConfigIsolationScope, RuntimeType } from "../config/config.service";
```

在文件末尾追加:

```ts
// ── Placement 解析契约类型(worker-host 的 WorkerHostService.resolveRuntimeTarget()
// 与 runtime 的 RuntimeService.resolveRuntimeTarget() 之间唯一合法的类型契约面) ──

export type ResolveRuntimeTargetInput = {
  userId: string;
  workspaceId: string;
  workspaceRootPath: string;
  userWorkspaceRootPath: string;
  /** 不传则用 defaults.runtimeType */
  runtimeType?: RuntimeType;
  /** sandbox 下不传则用 defaults.isolationScope；local 不消费 */
  isolationScope?: ConfigIsolationScope;
  /** sandbox 下不传则用 defaults.sandboxEngine；local 不消费 */
  sandboxEngine?: "docker" | "opensandbox";
};

/** 部署默认值（由 RuntimeService 从 ConfigService 取出后传入）。 */
export type RuntimeTargetDefaults = {
  runtimeType: RuntimeType;
  isolationScope: ConfigIsolationScope;
  sandboxEngine: "docker" | "opensandbox";
};
```

- [ ] **Step 2: `runtime-resource.ts` 改成从 `runtime.types.ts` 引入这两个类型**

编辑 `apps/api/src/runtime/placement/runtime-resource.ts`,把现有的:

```ts
import type {
  LocalRuntimePlacement,
  RuntimeTarget,
  SandboxRuntimePlacement,
} from "@agework/shared/protocol";
import type { IsolationScope, RuntimeType } from "../../config/config.service";
import { CONTAINER_WORKSPACES_ROOT } from "../../config/registry/defaults";

export type ResolveRuntimeTargetInput = {
  userId: string;
  workspaceId: string;
  workspaceRootPath: string;
  userWorkspaceRootPath: string;
  /** 不传则用 defaults.runtimeType */
  runtimeType?: RuntimeType;
  /** sandbox 下不传则用 defaults.isolationScope；local 不消费 */
  isolationScope?: IsolationScope;
  /** sandbox 下不传则用 defaults.sandboxEngine；local 不消费 */
  sandboxEngine?: "docker" | "opensandbox";
};

/** 部署默认值（由 RuntimeService 从 ConfigService 取出后传入）。 */
export type RuntimeTargetDefaults = {
  runtimeType: RuntimeType;
  isolationScope: IsolationScope;
  sandboxEngine: "docker" | "opensandbox";
};
```

替换为:

```ts
import type {
  LocalRuntimePlacement,
  RuntimeTarget,
  SandboxRuntimePlacement,
} from "@agework/shared/protocol";
import { CONTAINER_WORKSPACES_ROOT } from "../../config/registry/defaults";
import type {
  ResolveRuntimeTargetInput,
  RuntimeTargetDefaults,
} from "../runtime.types";

export type { ResolveRuntimeTargetInput, RuntimeTargetDefaults };
```

（`export type { ... }` 是为了不破坏本文件内后面 `resolveRuntimeTarget()` 函数签名对这两个名字的直接引用；其余函数体不变。）

- [ ] **Step 3: 确认 `runtime.service.ts` 编译通过**

`apps/api/src/runtime/runtime.service.ts` 现有的:

```ts
import {
  resolveRuntimeTarget,
  type ResolveRuntimeTargetInput,
  type RuntimeTargetDefaults,
} from "./placement/runtime-resource";
```

不需要改动——因为 Step 2 让 `runtime-resource.ts` 继续 `export type` 这两个名字。运行 `pnpm --filter api typecheck` 确认无报错。

- [ ] **Step 4: 运行现有 runtime 测试确认零回归**

Run: `pnpm --filter api test -- runtime`
Expected: 全部通过(`runtime.service.spec.ts`、`runtime-resource.spec.ts`、`runtime.module.spec.ts` 等)。

- [ ] **Step 5: 给 `WorkerHostService` 新增 `resolveRuntimeTarget()`**

编辑 `apps/api/src/worker-host/worker-host.service.ts`,在文件顶部 import 区新增:

```ts
import type { ResolveRuntimeTargetInput } from "../runtime/runtime.types";
```

在 `setUpstreamPort` 方法之后(既有 `openSession`/`sendCommand` 方法群之前或之后均可,建议紧跟 `setUpstreamPort` 之后)新增:

```ts
  /** 从 run 输入解析出目标运行环境(纯计算,不启动 worker)。直通转发 runtime 模块。 */
  resolveRuntimeTarget(input: ResolveRuntimeTargetInput) {
    return this.runtimeService.resolveRuntimeTarget(input);
  }
```

- [ ] **Step 6: 给 `resolveRuntimeTarget()` 写单测**

在 `apps/api/src/worker-host/worker-host.service.spec.ts` 的顶层 `describe("WorkerHostService — facade routing", ...)` 块内新增一个 `it`(参照同 describe 块里其它 facade 转发测试的写法,`makeService()` 已经有 `runtimeService as never` 占位,这里改成真正的 mock):

先找到本文件里已有的顶层 `function makeService() { ... }`(约在文件开头,构造 `endpointHandler`/`upstream`/`commandDispatcher`/`localInstances` 后 `new WorkerHostService(..., {} as never, {} as never, localInstances as never)` 那处——第 5、6 个参数目前是 `{} as never`,对应构造函数的 `runtimeService`、`sandboxInstances`),把该函数改成:

```ts
function makeService() {
  const endpointHandler = {
    pollCommands: vi.fn(),
    getRunConfig: vi.fn(),
    postEvent: vi.fn(),
  };
  const upstream = {
    setUpstreamPort: vi.fn(),
  };
  const commandDispatcher = {
    openSession: vi.fn(),
    sendCommand: vi.fn(),
    cleanupRun: vi.fn(),
    cleanupByOwnerId: vi.fn(),
  };
  const localInstances = {
    getChannel: vi.fn().mockReturnValue(undefined),
  };
  const runtimeService = {
    resolveRuntimeTarget: vi.fn(),
  };
  const service = new WorkerHostService(
    endpointHandler as unknown as WorkerEndpointHandler,
    upstream as unknown as WorkerUpstreamRegistry,
    commandDispatcher as unknown as WorkerCommandDispatcher,
    {} as unknown as WorkerRegistryRepository,
    runtimeService as never,
    {} as never,
    localInstances as never
  );
  return { service, endpointHandler, upstream, commandDispatcher, runtimeService };
}
```

然后在 `describe("WorkerHostService — facade routing", ...)` 块内新增:

```ts
  it("routes resolveRuntimeTarget to RuntimeService", () => {
    const { service, runtimeService } = makeService();
    const target = { runtimeType: "local", ownerId: "ws-1" } as never;
    runtimeService.resolveRuntimeTarget.mockReturnValue(target);

    const input = {
      userId: "user-1",
      workspaceId: "ws-1",
      workspaceRootPath: "/tmp/ws-1",
      userWorkspaceRootPath: "/tmp/user-1",
    };
    expect(service.resolveRuntimeTarget(input)).toBe(target);
    expect(runtimeService.resolveRuntimeTarget).toHaveBeenCalledWith(input);
  });
```

- [ ] **Step 7: 运行测试确认新增用例通过**

Run: `pnpm --filter api test -- worker-host.service`
Expected: 全部通过,含新增的 `resolveRuntimeTarget` 用例。

- [ ] **Step 8: 给 `WorkerHostService` 新增 `resolveInstance()`**

在 `worker-host.service.ts` 里,紧跟着现有的 `acquireLocalInstanceForRun` 方法(local 实例编排那个 `// ── local 实例编排 ──` 分组的最后)之后,新增一个新分组:

```ts
  // ── 统一实例编排入口(resolveInstance 落地,替代按 runtimeType 分别调用 sandbox/local
  // 专属方法——runtimeType 判断收进这里,run 层不再需要认识 sandbox/local 的区别) ──

  /** 为一次 run 取得(创建/复用/attach)runtime 实例,按 runtimeType 内部分流。 */
  resolveInstance(
    input: WorkerExecutionStartInput
  ): Promise<AcquireInstanceResult> {
    if (input.runtimeTarget.runtimeType === "local") {
      return this.localInstances.acquireInstanceForRun(input);
    }
    return this.sandboxInstances.acquireInstanceForRun(input);
  }

  /** 释放一次 run 对 runtime 实例的引用,按 runtimeType 内部分流。 */
  releaseInstanceForRun(runtimeType: string, runId: string): void {
    if (runtimeType === "local") {
      this.localInstances.releaseInstanceForRun(runId);
      return;
    }
    this.sandboxInstances.releaseInstanceForRun(runId);
  }

  /** 服务重启后清理中断执行残留的 runtime 实例,按 runtimeType 内部分流。 */
  recoverOrphanInstance(
    runtimeType: string,
    runtimeInstanceId: string
  ): Promise<void> {
    if (runtimeType === "local") {
      return this.localInstances.recoverOrphan(runtimeInstanceId);
    }
    return this.sandboxInstances.recoverOrphan(runtimeInstanceId);
  }

  /** 终止并清理指定 owner 的 runtime 实例,按 runtimeType 内部分流。 */
  shutdownInstanceByOwnerId(runtimeType: string, ownerId: string): void {
    if (runtimeType === "local") {
      this.localInstances.shutdownRuntimeInstanceByOwnerId(ownerId);
      return;
    }
    this.sandboxInstances.shutdownRuntimeInstanceByOwnerId(ownerId);
  }
```

- [ ] **Step 9: 给四个统一方法写单测**

在 `worker-host.service.spec.ts` 文件末尾(`describe("WorkerHostService local instance orchestration", ...)` 块之后)新增一个新的顶层 describe 块:

```ts
describe("WorkerHostService — resolveInstance unified dispatch", () => {
  function makeService() {
    const sandboxInstances = {
      acquireInstanceForRun: vi.fn(),
      releaseInstanceForRun: vi.fn(),
      recoverOrphan: vi.fn(),
      shutdownRuntimeInstanceByOwnerId: vi.fn(),
    };
    const localInstances = {
      getChannel: vi.fn().mockReturnValue(undefined),
      acquireInstanceForRun: vi.fn(),
      releaseInstanceForRun: vi.fn(),
      recoverOrphan: vi.fn(),
      shutdownRuntimeInstanceByOwnerId: vi.fn(),
    };
    const service = new WorkerHostService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      sandboxInstances as never,
      localInstances as never
    );
    return { service, sandboxInstances, localInstances };
  }

  it("resolveInstance dispatches to the local executor for local placements", async () => {
    const { service, localInstances } = makeService();
    const input = { runtimeTarget: { runtimeType: "local" } } as never;
    localInstances.acquireInstanceForRun.mockResolvedValue({
      outcome: "ready",
      runtimeInstanceId: "1:token",
    });

    await expect(service.resolveInstance(input)).resolves.toEqual({
      outcome: "ready",
      runtimeInstanceId: "1:token",
    });
    expect(localInstances.acquireInstanceForRun).toHaveBeenCalledWith(input);
  });

  it("resolveInstance dispatches to the sandbox executor for sandbox placements", async () => {
    const { service, sandboxInstances } = makeService();
    const input = { runtimeTarget: { runtimeType: "sandbox" } } as never;
    sandboxInstances.acquireInstanceForRun.mockResolvedValue({
      outcome: "ready",
      runtimeInstanceId: "container-1",
    });

    await expect(service.resolveInstance(input)).resolves.toEqual({
      outcome: "ready",
      runtimeInstanceId: "container-1",
    });
    expect(sandboxInstances.acquireInstanceForRun).toHaveBeenCalledWith(input);
  });

  it("releaseInstanceForRun dispatches by runtimeType", () => {
    const { service, sandboxInstances, localInstances } = makeService();
    service.releaseInstanceForRun("local", "run-1");
    service.releaseInstanceForRun("sandbox", "run-2");
    expect(localInstances.releaseInstanceForRun).toHaveBeenCalledWith("run-1");
    expect(sandboxInstances.releaseInstanceForRun).toHaveBeenCalledWith(
      "run-2"
    );
  });

  it("recoverOrphanInstance dispatches by runtimeType", async () => {
    const { service, sandboxInstances, localInstances } = makeService();
    await service.recoverOrphanInstance("local", "4242:token");
    await service.recoverOrphanInstance("sandbox", "container-1");
    expect(localInstances.recoverOrphan).toHaveBeenCalledWith("4242:token");
    expect(sandboxInstances.recoverOrphan).toHaveBeenCalledWith(
      "container-1"
    );
  });

  it("shutdownInstanceByOwnerId dispatches by runtimeType", () => {
    const { service, sandboxInstances, localInstances } = makeService();
    service.shutdownInstanceByOwnerId("local", "ws-1");
    service.shutdownInstanceByOwnerId("sandbox", "ws-2");
    expect(
      localInstances.shutdownRuntimeInstanceByOwnerId
    ).toHaveBeenCalledWith("ws-1");
    expect(
      sandboxInstances.shutdownRuntimeInstanceByOwnerId
    ).toHaveBeenCalledWith("ws-2");
  });
});
```

- [ ] **Step 10: 跑完整 worker-host 测试 + typecheck + lint**

Run: `pnpm --filter api test -- worker-host`
Expected: 全部通过(含 Task 1 新增的两个 describe 块)。

Run: `pnpm --filter api typecheck && pnpm --filter api lint`
Expected: 零报错。

- [ ] **Step 11: Commit**

```bash
git add apps/api/src/runtime/runtime.types.ts apps/api/src/runtime/placement/runtime-resource.ts apps/api/src/runtime/runtime.service.ts apps/api/src/worker-host/worker-host.service.ts apps/api/src/worker-host/worker-host.service.spec.ts
git commit -m "feat(api): add WorkerHostService.resolveInstance() unified dispatch (not wired yet)"
```

---

### Task 2: 新建合并后的 `WorkerRunExecutor`(新文件,尚未接线)

**Files:**
- Create: `apps/api/src/run/execution/worker-run.executor.ts`
- Create: `apps/api/src/run/execution/worker-run.executor.spec.ts`
- Modify: `apps/api/src/run/run.module.ts`(把新类加进 `providers`,不改其余任何 wiring)

**Interfaces:**
- Consumes: `WorkerHostService.resolveInstance/releaseInstanceForRun/recoverOrphanInstance/openSession/sendCommand/cleanupRun`(Task 1 产出 + 既有方法)。
- Produces: `WorkerRunExecutor`——`start(input)`/`sendCommand(handle, command)`/`cancel(handle)`/`terminateExecution(runId, reason)`/`cleanup(runId)`/`cleanupInterruptedExecution(runtimeType, runtimeInstanceId)`/`setRunEventPort(receiver)`。Task 3 消费这个类(替换 `SandboxRunExecutor`/`LocalRunExecutor`)。本 task 暂不加 `implements RunExecutor`(接口签名要到 Task 3 才改,避免旧的两个类在过渡期间出现签名不一致)。

- [ ] **Step 1: 写 `WorkerRunExecutor` 的失败测试(先写用例,驱动实现)**

创建 `apps/api/src/run/execution/worker-run.executor.spec.ts`(以现有 `sandbox.executor.spec.ts` 为参照,合并 sandbox/local 两套用例、按 `runtimeTarget.runtimeType` 参数化):

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  AcquireInstanceResult,
  RuntimeTarget,
  WorkerExecutionStartInput,
} from "@agework/shared/protocol";
import { WorkerRunExecutor } from "./worker-run.executor";
import { WorkerHostService } from "../../worker-host/worker-host.service";

function makeWorkerHost() {
  return {
    resolveInstance: vi.fn(),
    releaseInstanceForRun: vi.fn(),
    recoverOrphanInstance: vi.fn(),
    openSession: vi.fn(),
    sendCommand: vi.fn(),
    cleanupRun: vi.fn(),
  };
}

function makeRuntimeTarget(runtimeType: "local" | "sandbox"): RuntimeTarget {
  return {
    runtimeType,
    ownerId: "ws-1",
    userId: "user-1",
    workspaceId: "ws-1",
    hostPath: "/tmp/ws-1",
    runtimePath: "/tmp/ws-1",
    ...(runtimeType === "sandbox"
      ? {
          sandbox: {
            isolationScope: "workspace" as const,
            mountTarget: "/workspace",
            sandboxEngineType: "docker" as const,
          },
        }
      : {}),
  } as RuntimeTarget;
}

function makeInput(
  runtimeType: "local" | "sandbox"
): WorkerExecutionStartInput {
  return {
    runConfig: {
      runId: "run-1",
      conversationId: "conversation-1",
    } as WorkerExecutionStartInput["runConfig"],
    runtimeTarget: makeRuntimeTarget(runtimeType),
  };
}

describe.each(["local", "sandbox"] as const)(
  "WorkerRunExecutor (%s)",
  (runtimeType) => {
    let workerHost: ReturnType<typeof makeWorkerHost>;
    let executor: WorkerRunExecutor;
    let receiver: {
      recordCommandSent: ReturnType<typeof vi.fn>;
      notifyWorkerError: ReturnType<typeof vi.fn>;
      notifyCancelledBeforeReady: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      workerHost = makeWorkerHost();
      executor = new WorkerRunExecutor(workerHost as unknown as WorkerHostService);
      receiver = {
        recordCommandSent: vi.fn().mockResolvedValue(undefined),
        notifyWorkerError: vi.fn().mockResolvedValue(undefined),
        notifyCancelledBeforeReady: vi.fn().mockResolvedValue(undefined),
      };
      executor.setRunEventPort(receiver as never);
    });

    it("calls resolveInstance and opens the session once the instance is ready", async () => {
      const ready: AcquireInstanceResult = {
        outcome: "ready",
        runtimeInstanceId: "instance-1",
      };
      workerHost.resolveInstance.mockResolvedValue(ready);
      const input = makeInput(runtimeType);

      const handle = executor.start(input);
      expect(handle.runtimeType).toBe(runtimeType);
      expect(workerHost.resolveInstance).toHaveBeenCalledWith(input);

      await Promise.resolve();
      await Promise.resolve();

      expect(workerHost.openSession).toHaveBeenCalledWith({
        runId: "run-1",
        ownerId: "ws-1",
        runConfig: input.runConfig,
      });
      expect(workerHost.sendCommand).toHaveBeenCalledWith(
        "ws-1",
        "run-1",
        expect.objectContaining({ type: "user_message" })
      );
    });

    it("notifies worker error when resolveInstance settles as error", async () => {
      workerHost.resolveInstance.mockResolvedValue({
        outcome: "error",
        error: "boom",
      });
      executor.start(makeInput(runtimeType));

      await Promise.resolve();
      await Promise.resolve();

      expect(receiver.notifyWorkerError).toHaveBeenCalledWith(
        "run-1",
        "boom"
      );
    });

    it("releases the instance through releaseInstanceForRun on cleanup", () => {
      workerHost.resolveInstance.mockResolvedValue(
        new Promise(() => {
          /* never resolves */
        })
      );
      executor.start(makeInput(runtimeType));

      executor.cleanup("run-1");

      expect(workerHost.cleanupRun).toHaveBeenCalledWith("run-1");
      expect(workerHost.releaseInstanceForRun).toHaveBeenCalledWith(
        runtimeType,
        "run-1"
      );
    });

    it("cleanupInterruptedExecution forwards runtimeType and runtimeInstanceId to recoverOrphanInstance", async () => {
      workerHost.recoverOrphanInstance.mockResolvedValue(undefined);

      await executor.cleanupInterruptedExecution(runtimeType, "instance-1");

      expect(workerHost.recoverOrphanInstance).toHaveBeenCalledWith(
        runtimeType,
        "instance-1"
      );
    });
  }
);
```

- [ ] **Step 2: 运行测试确认失败(尚未实现)**

Run: `pnpm --filter api test -- worker-run.executor`
Expected: FAIL(`Cannot find module './worker-run.executor'`)。

- [ ] **Step 3: 实现 `WorkerRunExecutor`**

创建 `apps/api/src/run/execution/worker-run.executor.ts`(以现有 `sandbox.executor.ts` 为骨架,把 `WorkerHostService` 的调用换成 Task 1 的统一方法;`RunExecutor` 接口暂不 `implements`,留到 Task 3):

```ts
import { Injectable, Logger } from "@nestjs/common";
import { generateId } from "@agework/shared";
import type {
  AcquireInstanceResult,
  WorkerExecutionHandle,
  WorkerExecutionStartInput,
  CommandPayload,
} from "@agework/shared/protocol";
import type { RunEventPort } from "./executor";
import { WorkerHostService } from "../../worker-host/worker-host.service";
import { errorLogFields, safeLogJson } from "../../common/logging";
import { swallow } from "../../common/swallow";

/** 一次 run 的执行状态(run 层持有)。 */
type WorkerRunState = {
  handle: WorkerExecutionHandle;
  ownerId: string;
  status: "acquiring" | "ready";
  cancelled: boolean;
};

/**
 * 统一 run executor:per-run 执行编排归 run 层,取得/释放/回收 runtime 实例统一经
 * `WorkerHostService.resolveInstance()`/`releaseInstanceForRun()`/`recoverOrphanInstance()`
 * 完成——runtimeType(sandbox/local)判断被 worker-host 内部吸收,run 层不再需要认识
 * 这个区别,也因此不再需要按 runtimeType 分别持有两个执行器类(设计文档第一节)。
 *
 * 就绪后直接对 worker-host 完成 openSession / 命令下发 / cleanup,命令不绕经 runtime。
 * 就绪/早取消/失败由 resolveInstance 结果一次性回流。
 */
@Injectable()
export class WorkerRunExecutor {
  private readonly logger = new Logger(WorkerRunExecutor.name);
  private readonly states = new Map<string, WorkerRunState>();
  private receiver!: RunEventPort;

  constructor(private readonly workerHost: WorkerHostService) {}

  setRunEventPort(receiver: RunEventPort): void {
    this.receiver = receiver;
  }

  start(input: WorkerExecutionStartInput): WorkerExecutionHandle {
    const { runConfig, runtimeTarget } = input;
    const handle: WorkerExecutionHandle = {
      runId: runConfig.runId,
      runtimeType: runtimeTarget.runtimeType,
      runtimeInstanceId: "",
      conversationId: runConfig.conversationId,
    };
    this.states.set(runConfig.runId, {
      handle,
      ownerId: runtimeTarget.ownerId,
      status: "acquiring",
      cancelled: false,
    });

    // resolveInstance 同步调用（spec 要求 start() 同步触发取得），但它可能同步抛错；
    // 用 try/catch 把同步异常与 .catch 的异步 rejection 收敛到同一清理，run 转 error
    // 终态而非卡在 acquiring。
    try {
      this.workerHost
        .resolveInstance(input)
        .then((result) => this.onAcquired(input, result))
        .catch((err) => this.onAcquireFailed(runConfig.runId, err));
    } catch (err) {
      this.onAcquireFailed(runConfig.runId, err);
    }

    return handle;
  }

  private onAcquired(
    input: WorkerExecutionStartInput,
    result: AcquireInstanceResult
  ): void {
    const { runId } = input.runConfig;
    const state = this.states.get(runId);
    if (!state) return;

    if (result.outcome === "error") {
      this.states.delete(runId);
      this.notifyWorkerError(runId, result.error);
      return;
    }
    if (result.outcome === "cancelledBeforeReady") {
      this.states.delete(runId);
      this.notifyCancelledBeforeReady(runId);
      return;
    }

    // outcome === "ready"：取消若早于就绪到达，释放实例并转 cancelled 终态，不开 session。
    if (state.cancelled) {
      this.workerHost.releaseInstanceForRun(state.handle.runtimeType, runId);
      this.states.delete(runId);
      this.notifyCancelledBeforeReady(runId);
      return;
    }

    state.handle.runtimeInstanceId = result.runtimeInstanceId;
    state.status = "ready";
    input.onRuntimeInstanceIdReady?.(result.runtimeInstanceId);

    this.workerHost.openSession({
      runId,
      ownerId: state.ownerId,
      runConfig: input.runConfig,
    });
    this.sendCommand(state.handle, {
      type: "user_message",
      commandId: generateId(),
      runId,
    });
  }

  sendCommand(handle: WorkerExecutionHandle, command: CommandPayload): void {
    const state = this.states.get(handle.runId);
    if (!state) {
      this.logger.warn(
        `send command dropped ${safeLogJson({
          runId: handle.runId,
          commandType: command.type,
          reason: "no_active_state",
        })}`
      );
      return;
    }
    this.workerHost.sendCommand(state.ownerId, handle.runId, command);
    this.recordCommandSent(handle.runId, command);
  }

  cancel(handle: WorkerExecutionHandle): void {
    const state = this.states.get(handle.runId);
    if (!state) return;
    if (state.status === "ready") {
      this.sendCommand(handle, {
        type: "cancel",
        commandId: generateId(),
        runId: handle.runId,
        conversationId: handle.conversationId,
      });
      return;
    }
    // 实例 ready 之前到达的取消不下发命令：标记 cancelled，由 resolveInstance 就绪
    // 那刻转 cancelled 终态。
    state.cancelled = true;
    this.workerHost.releaseInstanceForRun(handle.runtimeType, handle.runId);
  }

  private recordCommandSent(runId: string, command: CommandPayload): void {
    this.receiver
      .recordCommandSent({
        runId,
        commandId: command.commandId,
        commandType: command.type,
      })
      .catch((err) =>
        this.logger.warn(
          `record command sent failed ${safeLogJson({
            runId,
            commandType: command.type,
            ...errorLogFields(err),
          })}`
        )
      );
  }

  private onAcquireFailed(runId: string, err: unknown): void {
    this.logger.warn(
      `resolve instance failed ${safeLogJson({
        runId,
        ...errorLogFields(err),
      })}`
    );
    this.states.delete(runId);
    this.notifyWorkerError(runId, `resolve instance failed: ${String(err)}`);
  }

  private notifyWorkerError(runId: string, error: string): void {
    this.receiver
      .notifyWorkerError(runId, error)
      .catch(swallow(this.logger, `notify worker error for run ${runId}`));
  }

  private notifyCancelledBeforeReady(runId: string): void {
    this.receiver
      .notifyCancelledBeforeReady(runId)
      .catch(
        swallow(this.logger, `notify cancelled before ready for run ${runId}`)
      );
  }

  terminateExecution(runId: string, reason: string): void {
    this.logger.warn(
      `terminating run session ${safeLogJson({ runId, reason })}`
    );
    this.cleanup(runId);
  }

  cleanup(runId: string): void {
    // releaseInstanceForRun 需要 runtimeType 才能路由到 sandbox/local；这个 executor
    // 不再像旧的按类型分开的两个类那样自带类型，只能从 state 里取——state 不存在
    // （重复 cleanup / 从未 start 过）时没有 runtimeType 可用，跳过即可，因为对应的
    // acquire 侧状态同样不存在，没有东西需要释放。
    const state = this.states.get(runId);
    this.workerHost.cleanupRun(runId);
    if (state) {
      this.workerHost.releaseInstanceForRun(state.handle.runtimeType, runId);
    }
    this.states.delete(runId);
  }

  cleanupInterruptedExecution(
    runtimeType: string,
    runtimeInstanceId: string
  ): Promise<void> {
    return this.workerHost.recoverOrphanInstance(runtimeType, runtimeInstanceId);
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter api test -- worker-run.executor`
Expected: PASS(全部 `describe.each` 用例)。

- [ ] **Step 5: 把新类加进 `run.module.ts` 的 `providers`(不改其余 wiring)**

编辑 `apps/api/src/run/run.module.ts`,在 import 区新增:

```ts
import { WorkerRunExecutor } from "./execution/worker-run.executor";
```

在 `providers` 数组里(`SandboxRunExecutor,` 那一行之后)新增一行:

```ts
    WorkerRunExecutor,
```

（此时 `WorkerRunExecutor` 只是被 DI 容器注册和实例化,尚未被任何地方消费——`ExecutionService`/`RunLauncher` 都还没改。）

- [ ] **Step 6: 跑 module wiring 测试 + typecheck + lint**

Run: `pnpm --filter api test -- run.module`
Expected: PASS(既有断言不受影响,因为 `RUN_EXECUTORS`/`RunExecutorRegistry` 还没变)。

Run: `pnpm --filter api typecheck && pnpm --filter api lint`
Expected: 零报错。

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/run/execution/worker-run.executor.ts apps/api/src/run/execution/worker-run.executor.spec.ts apps/api/src/run/run.module.ts
git commit -m "feat(api): add WorkerRunExecutor merging sandbox/local run executors (not wired yet)"
```

---

### Task 3: 翻转接线 — `run` 模块只依赖 `worker-host`,删除旧执行器与死代码

**为什么这个 task 比较大,不再继续拆细**:`ExecutionService`/`RunLauncher`/`run.module.ts` 的切换必须同时发生——`ExecutionService` 一旦改成直接持有 `WorkerRunExecutor`(不再经 `RunExecutorRegistry`),`SandboxRunExecutor`/`LocalRunExecutor`/`executor.registry.ts` 立刻失去唯一调用方,必须同一时间删除;`RunLauncher` 一旦改成调 `WorkerHostService.resolveRuntimeTarget()`,`RuntimeModule` 就能从 `run.module.ts` 的 `imports` 摘掉;`WorkerHostService` 上那八个 sandbox/local 专属方法一旦没了 `SandboxRunExecutor`/`LocalRunExecutor` 这两个调用方,也立刻变成死代码,必须一并删除。这些改动没法拆成"先做一半、代码库仍是绿的"的独立步骤,跟 Phase 2 Task 7("翻转"任务)是同一种性质。

**Files:**
- Modify: `apps/api/src/run/execution/executor.ts`(接口去掉 `type` 字段,`cleanupInterruptedExecution?` 签名改成接收 `runtimeType`)
- Modify: `apps/api/src/run/execution/worker-run.executor.ts`(加 `implements RunExecutor`)
- Modify: `apps/api/src/run/execution/execution.service.ts` + `execution.service.spec.ts`(直接持有 `WorkerRunExecutor`,不再经 registry)
- Modify: `apps/api/src/run/launch/run-launcher.ts` + `run-launcher.spec.ts`(注入 `WorkerHostService` 替代 `RuntimeService`)
- Modify: `apps/api/src/run/run.module.ts`(摘掉 `RuntimeModule`/`LocalRunExecutor`/`SandboxRunExecutor`/`RUN_EXECUTORS`/`RunExecutorRegistry`)
- Modify: `apps/api/src/run/run.module.spec.ts`(更新断言)
- Modify: `apps/api/src/worker-host/worker-host.service.ts` + `worker-host.service.spec.ts`(删除八个旧方法及其测试)
- Delete: `apps/api/src/run/execution/sandbox.executor.ts`、`sandbox.executor.spec.ts`
- Delete: `apps/api/src/run/execution/local.executor.ts`、`local.executor.spec.ts`
- Delete: `apps/api/src/run/execution/executor.registry.ts`
- Modify(注释修正): `apps/api/src/runtime/sandbox/docker-engine.ts:45`、`apps/api/src/worker-host/config/config-store.ts:7`、`apps/api/src/worker-host/command/command-dispatcher.service.ts:15,29`、`apps/api/src/worker-host/command/command-queue.ts:15,18`、`apps/api/src/worker-host/local/local-instance.executor.ts:106`、`apps/api/src/worker-host/command/command-dispatcher.service.spec.ts:38`

**Interfaces:**
- Produces: `ExecutionService` 对外方法签名保持 100% 不变(`start`/`sendCommand`/`cancel`/`terminateExecution`/`cleanup`/`cleanupInterruptedExecution(runtimeType, runtimeInstanceId)`/`setRunEventPort`)——`run.service.ts`/`worker-event.service.ts`/`run-recovery.service.ts`/`run-startup.service.ts` 这四个消费方**不需要任何改动**(已核实它们只调用这些稳定方法,不直接接触 registry 或具体 executor 类)。

- [ ] **Step 1: 更新 `RunExecutor` 接口**

编辑 `apps/api/src/run/execution/executor.ts`,把:

```ts
export interface RunExecutor {
  readonly type: string;
  setRunEventPort(receiver: RunEventPort): void;
  start(input: WorkerExecutionStartInput): WorkerExecutionHandle;
  sendCommand(handle: WorkerExecutionHandle, command: CommandPayload): void;
  cancel(handle: WorkerExecutionHandle): void;
  /** 强制终止单次 run 的执行会话；不得停止可复用 runtime resource。 */
  terminateExecution?(runId: string, reason: string): void;
  cleanup(runId: string): void;
  /** 服务重启后清理中断执行的残留（如 local worker pid / sandbox runtime resource）。 */
  cleanupInterruptedExecution?(runtimeInstanceId: string): Promise<void>;
}
```

改为:

```ts
export interface RunExecutor {
  setRunEventPort(receiver: RunEventPort): void;
  start(input: WorkerExecutionStartInput): WorkerExecutionHandle;
  sendCommand(handle: WorkerExecutionHandle, command: CommandPayload): void;
  cancel(handle: WorkerExecutionHandle): void;
  /** 强制终止单次 run 的执行会话；不得停止可复用 runtime resource。 */
  terminateExecution?(runId: string, reason: string): void;
  cleanup(runId: string): void;
  /** 服务重启后清理中断执行的残留（如 local worker pid / sandbox runtime resource）。 */
  cleanupInterruptedExecution?(
    runtimeType: string,
    runtimeInstanceId: string
  ): Promise<void>;
}
```

- [ ] **Step 2: `WorkerRunExecutor` 加 `implements RunExecutor`**

编辑 `apps/api/src/run/execution/worker-run.executor.ts`:
- import 区把 `import type { RunEventPort } from "./executor";` 改成 `import type { RunEventPort, RunExecutor } from "./executor";`。
- class 声明改成 `export class WorkerRunExecutor implements RunExecutor {`。

（`cleanupInterruptedExecution` 方法签名在 Task 2 就已经是 `(runtimeType: string, runtimeInstanceId: string)`,天然满足新接口,无需再改。）

- [ ] **Step 3: 简化 `ExecutionService`,直接持有 `WorkerRunExecutor`**

把 `apps/api/src/run/execution/execution.service.ts` 整个文件替换为:

```ts
import { Injectable } from "@nestjs/common";
import type {
  CommandPayload,
  WorkerExecutionHandle,
  WorkerExecutionStartInput,
} from "@agework/shared/protocol";
import { WorkerRunExecutor } from "./worker-run.executor";
import type { RunEventPort } from "./executor";

/**
 * runs 到执行器的应用层入口：转发 start / command / cancel / terminate / cleanup /
 * recovery 给唯一的 `WorkerRunExecutor`——runtimeType(sandbox/local)判断已经被
 * `WorkerHostService` 内部吸收（设计文档第一节),这里不再需要按类型查找执行器。
 *
 * 它不持有 live handle；LiveRunRegistry 持有 handle，本 service 只负责把
 * handle/input 转交给执行器。
 */
@Injectable()
export class ExecutionService {
  constructor(private readonly executor: WorkerRunExecutor) {}

  start(input: WorkerExecutionStartInput): WorkerExecutionHandle {
    return this.executor.start(input);
  }

  sendCommand(handle: WorkerExecutionHandle, command: CommandPayload): void {
    this.executor.sendCommand(handle, command);
  }

  cancel(handle: WorkerExecutionHandle): void {
    this.executor.cancel(handle);
  }

  terminateExecution(handle: WorkerExecutionHandle, reason: string): void {
    this.executor.terminateExecution?.(handle.runId, reason);
  }

  cleanup(handle: WorkerExecutionHandle): void {
    this.executor.cleanup(handle.runId);
  }

  cleanupInterruptedExecution(
    runtimeType: string,
    runtimeInstanceId: string
  ): Promise<void> {
    return Promise.resolve(
      this.executor.cleanupInterruptedExecution?.(
        runtimeType,
        runtimeInstanceId
      )
    ).then(() => undefined);
  }

  setRunEventPort(receiver: RunEventPort): void {
    this.executor.setRunEventPort(receiver);
  }
}
```

- [ ] **Step 4: 更新 `execution.service.spec.ts`**

把 `apps/api/src/run/execution/execution.service.spec.ts` 整个文件替换为:

```ts
import { describe, expect, it, vi } from "vitest";
import type {
  CommandPayload,
  RunConfig,
  RuntimeTarget,
  WorkerExecutionHandle,
} from "@agework/shared/protocol";
import { ExecutionService } from "./execution.service";
import { WorkerRunExecutor } from "./worker-run.executor";

function makeExecutor() {
  return {
    start: vi.fn(),
    sendCommand: vi.fn(),
    cancel: vi.fn(),
    terminateExecution: vi.fn(),
    cleanup: vi.fn(),
    cleanupInterruptedExecution: vi.fn(),
    setRunEventPort: vi.fn(),
  };
}

const handle: WorkerExecutionHandle = {
  runId: "run-1",
  runtimeType: "local",
  runtimeInstanceId: "1:token",
  conversationId: "conversation-1",
};

describe("ExecutionService", () => {
  it("forwards start to the executor", () => {
    const executor = makeExecutor();
    executor.start.mockReturnValue(handle);
    const service = new ExecutionService(executor as unknown as WorkerRunExecutor);

    const runConfig = { runId: "run-1" } as RunConfig;
    const runtimeTarget = {
      runtimeType: "local",
      ownerId: "ws-1",
      userId: "user-1",
      workspaceId: "ws-1",
      hostPath: "/tmp/ws",
      runtimePath: "/tmp/ws",
    } as RuntimeTarget;
    const onReady = vi.fn();

    const result = service.start({
      runConfig,
      runtimeTarget,
      onRuntimeInstanceIdReady: onReady,
    });

    expect(executor.start).toHaveBeenCalledWith({
      runConfig,
      runtimeTarget,
      onRuntimeInstanceIdReady: onReady,
    });
    expect(result).toBe(handle);
  });

  it("forwards command / cancel / terminate / cleanup to the executor", () => {
    const executor = makeExecutor();
    const service = new ExecutionService(executor as unknown as WorkerRunExecutor);
    const command = {
      type: "approval_resolved",
      commandId: "command-1",
      conversationId: "conversation-1",
      answers: {},
    } as CommandPayload;

    service.sendCommand(handle, command);
    service.cancel(handle);
    service.terminateExecution(handle, "run timeout");
    service.cleanup(handle);

    expect(executor.sendCommand).toHaveBeenCalledWith(handle, command);
    expect(executor.cancel).toHaveBeenCalledWith(handle);
    expect(executor.terminateExecution).toHaveBeenCalledWith(
      "run-1",
      "run timeout"
    );
    expect(executor.cleanup).toHaveBeenCalledWith("run-1");
  });

  it("forwards cleanupInterruptedExecution with runtimeType and runtimeInstanceId", async () => {
    const executor = makeExecutor();
    executor.cleanupInterruptedExecution.mockResolvedValue(undefined);
    const service = new ExecutionService(executor as unknown as WorkerRunExecutor);

    await service.cleanupInterruptedExecution("local", "runtime-1");

    expect(executor.cleanupInterruptedExecution).toHaveBeenCalledWith(
      "local",
      "runtime-1"
    );
  });

  it("wires the run event receiver through to the executor during module setup", () => {
    const executor = makeExecutor();
    const service = new ExecutionService(executor as unknown as WorkerRunExecutor);
    const receiver = {} as never;

    service.setRunEventPort(receiver);

    expect(executor.setRunEventPort).toHaveBeenCalledWith(receiver);
  });
});
```

- [ ] **Step 5: 删除旧的 `SandboxRunExecutor`/`LocalRunExecutor`/`executor.registry.ts`**

```bash
git rm apps/api/src/run/execution/sandbox.executor.ts apps/api/src/run/execution/sandbox.executor.spec.ts
git rm apps/api/src/run/execution/local.executor.ts apps/api/src/run/execution/local.executor.spec.ts
git rm apps/api/src/run/execution/executor.registry.ts
```

- [ ] **Step 6: `RunLauncher` 改注入 `WorkerHostService`**

编辑 `apps/api/src/run/launch/run-launcher.ts`:

把 import 区的:

```ts
import { RuntimeService } from "../../runtime/runtime.service";
```

改为:

```ts
import { WorkerHostService } from "../../worker-host/worker-host.service";
```

把构造函数:

```ts
  constructor(
    private readonly runRepository: RunRepository,
    private readonly liveRuns: LiveRunRegistry,
    private readonly runtimeService: RuntimeService,
    private readonly executionService: ExecutionService,
    private readonly conversations: ConversationService,
    private readonly runEvents: RunEventService,
    private readonly configService: ConfigService
  ) {}
```

改为:

```ts
  constructor(
    private readonly runRepository: RunRepository,
    private readonly liveRuns: LiveRunRegistry,
    private readonly workerHost: WorkerHostService,
    private readonly executionService: ExecutionService,
    private readonly conversations: ConversationService,
    private readonly runEvents: RunEventService,
    private readonly configService: ConfigService
  ) {}
```

把 `getPlacement()` 方法体里唯一一处:

```ts
    return this.runtimeService.resolveRuntimeTarget({
```

改为:

```ts
    return this.workerHost.resolveRuntimeTarget({
```

- [ ] **Step 7: 更新 `run-launcher.spec.ts`**

编辑 `apps/api/src/run/launch/run-launcher.spec.ts`:

把:

```ts
import { RuntimeService } from "../../runtime/runtime.service";
```

改为:

```ts
import { WorkerHostService } from "../../worker-host/worker-host.service";
```

把变量声明:

```ts
  let mockRuntimeService: Partial<RuntimeService>;
```

改为:

```ts
  let mockWorkerHost: Partial<WorkerHostService>;
```

把 `beforeEach` 里的:

```ts
    mockRuntimeService = {
      resolveRuntimeTarget: vi
        .fn()
        .mockReturnValue(makeRuntimeTarget(makePlacement("local"))),
    };
```

改为:

```ts
    mockWorkerHost = {
      resolveRuntimeTarget: vi
        .fn()
        .mockReturnValue(makeRuntimeTarget(makePlacement("local"))),
    };
```

把 `new RunLauncher(...)` 调用里的:

```ts
      mockRuntimeService as RuntimeService,
```

改为:

```ts
      mockWorkerHost as WorkerHostService,
```

把测试体内所有 `mockRuntimeService.resolveRuntimeTarget`(共 3 处:约 198 行、280 行、320 行)替换成 `mockWorkerHost.resolveRuntimeTarget`。

- [ ] **Step 8: 跑 `run-launcher` 测试确认通过**

Run: `pnpm --filter api test -- run-launcher`
Expected: PASS。

- [ ] **Step 9: 更新 `run.module.ts`**

把 `apps/api/src/run/run.module.ts` 整个文件替换为:

```ts
import { Module } from "@nestjs/common";

// core
import { RunRepository } from "./run.repository";
import { LiveRunRegistry } from "./live-run/live-run.registry";
import { WorkerEventService } from "./worker-event/worker-event.service";
import { WorkerSeqStore } from "./worker-event/worker-seq.store";
import { RunStatusService } from "./status/run-status.service";
import { RunFinalizationStore } from "./status/run-finalization.store";
import { RunRecoveryService } from "./recovery/run-recovery.service";
import { RunStartupService } from "./startup/run-startup.service";
import { RunWorkspaceListener } from "./workspace/run-workspace.listener";
import { RunService } from "./run.service";
import { RunLauncher } from "./launch/run-launcher";
import { ExecutionService } from "./execution/execution.service";
import { WorkerRunExecutor } from "./execution/worker-run.executor";
import { WorkerAgUiEventHandler } from "./worker-event/agui-event.handler";

// controllers
import { AdminRunController } from "./admin/admin-run.controller";

// deps（向下依赖：worker-host / run-event / conversation）
import { WorkerHostModule } from "../worker-host/worker-host.module";
import { RunEventModule } from "../run-event/run-event.module";
import { ConversationModule } from "../conversation/conversation.module";

/**
 * Run 领域：一次执行的生命周期、事件记录/聚合。只依赖 worker-host 一个模块获取
 * runtime 环境（placement 解析、实例取得/释放/回收 全部经 WorkerHostService,
 * runtimeType 判断收在 worker-host 内部,见设计文档第一节),另外向下依赖
 * run-event / conversation（直接写回会话状态），并在启动时把 worker 事件统一入口
 * 注入 run executor；WorkerUpstreamPort → worker-host 的 WorkerRunController。
 */
@Module({
  imports: [WorkerHostModule, RunEventModule, ConversationModule],
  controllers: [AdminRunController],
  providers: [
    RunRepository,
    LiveRunRegistry,
    WorkerEventService,
    WorkerSeqStore,
    RunRecoveryService,
    RunStatusService,
    RunFinalizationStore,
    RunService,
    RunLauncher,
    WorkerRunExecutor,
    ExecutionService,
    WorkerAgUiEventHandler,
    RunStartupService,
    RunWorkspaceListener,
  ],
  exports: [RunService],
})
export class RunModule {}
```

- [ ] **Step 10: 更新 `run.module.spec.ts`**

编辑 `apps/api/src/run/run.module.spec.ts`:

把:

```ts
import {
  RUN_EXECUTORS,
  RunExecutorRegistry,
} from "./execution/executor.registry";
import type { RunExecutor } from "./execution/executor";
import { ExecutionService } from "./execution/execution.service";
```

改为:

```ts
import { ExecutionService } from "./execution/execution.service";
import { WorkerRunExecutor } from "./execution/worker-run.executor";
```

把测试体里的:

```ts
    const executors = testingModule.get<RunExecutor[]>(RUN_EXECUTORS);
    expect(executors.map((executor) => executor.type)).toEqual([
      "local",
      "sandbox",
    ]);

    const executorRegistry = testingModule.get(RunExecutorRegistry);
    expect(executorRegistry.resolve("local")).toBe(executors[0]);
    expect(executorRegistry.resolve("sandbox")).toBe(executors[1]);
    expect(testingModule.get(RunService)).toBeInstanceOf(RunService);
```

改为:

```ts
    expect(testingModule.get(WorkerRunExecutor)).toBeInstanceOf(
      WorkerRunExecutor
    );
    expect(testingModule.get(RunService)).toBeInstanceOf(RunService);
```

- [ ] **Step 11: 跑 `run.module` 测试确认通过**

Run: `pnpm --filter api test -- run.module`
Expected: PASS。

- [ ] **Step 12: 删除 `WorkerHostService` 上八个已无调用方的旧方法**

编辑 `apps/api/src/worker-host/worker-host.service.ts`,删除以下八个方法整体(保留 `isRuntimeInstanceUserScoped`——它仍被 `RunRecoveryService` 使用,本轮不动):

- `acquireSandboxInstanceForRun`
- `releaseSandboxInstanceForRun`
- `recoverOrphanSandboxInstance`
- `shutdownSandboxInstanceByOwnerId`
- `acquireLocalInstanceForRun`
- `releaseLocalInstanceForRun`
- `recoverOrphanLocalInstance`
- `shutdownLocalInstanceByOwnerId`

同时把文件顶部那段路标注释:

```ts
  // ── WorkerRegistry 透传方法 ──────────────────────────────────────────
  // WorkerRegistry 数据(RuntimeInstance/WorkspaceRuntimeInstance 表)归属 worker-host,
  // 这里是唯一对外入口;这批方法目前是 1:1 透传原 repository 方法,是 Phase 1(纯粹的
  // 归属搬家)的产物——后续 resolveInstance() 落地后,部分方法可能会被更贴合业务语义
  // 的编排方法取代,不代表这是最终形态。
```

改为:

```ts
  // ── WorkerRegistry 透传方法 ──────────────────────────────────────────
  // WorkerRegistry 数据(RuntimeInstance/WorkspaceRuntimeInstance 表)归属 worker-host,
  // 这里是唯一对外入口;这批方法是 Phase 1(纯粹的归属搬家)的产物,1:1 透传原
  // repository 方法。取得/释放/回收 runtime 实例本身的编排入口见下方
  // resolveInstance() 分组(Phase 4)。
```

把 `stopRuntimeInstance()` 方法体里的:

```ts
    if (resource.runtimeType === "sandbox") {
      this.shutdownSandboxInstanceByOwnerId(resource.ownerId);
    } else if (resource.runtimeType === "local") {
      this.shutdownLocalInstanceByOwnerId(resource.ownerId);
    }
```

改为:

```ts
    this.shutdownInstanceByOwnerId(resource.runtimeType, resource.ownerId);
```

- [ ] **Step 13: 更新 `worker-host.service.spec.ts`,删除对应的旧测试**

编辑 `apps/api/src/worker-host/worker-host.service.spec.ts`:
- 删除 `describe("WorkerHostService sandbox instance orchestration", ...)` 块内针对 `acquireSandboxInstanceForRun`/`releaseSandboxInstanceForRun`/`recoverOrphanSandboxInstance`/`shutdownSandboxInstanceByOwnerId` 的四个 `it`(保留 `isRuntimeInstanceUserScoped`、`getRuntimePolicy` 两个 `it` 不动)。
- 删除 `describe("WorkerHostService local instance orchestration", ...)` 块内针对 `acquireLocalInstanceForRun`/`releaseLocalInstanceForRun`/`recoverOrphanLocalInstance`/`shutdownLocalInstanceByOwnerId` 的四个 `it`(保留 `sendCommand routes through the local channel...` 等其余测试不动)。
- 在文件里找 `stopRuntimeInstance` 相关的既有测试(如果存在对 `shutdownSandboxInstanceByOwnerId`/`shutdownLocalInstanceByOwnerId` 被调用的断言),改成断言 `shutdownInstanceByOwnerId` 被以正确的 `(runtimeType, ownerId)` 调用。

- [ ] **Step 14: 跑完整 worker-host + run 测试套件**

Run: `pnpm --filter api test -- worker-host`
Expected: PASS,且旧的八个方法测试已不存在。

Run: `pnpm --filter api test -- run`
Expected: PASS(`run.module.spec.ts`、`run-launcher.spec.ts`、`run.service.spec.ts`、`worker-event.service.spec.ts`、`run-recovery.service.spec.ts` 等全部通过)。

- [ ] **Step 15: 修正引用旧类名的注释**

以下文件里的注释提到 `SandboxRunExecutor`/`LocalRunExecutor`,统一改成 `WorkerRunExecutor`(纯注释文字替换,不改代码逻辑):

- `apps/api/src/runtime/sandbox/docker-engine.ts:45` — `// 传入的 env（由 SandboxRunExecutor 构造）` → `// 传入的 env（由 WorkerRunExecutor 构造）`
- `apps/api/src/worker-host/config/config-store.ts:7` — `LocalRunExecutor 不使用此 store（IPC 直接发送 config）。` → `local 实例不使用此 store（IPC 直接发送 config）。`
- `apps/api/src/worker-host/command/command-dispatcher.service.ts:15` — `由 SandboxRunExecutor 经 WorkerHostService facade 调用；` → `由 WorkerRunExecutor 经 WorkerHostService facade 调用；`
- `apps/api/src/worker-host/command/command-dispatcher.service.ts:29` — `首个 user_message 由 run 侧 SandboxRunExecutor 在 start 后显式下发，` → `首个 user_message 由 run 侧 WorkerRunExecutor 在 start 后显式下发，`
- `apps/api/src/worker-host/command/command-queue.ts:15` — `写入侧由 SandboxRunExecutor 经 WorkerHostService →` → `写入侧由 WorkerRunExecutor 经 WorkerHostService →`
- `apps/api/src/worker-host/command/command-queue.ts:18` — `LocalRunExecutor 不经过此队列（直接 IPC send）。` → `local 实例不经过此队列（直接 IPC send）。`
- `apps/api/src/worker-host/local/local-instance.executor.ts:106` — `保留方法只为跟 SandboxRunExecutor 的调用形状对齐。` → `保留方法只为跟 sandbox 侧的调用形状对齐。`
- `apps/api/src/worker-host/command/command-dispatcher.service.spec.ts:38` — `首个 user_message 由 run 侧 SandboxRunExecutor 显式下发，` → `首个 user_message 由 run 侧 WorkerRunExecutor 显式下发，`

- [ ] **Step 16: 全量 typecheck + lint + test**

Run: `pnpm --filter api typecheck`
Expected: 零报错。

Run: `pnpm --filter api lint`
Expected: 零报错(含 type-aware 规则——不能只信 tsc,eslint 单独跑一遍)。

Run: `pnpm --filter api test`
Expected: 全部通过。

- [ ] **Step 17: 确认 `RuntimeModule` 不再被 `run` 模块引用**

Run: `grep -rn "RuntimeModule\|RuntimeService" apps/api/src/run --include="*.ts"`
Expected: 零匹配(`run` 模块下任何文件都不再 import `RuntimeModule` 或 `RuntimeService`)。

- [ ] **Step 18: Commit**

```bash
git add apps/api/src/run apps/api/src/worker-host apps/api/src/runtime/sandbox/docker-engine.ts
git commit -m "refactor(api): run module depends only on worker-host, resolveInstance() lands"
```

---

## 完成后校验

- [ ] `pnpm --filter api typecheck && pnpm --filter api lint && pnpm --filter api test` 全绿。
- [ ] `apps/api/src/run/run.module.ts` 的 `imports` 只有 `WorkerHostModule`/`RunEventModule`/`ConversationModule`,不含 `RuntimeModule`。
- [ ] `apps/api/src/run/execution/` 目录下只剩 `execution.service.ts`(+spec)、`executor.ts`、`worker-run.executor.ts`(+spec)——`sandbox.executor.ts`/`local.executor.ts`/`executor.registry.ts` 及其 spec 已删除。
- [ ] `WorkerHostService` 对外暴露 `resolveRuntimeTarget`/`resolveInstance`/`releaseInstanceForRun`/`recoverOrphanInstance`/`shutdownInstanceByOwnerId` 五个统一方法,不再有 sandbox/local 专属的八个旧方法。
- [ ] admin 面板手动验证(可选,非本轮强制):`/admin/runtime/resources` 列表、`/admin/runtime/resources/stop` 停止按钮行为与改造前一致。
