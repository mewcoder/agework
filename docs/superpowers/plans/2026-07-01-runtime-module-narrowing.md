# Runtime 模块收窄 + Provider 契约改造(Phase 2)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `runtime` 模块收窄成纯粹的 Provider 引擎层(docker/opensandbox engine + 新建的 local Provider)+ placement 计算,把 owner 复用判断/idle watchdog/WorkerRegistry 读写(`SandboxRuntimeInstanceService`)、级联清理(`RuntimeInstanceLifecycleService`/`Listener`)、admin 查询(`runtime/admin/`)整体搬进 `worker-host` 模块,最终让 `runtime.module.ts` 彻底不依赖 `worker-host`(`imports: []`),依赖方向翻转为 `worker-host → runtime`。**这是一次纯粹的架构边界搬家,不改变任何现有行为**:sandbox 的 owner 复用/idle 超时逻辑原样保留,local 仍然是"一次 run 一个进程"、run 模块继续直接持有和收发 IPC channel——local 变成按 owner 长期复用、`worker-host` 接管 channel 收发,是单独的 Phase 3,不在这份计划范围内。

**Architecture:**

现状核实(与设计文档 `docs/superpowers/specs/2026-06-30-agent-run-new-architecture-design.md` 写作时相比,代码已经有出入,以下是当前真实状态):
- `runtime` 模块当前的 Provider 契约(`RuntimeInstanceManager`,`providers/provider-contracts.ts`)只有 `recoverOrphan`/`shutdownRuntimeInstanceByOwnerId` 两个方法,不是设计文档 3.5 节的 `launch/stop/cleanup/list`。真正"起一个 sandbox 实例"的编排逻辑——owner 复用判断、idle watchdog、WorkerRegistry 读写——整个长在 `runtime/sandbox/sandbox-instance.service.ts` 里,它直接注入 `WorkerHostService`,这是 `runtime → worker-host` 这条边存在的真正原因。
- `local` 完全没有对应的 Provider:`fork()`、IPC 收发、exit 监听全部长在 `run/execution/local.executor.ts` 里(`run` 模块,不是 `runtime`);`runtime` 里现在的 "local" 只是 `provider-registry.ts` 里一个啥都不做的占位对象。

搬家后的落点(全部经过与现有调用方逐个核实,不是理想态臆测):
1. **`runtime` 收窄为纯 Provider 引擎 + placement**:`RuntimeService` 只保留 `resolveRuntimeTarget()`(placement 计算,不变)、一组新的 sandbox engine 直接调用方法(`getOrCreateSandbox`/`resumeSandbox`/`startSandboxWorker`/`stopSandbox`/`recoverOrphanSandbox`,替代原来"谁去调 `SANDBOX_ENGINES`"这件事)、以及新建的 local Provider 门面(`launchLocal`/`recoverOrphanLocal`)。`RuntimeProviderRegistry`/`RUNTIME_PROVIDERS`/`RuntimeInstanceManager` 契约整体删除——核实过它剩下的两个消费方(`RuntimeService.shutdownRuntimeInstanceByOwnerId`、`RuntimeInstanceLifecycleService`)都随着这次搬家不再需要它:worker-host 一侧现在直接同模块持有 `SandboxInstanceExecutor`,不需要再经一层按 `runtimeType` 字符串路由的 registry 去找它。
2. **`SandboxRuntimeInstanceService` 搬进 `worker-host/sandbox/`,改名 `SandboxInstanceExecutor`**:owner 状态 map、idle watchdog、`isExpectedRuntimeInstance` 校验、WorkerRegistry 读写全部原样保留,只是把"直接调 `SANDBOX_ENGINES`"换成"调 `runtime` 导出的 `RuntimeService` 的新方法"。`sandbox-utils.ts`(`IdleWatchdog`、`resolveDockerApiBase`)一并搬过去。
3. **`RuntimeInstanceLifecycleService`/`Listener` 搬进 `worker-host/lifecycle/`**:不再需要 `RuntimeProviderRegistry`(删除),直接同模块注入 `SandboxInstanceExecutor` 调用物理 stop。
4. **`runtime/admin/` 整体搬进 `worker-host/admin/`**:HTTP 路径 `/admin/runtime/*` 不变(前端 `apps/web/src/api/runtime.ts` 不用改),controller 换成只调 `WorkerHostService`。
5. **新建 `runtime/local/local-runtime.provider.ts`**:把 `run/execution/local.executor.ts` 里的 `fork()` 调用抽出来,`launch()` 返回 `{ runtimeInstanceId, channel }`——这是这次唯一真正新增的机制,`channel` 字段就是设计文档要的东西。`run` 侧 `LocalRunExecutor` 换成调 `RuntimeService.launchLocal()`拿 handle,但**继续像今天一样自己直接用这个 channel 收发**(`child.send`/`child.on`)——不下沉给 `worker-host`,那是 Phase 3 的事。

**为什么把 6 个"改动点"分成 7 个 task,其中 Task 7 特别大**:NestJS 在 bootstrap 时对整张 DI 依赖图做环检测,不是逐文件增量检测。`runtime → worker-host`(现有边)和 `worker-host → runtime`(这次要建的新边)不可能同时存在——只要 `runtime.module.ts` 的 `imports` 里还留着 `WorkerHostModule`,`worker-host.module.ts` 就不能加 `imports: [RuntimeModule]`,否则立即成环(`runtime.module.spec.ts` 这类用 `Test.createTestingModule` 的测试会在 `.compile()` 直接抛错)。而 `runtime.module.ts` 要摘掉 `WorkerHostModule` 又要求 `SandboxRuntimeInstanceService`/`RuntimeInstanceLifecycleService`+`Listener`/`AdminRuntimeController` 三个消费方**同时**不再需要它——这三者没法逐个独立完成"边翻转"这一步。所以 Task 1-6 只做"两侧新代码各自就位、各自用手搓 mock 单测通过,但暂不接入 NestJS module 的 `imports`/`providers`/`controllers`",让编译和现有测试全程保持绿色;Task 7 才是那个必须整体原子发生的"翻转"动作——同时删旧文件、接线两个 module.ts、切 `run` 模块的调用点。这跟 Phase 1 阶段末尾的说明("`resolveInstance()` 本身、local 通信方式改造、idle watchdog 决策权转移、`run` 依赖简化、Provider 契约的 channel 字段——这些都在设计文档里,但明确是 Phase 2-5 的范围")是同一个"先分层想清楚再落地"的态度,只是这次的分层是"能力就位"和"接线切换"分开,不是按功能点分开。

**Tech Stack:** NestJS 11、TypeScript、Vitest(手搓 mock,不用 `Test.createTestingModule`,除 `runtime.module.spec.ts` 本身验证 module wiring)。

## Global Constraints

- 后端命名规则见 `.claude/rules/backend-naming.md`,模块边界规则见 `.claude/rules/backend-architecture.md`——repository/internal provider 不导出,跨模块只调对方导出的根 Service,禁止 `forwardRef`,禁止循环依赖。
- 这是一次纯粹的边界搬家,不改变任何可观察行为:sandbox 的 owner 复用/idle 超时/WorkerRegistry 写入语义,local 的 fork/IPC 语义,admin 接口的 URL 与响应形状,全部保持不变。
- 不做本轮范围外的事:不新增 `resolveInstance()`,不改 local 的"一次 run 一个进程"模型,不让 `worker-host` 接管 IPC channel 的收发,不给 local 写 WorkerRegistry,不加自注册鉴权。这些留给 Phase 3(已经跟用户确认过范围划分)。
- 每个 task 结束时代码库必须能通过 `pnpm --filter api typecheck`;Task 1-6 因为新代码暂不接线,现有测试原样全部通过;Task 7 完成后现有 + 新增测试全部通过。

---

### Task 1: `runtime.types.ts` 跨模块类型 + `RuntimeService` 新增 sandbox engine 门面方法

**Files:**
- Create: `apps/api/src/runtime/runtime.types.ts`
- Modify: `apps/api/src/runtime/sandbox/sandbox-engine.ts`(类型定义搬进 `runtime.types.ts`,本文件 re-export,`docker-engine.ts`/`opensandbox-engine.ts` 的 import 路径不用改)
- Modify: `apps/api/src/runtime/placement/runtime-resource.ts`(删掉 `isSandboxPlacement`,搬进 `runtime.types.ts`)
- Modify: `apps/api/src/runtime/runtime.service.ts`
- Modify: `apps/api/src/runtime/runtime.service.spec.ts`

**Interfaces:**
- Produces: `runtime.types.ts` 导出 `SandboxEngineType`、`SandboxPlacement`、`SandboxStartInput`、`SandboxRuntime`、`isSandboxPlacement(placement)`——这是 `runtime` 模块的跨模块契约类型文件,Task 4 的 `worker-host/sandbox/sandbox-instance.executor.ts` 会从这里 import,不会 reach `runtime` 内部文件。`RuntimeService` 新增 `getOrCreateSandbox(engineType, input)`、`resumeSandbox(engineType, runtimeInstanceId, input)`、`startSandboxWorker(engineType, runtime, input)`、`stopSandbox(engineType, runtimeInstanceId)`、`recoverOrphanSandbox(runtimeInstanceId)`。
- Consumes: 无新增外部依赖,`RuntimeService` 构造函数新增注入 `@Inject(SANDBOX_ENGINES) engines: SandboxEngine[]`。

- [ ] **Step 1: 创建 `runtime.types.ts`**

```ts
import type { IsolationScope, RuntimePlacement, SandboxRuntimePlacement } from "@agework/shared/protocol";

// ── Sandbox engine 契约类型(worker-host 的 SandboxInstanceExecutor 与 runtime 的
// DockerSandboxEngine/OpenSandboxEngine 共用,是这两个模块之间唯一合法的类型契约面) ──

export type SandboxEngineType = "docker" | "opensandbox";

export type SandboxPlacement = {
  isolationScope: IsolationScope;
  ownerId: string;
  workspaceId: string;
  workspaceHostPath: string;
  workspaceMountPath: string;
};

export type SandboxStartInput = {
  placement: SandboxPlacement;
  image: string;
  apiBaseUrl: string;
  env: Record<string, string>;
  metadata: Record<string, string>;
  runtimeLogHostPath?: string;
  runtimeLogMountPath?: string;
  /**
   * DB-backed ownership check supplied by the caller. Engines may use a
   * Docker/OpenSandbox resource id as a lookup key, but must not infer binding
   * from names or labels.
   */
  isExpectedRuntimeInstance?: (runtimeInstanceId: string) => Promise<boolean>;
  /** OpenSandbox 专用:resource 恢复时传已有的 RuntimeTarget.id */
  runtimeInstanceId?: string;
};

export type SandboxRuntime = {
  engineType: SandboxEngineType;
  runtimeInstanceId: string;
  workspaceMountPath: string;
};

/** 类型守卫:narrow 出 sandbox 分支(placement.sandbox 必填)。 */
export function isSandboxPlacement(
  placement: RuntimePlacement
): placement is SandboxRuntimePlacement {
  return placement.runtimeType === "sandbox";
}
```

- [ ] **Step 2: 改 `sandbox-engine.ts`,类型从 `runtime.types.ts` import 并 re-export**

把 `apps/api/src/runtime/sandbox/sandbox-engine.ts` 顶部的类型定义(`SandboxEngineType`/`SandboxPlacement`/`SandboxStartInput`/`SandboxRuntime`)删掉,改成:

```ts
export type {
  SandboxEngineType,
  SandboxPlacement,
  SandboxStartInput,
  SandboxRuntime,
} from "../runtime.types";

import type {
  SandboxEngineType,
  SandboxPlacement,
  SandboxStartInput,
  SandboxRuntime,
} from "../runtime.types";

// ── SandboxEngine 接口(以下内容不变)──────────────────────────────────

export interface SandboxEngine {
  readonly type: SandboxEngineType;

  getOrCreate(input: SandboxStartInput): Promise<SandboxRuntime>;

  startWorker(runtime: SandboxRuntime, input: SandboxStartInput): Promise<void>;

  stop(runtimeInstanceId: string): Promise<void>;

  resume?(
    runtimeInstanceId: string,
    input: SandboxStartInput
  ): Promise<SandboxRuntime>;

  recoverOrphan(runtimeInstanceId: string): Promise<void>;

  isHealthy?(runtimeInstanceId: string): Promise<boolean>;
}

export const SANDBOX_ENGINES = Symbol("SANDBOX_ENGINES");
```

(注释块——原文件开头的 `// ── SandboxEngine 类型标识 ──` 等分节注释、DI token 上方的说明注释——保留不动;这里只展示需要新增/替换的部分。`docker-engine.ts`/`opensandbox-engine.ts`/`opensandbox-client.ts` 继续 `from "./sandbox-engine"` 导入这四个类型,因为本文件 re-export 了它们,不需要改它们的 import。)

- [ ] **Step 3: 改 `runtime-resource.ts`,删掉 `isSandboxPlacement`(已搬进 `runtime.types.ts`)**

删除 `apps/api/src/runtime/placement/runtime-resource.ts` 里的这一段(第 31-36 行):

```ts
/** 类型守卫:narrow 出 sandbox 分支(placement.sandbox 必填)。 */
export function isSandboxPlacement(
  placement: RuntimePlacement
): placement is SandboxRuntimePlacement {
  return placement.runtimeType === "sandbox";
}
```

(`SandboxRuntimePlacement` 类型 import 如果本文件其余部分不再用到,一并从 import 列表删掉;`resolveRuntimeTarget` 本身不调用 `isSandboxPlacement`,删除后不影响任何逻辑。)

- [ ] **Step 4: 跑 typecheck 确认这三个文件改动没有破坏任何现有引用**

Run: `pnpm --filter api typecheck`
Expected: 通过(`docker-engine.ts`/`opensandbox-engine.ts`/`sandbox-instance.service.ts` 等消费方的 import 路径都没变)

- [ ] **Step 5: 改 `runtime.service.ts`,新增 sandbox engine 门面方法**

在 `apps/api/src/runtime/runtime.service.ts` 顶部 import 区新增:

```ts
import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { SANDBOX_ENGINES, type SandboxEngine } from "./sandbox/sandbox-engine";
import type {
  SandboxEngineType,
  SandboxRuntime,
  SandboxStartInput,
} from "./runtime.types";
import { swallow } from "../common/swallow";
```

构造函数改成(新增 `engines` 注入 + `sandboxEngines` map + `logger` 字段,其余不变):

```ts
export class RuntimeService {
  private readonly logger = new Logger(RuntimeService.name);
  private readonly defaults: RuntimeTargetDefaults;
  private readonly sandboxEngines: Map<SandboxEngineType, SandboxEngine>;

  constructor(
    private readonly configService: ConfigService,
    private readonly providerRegistry: RuntimeProviderRegistry,
    private readonly workerHost: WorkerHostService,
    private readonly sandboxInstances: SandboxRuntimeInstanceService,
    @Inject(SANDBOX_ENGINES) engines: SandboxEngine[]
  ) {
    this.defaults = {
      runtimeType: configService.getDefaultRuntimeType(),
      isolationScope: configService.getDefaultIsolationScope(),
      sandboxEngine: configService.getSandboxEngine(),
    };
    this.sandboxEngines = new Map(engines.map((e) => [e.type, e]));
  }
```

在 `resolveRuntimeTarget` 方法之后新增(放在文件里 `// ── sandbox per-run 资源门面 ──` 注释块之前):

```ts
  // ── sandbox engine 引擎面(worker-host 的 SandboxInstanceExecutor 经此驱动物理
  // sandbox 操作;runtime 只知道怎么调 engine,不认识 owner 复用/idle 决策) ──

  /** 获取或创建一个 sandbox 运行环境(docker/opensandbox 由 engineType 决定)。 */
  getOrCreateSandbox(
    engineType: SandboxEngineType,
    input: SandboxStartInput
  ): Promise<SandboxRuntime> {
    return this.resolveSandboxEngine(engineType).getOrCreate(input);
  }

  /** 恢复一个此前被 stop() 的 sandbox 运行环境;engine 不支持 resume 时返回 undefined。 */
  resumeSandbox(
    engineType: SandboxEngineType,
    runtimeInstanceId: string,
    input: SandboxStartInput
  ): Promise<SandboxRuntime> | undefined {
    return this.resolveSandboxEngine(engineType).resume?.(
      runtimeInstanceId,
      input
    );
  }

  /** 在已有 sandbox 运行环境中启动 worker 进程。 */
  startSandboxWorker(
    engineType: SandboxEngineType,
    runtime: SandboxRuntime,
    input: SandboxStartInput
  ): Promise<void> {
    return this.resolveSandboxEngine(engineType).startWorker(runtime, input);
  }

  /** 停止(不销毁)一个 sandbox 运行环境。 */
  stopSandbox(engineType: SandboxEngineType, runtimeInstanceId: string): Promise<void> {
    return this.resolveSandboxEngine(engineType).stop(runtimeInstanceId);
  }

  /** 服务重启后清理中断执行残留的 sandbox 资源,遍历所有已注册 engine(不知道具体是哪个)。 */
  async recoverOrphanSandbox(runtimeInstanceId: string): Promise<void> {
    for (const engine of this.sandboxEngines.values()) {
      await engine
        .recoverOrphan(runtimeInstanceId)
        .catch(swallow(this.logger, `recover orphan via ${engine.type} engine`));
    }
  }

  private resolveSandboxEngine(engineType: SandboxEngineType): SandboxEngine {
    const engine = this.sandboxEngines.get(engineType);
    if (!engine) {
      throw new Error(`Unknown sandbox engine: ${engineType}`);
    }
    return engine;
  }

```

- [ ] **Step 6: 在 `runtime.service.spec.ts` 新增测试**

在现有 `describe("RuntimeService", ...)` 块的 `beforeEach` 里,`service = new RuntimeService(...)` 调用补上第 5 个参数:

```ts
    service = new RuntimeService(
      configService as ConfigService,
      providerRegistry,
      workerHost as never,
      sandboxInstances as unknown as SandboxRuntimeInstanceService,
      [engine]
    );
```

并在 `beforeEach` 顶部新增 `engine` fixture(放在 `sandboxInstances` 定义之前):

```ts
    engine = {
      type: "docker",
      getOrCreate: vi.fn().mockResolvedValue({
        engineType: "docker",
        runtimeInstanceId: "container-1",
        workspaceMountPath: "/workspace",
      }),
      startWorker: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      resume: vi.fn().mockResolvedValue({
        engineType: "docker",
        runtimeInstanceId: "container-1",
        workspaceMountPath: "/workspace",
      }),
      recoverOrphan: vi.fn().mockResolvedValue(undefined),
    };
```

并在文件顶部类型声明区新增 `let engine: SandboxEngine;`,import 里加 `import type { SandboxEngine } from "./sandbox/sandbox-engine";`。

在文件末尾(最后一个 `it(...)` 之后、`});` 收尾之前)新增:

```ts

  describe("sandbox engine facade", () => {
    it("getOrCreateSandbox delegates to the resolved engine", async () => {
      const input = { placement: {} } as never;
      await expect(service.getOrCreateSandbox("docker", input)).resolves.toEqual({
        engineType: "docker",
        runtimeInstanceId: "container-1",
        workspaceMountPath: "/workspace",
      });
      expect(engine.getOrCreate).toHaveBeenCalledWith(input);
    });

    it("resumeSandbox delegates to the resolved engine's resume method", async () => {
      const input = { placement: {} } as never;
      await expect(
        service.resumeSandbox("docker", "container-1", input)
      ).resolves.toEqual({
        engineType: "docker",
        runtimeInstanceId: "container-1",
        workspaceMountPath: "/workspace",
      });
      expect(engine.resume).toHaveBeenCalledWith("container-1", input);
    });

    it("resumeSandbox returns undefined when the engine has no resume support", () => {
      engine.resume = undefined;
      const result = service.resumeSandbox("docker", "container-1", {} as never);
      expect(result).toBeUndefined();
    });

    it("startSandboxWorker delegates to the resolved engine", async () => {
      const runtime = {
        engineType: "docker",
        runtimeInstanceId: "container-1",
        workspaceMountPath: "/workspace",
      } as never;
      const input = {} as never;
      await service.startSandboxWorker("docker", runtime, input);
      expect(engine.startWorker).toHaveBeenCalledWith(runtime, input);
    });

    it("stopSandbox delegates to the resolved engine", async () => {
      await service.stopSandbox("docker", "container-1");
      expect(engine.stop).toHaveBeenCalledWith("container-1");
    });

    it("recoverOrphanSandbox loops all registered engines and swallows individual failures", async () => {
      const secondEngine: SandboxEngine = {
        type: "opensandbox",
        getOrCreate: vi.fn(),
        startWorker: vi.fn(),
        stop: vi.fn(),
        recoverOrphan: vi.fn().mockRejectedValue(new Error("boom")),
      };
      service = new RuntimeService(
        configService as ConfigService,
        providerRegistry,
        workerHost as never,
        sandboxInstances as unknown as SandboxRuntimeInstanceService,
        [engine, secondEngine]
      );

      await expect(
        service.recoverOrphanSandbox("resource-abc")
      ).resolves.toBeUndefined();
      expect(engine.recoverOrphan).toHaveBeenCalledWith("resource-abc");
      expect(secondEngine.recoverOrphan).toHaveBeenCalledWith("resource-abc");
    });
  });
```

- [ ] **Step 7: 跑测试确认通过**

Run: `pnpm --filter api test -- runtime.service.spec.ts runtime-resource.spec.ts`
Expected: PASS(新增 6 个用例 + 原有用例全部通过)

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/runtime/runtime.types.ts apps/api/src/runtime/sandbox/sandbox-engine.ts apps/api/src/runtime/placement/runtime-resource.ts apps/api/src/runtime/runtime.service.ts apps/api/src/runtime/runtime.service.spec.ts
git commit -m "feat(api): add RuntimeService sandbox engine facade methods"
```

---

### Task 2: 新建 `LocalRuntimeProvider`(local 的 fork 机制,`launch()` 返回 channel)

**Files:**
- Create: `apps/api/src/runtime/local/local-runtime.provider.ts`
- Create: `apps/api/src/runtime/local/local-runtime.provider.spec.ts`
- Modify: `apps/api/src/runtime/runtime.types.ts`(新增 `LocalLaunchInput`/`LocalInstanceHandle`)
- Modify: `apps/api/src/runtime/runtime.service.ts`
- Modify: `apps/api/src/runtime/runtime.service.spec.ts`
- Modify: `apps/api/src/runtime/runtime.module.ts`

**Interfaces:**
- Produces: `LocalRuntimeProvider.launch(input: LocalLaunchInput): LocalInstanceHandle`(fork 子进程,返回 `{ runtimeInstanceId, channel }`)、`LocalRuntimeProvider.recoverOrphan(runtimeInstanceId): Promise<void>`(按 `pid:startToken` kill)。`RuntimeService` 新增 `launchLocal(input)`/`recoverOrphanLocal(runtimeInstanceId)`。
- Consumes: 无(`node:child_process`/`node:crypto` 是 Node 内置模块)。

- [ ] **Step 1: 在 `runtime.types.ts` 追加 local 相关类型**

在 `apps/api/src/runtime/runtime.types.ts` 顶部 import 区新增:

```ts
import type { ChildProcess } from "node:child_process";
```

在文件末尾新增:

```ts

// ── Local Provider 契约类型(run 模块的 LocalRunExecutor 与 runtime 的
// LocalRuntimeProvider 之间唯一合法的类型契约面) ──

export type LocalLaunchInput = {
  runId: string;
  env: Record<string, string>;
};

export type LocalInstanceHandle = {
  runtimeInstanceId: string;
  /** fork() 返回的 ChildProcess——调用方(目前是 run 模块)自行接手后续 IPC 收发。 */
  channel: ChildProcess;
};
```

- [ ] **Step 2: 创建 `local-runtime.provider.spec.ts`(先写失败的测试)**

```ts
import { describe, expect, it, vi } from "vitest";
import { LocalRuntimeProvider } from "./local-runtime.provider";

const childProcessMock = vi.hoisted(() => {
  const child = { pid: 12345, connected: true };
  return { child, fork: vi.fn(() => child) };
});

vi.mock("node:child_process", () => ({
  fork: childProcessMock.fork,
}));

describe("LocalRuntimeProvider", () => {
  describe("launch", () => {
    it("forks a worker process and returns the instanceId + channel", () => {
      const provider = new LocalRuntimeProvider();

      const handle = provider.launch({
        runId: "run-1",
        env: { AGEWORK_WORKER_RUN_ID: "run-1" },
      });

      expect(childProcessMock.fork).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({
          env: expect.objectContaining({ AGEWORK_WORKER_RUN_ID: "run-1" }),
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        })
      );
      expect(handle.channel).toBe(childProcessMock.child);
      expect(handle.runtimeInstanceId).toMatch(/^12345:.+/);
    });

    it("generates a distinct startToken per launch", () => {
      const provider = new LocalRuntimeProvider();

      const first = provider.launch({ runId: "run-1", env: {} });
      const second = provider.launch({ runId: "run-2", env: {} });

      expect(first.runtimeInstanceId).not.toBe(second.runtimeInstanceId);
    });
  });

  describe("recoverOrphan", () => {
    it("sends SIGTERM to the pid encoded in a 'pid:token' runtimeInstanceId", async () => {
      const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
      const provider = new LocalRuntimeProvider();

      await provider.recoverOrphan("12345:some-token");

      expect(killSpy).toHaveBeenCalledWith(12345, "SIGTERM");
    });

    it("does nothing for a malformed runtimeInstanceId", async () => {
      const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
      const provider = new LocalRuntimeProvider();

      await provider.recoverOrphan("not-a-valid-runtime-id");

      expect(killSpy).not.toHaveBeenCalled();
    });

    it("ignores ESRCH when the process is already gone", async () => {
      vi.spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      });
      const provider = new LocalRuntimeProvider();

      await expect(
        provider.recoverOrphan("12345:some-token")
      ).resolves.toBeUndefined();
    });
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter api test -- local-runtime.provider.spec.ts`
Expected: FAIL(`Cannot find module './local-runtime.provider'`)

- [ ] **Step 4: 创建 `local-runtime.provider.ts`**

```ts
import { Injectable, Logger } from "@nestjs/common";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { safeLogJson } from "../../common/logging";
import type { LocalInstanceHandle, LocalLaunchInput } from "../runtime.types";

// Worker entry point (TS source, executed via tsx), resolved via the
// `@agework/worker` workspace package so it works regardless of dev/dist
// layout or process cwd.
const WORKER_MAIN = require.resolve("@agework/worker");

// Run the worker through the tsx CLI rather than `node --import tsx/esm`:
// on Node 22.12+ the latter throws ERR_REQUIRE_CYCLE_MODULE for any TS entry
// file that has imports (https://github.com/privatenumber/tsx, tsx 4.22.4).
const TSX_CLI = require.resolve("tsx/cli");

/**
 * local 放置机制的 Provider:fork 一个 worker 子进程,IPC 通信。只负责物理
 * 拉起/终止进程,不参与后续通信内容——channel 随 launch() 返回值交给调用方
 * (目前是 run 模块的 LocalRunExecutor)自行收发,这条边界在设计文档 1.1 节
 * "local 场景的 channel 交接"里有说明。
 */
@Injectable()
export class LocalRuntimeProvider {
  private readonly logger = new Logger(LocalRuntimeProvider.name);

  /** fork 一个本地 worker 子进程,返回逻辑实例标识与 IPC channel。 */
  launch(input: LocalLaunchInput): LocalInstanceHandle {
    const startToken = randomUUID();
    const child = fork(TSX_CLI, [WORKER_MAIN], {
      env: {
        ...process.env,
        ...input.env,
        AGEWORK_WORKER_RUN_START_TOKEN: startToken,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    this.logger.log(
      `local worker forked ${safeLogJson({ runId: input.runId, pid: child.pid })}`
    );
    return {
      runtimeInstanceId: `${child.pid}:${startToken}`,
      channel: child,
    };
  }

  /** runtimeInstanceId 格式为 `pid:startToken`;向 pid 发送 SIGTERM,进程已退出(ESRCH)时忽略。 */
  async recoverOrphan(runtimeInstanceId: string): Promise<void> {
    const [pidStr] = runtimeInstanceId.split(":");
    const pid = Number(pidStr);
    if (!Number.isInteger(pid)) return;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // ESRCH: process already gone
    }
  }
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter api test -- local-runtime.provider.spec.ts`
Expected: PASS

- [ ] **Step 6: 改 `runtime.service.ts`,新增 local 门面方法**

顶部 import 新增:

```ts
import { LocalRuntimeProvider } from "./local/local-runtime.provider";
import type { LocalInstanceHandle, LocalLaunchInput } from "./runtime.types";
```

构造函数新增一个参数(放在最后):

```ts
  constructor(
    private readonly configService: ConfigService,
    private readonly providerRegistry: RuntimeProviderRegistry,
    private readonly workerHost: WorkerHostService,
    private readonly sandboxInstances: SandboxRuntimeInstanceService,
    @Inject(SANDBOX_ENGINES) engines: SandboxEngine[],
    private readonly localProvider: LocalRuntimeProvider
  ) {
```

在 `recoverOrphanSandbox` 方法之后新增:

```ts

  // ── local Provider 门面(run 模块的 LocalRunExecutor 经此拿到 fork 出的进程) ──

  /** fork 一个本地 worker 子进程,返回逻辑实例标识与 IPC channel。 */
  launchLocal(input: LocalLaunchInput): LocalInstanceHandle {
    return this.localProvider.launch(input);
  }

  /** 服务重启后清理中断执行残留的 local 进程。 */
  recoverOrphanLocal(runtimeInstanceId: string): Promise<void> {
    return this.localProvider.recoverOrphan(runtimeInstanceId);
  }

```

- [ ] **Step 7: 在 `runtime.service.spec.ts` 新增测试**

`beforeEach` 里新增 `localProvider` mock 和构造调用参数:

```ts
    localProvider = {
      launch: vi.fn().mockReturnValue({
        runtimeInstanceId: "12345:token",
        channel: {} as never,
      }),
      recoverOrphan: vi.fn().mockResolvedValue(undefined),
    };
    service = new RuntimeService(
      configService as ConfigService,
      providerRegistry,
      workerHost as never,
      sandboxInstances as unknown as SandboxRuntimeInstanceService,
      [engine],
      localProvider as unknown as LocalRuntimeProvider
    );
```

顶部新增 `let localProvider: { launch: ReturnType<typeof vi.fn>; recoverOrphan: ReturnType<typeof vi.fn> };` 和 `import type { LocalRuntimeProvider } from "./local/local-runtime.provider";`。

文件末尾新增:

```ts

  describe("local provider facade", () => {
    it("launchLocal delegates to the local provider", () => {
      const input = { runId: "run-1", env: {} };
      const result = service.launchLocal(input);
      expect(localProvider.launch).toHaveBeenCalledWith(input);
      expect(result).toEqual({ runtimeInstanceId: "12345:token", channel: {} });
    });

    it("recoverOrphanLocal delegates to the local provider", async () => {
      await service.recoverOrphanLocal("12345:token");
      expect(localProvider.recoverOrphan).toHaveBeenCalledWith("12345:token");
    });
  });
```

- [ ] **Step 8: 跑测试确认通过**

Run: `pnpm --filter api test -- runtime.service.spec.ts`
Expected: PASS

- [ ] **Step 9: 在 `runtime.module.ts` 注册 `LocalRuntimeProvider`**

在 `apps/api/src/runtime/runtime.module.ts` 顶部新增 import:

```ts
import { LocalRuntimeProvider } from "./local/local-runtime.provider";
```

`providers` 数组里,在 `RuntimeProviderRegistry,` 之后、`RuntimeService,` 之前插入一行:

```ts
    RuntimeProviderRegistry,
    LocalRuntimeProvider,
    RuntimeService,
```

- [ ] **Step 10: 跑 typecheck + 全部 runtime 测试确认通过**

Run: `pnpm --filter api typecheck && pnpm --filter api test -- runtime`
Expected: 全部通过

- [ ] **Step 11: Commit**

```bash
git add apps/api/src/runtime/local apps/api/src/runtime/runtime.types.ts apps/api/src/runtime/runtime.service.ts apps/api/src/runtime/runtime.service.spec.ts apps/api/src/runtime/runtime.module.ts
git commit -m "feat(api): add LocalRuntimeProvider with launch()/channel handoff"
```

---

### Task 3: `LocalRunExecutor` 改用 `RuntimeService.launchLocal`/`recoverOrphanLocal`

**Files:**
- Modify: `apps/api/src/run/execution/local.executor.ts`
- Modify: `apps/api/src/run/execution/local.executor.spec.ts`
- Modify: `apps/api/src/run/run.module.ts`

**Interfaces:**
- Consumes: `RuntimeService.launchLocal`/`recoverOrphanLocal`(Task 2 产出)。
- 不再 Consumes: `node:child_process` 的 `fork`(不直接调用,改经 `RuntimeService`)。

- [ ] **Step 1: 改 `local.executor.ts`**

顶部 import,从:

```ts
import { Injectable, Logger, OnApplicationShutdown } from "@nestjs/common";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { generateId } from "@agework/shared";
```

改成(删掉 `fork`/`randomUUID`,`ChildProcess` 类型仍要用,保留;新增 `RuntimeService`):

```ts
import { Injectable, Logger, OnApplicationShutdown } from "@nestjs/common";
import type { ChildProcess } from "node:child_process";
import { generateId } from "@agework/shared";
import { RuntimeService } from "../../runtime/runtime.service";
```

删掉这两段常量定义(原文件第 30-38 行,现在挪进了 `LocalRuntimeProvider`):

```ts
// Worker entry point (TS source, executed via tsx), resolved via the
// `@agework/worker` workspace package so it works regardless of dev/dist
// layout or process cwd.
const WORKER_MAIN = require.resolve("@agework/worker");

// Run the worker through the tsx CLI rather than `node --import tsx/esm`:
// on Node 22.12+ the latter throws ERR_REQUIRE_CYCLE_MODULE for any TS entry
// file that has imports (https://github.com/privatenumber/tsx, tsx 4.22.4).
const TSX_CLI = require.resolve("tsx/cli");
```

类声明加构造函数(原来没有构造函数):

```ts
@Injectable()
export class LocalRunExecutor implements RunExecutor, OnApplicationShutdown {
  readonly type = "local" as const;
  private readonly logger = new Logger(LocalRunExecutor.name);
  private readonly states = new Map<string, LocalRunState>();
  private readonly commandSeqs = new Map<string, number>();
  private receiver!: RunEventPort;

  constructor(private readonly runtimeService: RuntimeService) {}

  setRunEventPort(receiver: RunEventPort): void {
    this.receiver = receiver;
  }
```

`start()` 方法里,把 fork 那一段(原文件第 65-80 行,从 `const startToken = randomUUID();` 到 `});` 结束)替换掉。原来是:

```ts
    const startToken = randomUUID();
    const { runId } = runConfig;

    const child = fork(TSX_CLI, [WORKER_MAIN], {
      env: {
        ...process.env,
        AGEWORK_WORKER_KEEP_ALIVE: "false",
        AGEWORK_WORKER_CHANNEL: "ipc",
        AGEWORK_WORKER_RUN_ID: runId,
        AGEWORK_WORKER_RUN_START_TOKEN: startToken,
        ...(runConfig.workerLogFilePath
          ? { AGEWORK_WORKER_LOG_FILE: runConfig.workerLogFilePath }
          : {}),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
```

改成:

```ts
    const { runId } = runConfig;

    const { runtimeInstanceId, channel: child } = this.runtimeService.launchLocal({
      runId,
      env: {
        AGEWORK_WORKER_KEEP_ALIVE: "false",
        AGEWORK_WORKER_CHANNEL: "ipc",
        AGEWORK_WORKER_RUN_ID: runId,
        ...(runConfig.workerLogFilePath
          ? { AGEWORK_WORKER_LOG_FILE: runConfig.workerLogFilePath }
          : {}),
      },
    });
```

紧接着的 `handle` 构造(原来引用 `${child.pid}:${startToken}`)改成直接用 `runtimeInstanceId`:

```ts
    const handle: WorkerExecutionHandle = {
      runId,
      runtimeType: runtimeTarget.runtimeType,
      runtimeInstanceId,
      conversationId: runConfig.conversationId,
    };
```

`cleanupInterruptedExecution` 方法,从:

```ts
  /** runtimeInstanceId 格式为 `pid:startToken`;向 pid 发送 SIGTERM,进程已退出(ESRCH)时忽略。 */
  cleanupInterruptedExecution(runtimeInstanceId: string): Promise<void> {
    const [pidStr] = runtimeInstanceId.split(":");
    const pid = Number(pidStr);
    if (Number.isInteger(pid)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // ESRCH: process already gone
      }
    }
    return Promise.resolve();
  }
```

改成:

```ts
  cleanupInterruptedExecution(runtimeInstanceId: string): Promise<void> {
    return this.runtimeService.recoverOrphanLocal(runtimeInstanceId);
  }
```

其余内容(`sendCommand`/`cancel`/`cleanup`/`terminateExecution`/`onApplicationShutdown`/`normalizeWorkerIpcMessage` 及 child 的 `message`/`exit`/`stdout`/`stderr` 监听)全部原样不动。

- [ ] **Step 2: 重写 `local.executor.spec.ts`**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  LocalRuntimePlacement,
  RunConfig,
  RuntimeTarget,
} from "@agework/shared/protocol";
import { LocalRunExecutor } from "./local.executor";
import type { RuntimeService } from "../../runtime/runtime.service";

const childMock = vi.hoisted(() => ({
  pid: 12345,
  send: vi.fn(),
  on: vi.fn(),
  stdout: { on: vi.fn() },
  stderr: { on: vi.fn() },
  kill: vi.fn(),
  killed: false,
}));

function makeRuntimeService(overrides: Record<string, unknown> = {}) {
  return {
    launchLocal: vi.fn(() => ({
      runtimeInstanceId: "12345:test-token",
      channel: childMock,
    })),
    recoverOrphanLocal: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makePlacement(
  overrides: Partial<LocalRuntimePlacement> = {}
): LocalRuntimePlacement {
  return {
    runtimeType: "local",
    userId: "user-1",
    workspaceId: "ws-1",
    hostPath: "/tmp/ws",
    runtimePath: "/tmp/ws",
    ...overrides,
  };
}

function makeRunConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    runId: "run-1",
    conversationId: "conversation-1",
    workspaceId: "ws-1",
    input: {},
    ...overrides,
  } as RunConfig;
}

function makeRuntimeTarget(
  overrides: Partial<RuntimeTarget> = {}
): RuntimeTarget {
  return {
    ...makePlacement(),
    ownerId: "ws-1",
    ...overrides,
  } as RuntimeTarget;
}

describe("LocalRunExecutor", () => {
  let provider: LocalRunExecutor;
  let runtimeService: ReturnType<typeof makeRuntimeService>;

  beforeEach(() => {
    childMock.send.mockClear();
    childMock.on.mockClear();
    childMock.stdout.on.mockClear();
    childMock.stderr.on.mockClear();
    childMock.kill.mockClear();
    childMock.killed = false;

    runtimeService = makeRuntimeService();
    provider = new LocalRunExecutor(runtimeService as unknown as RuntimeService);
    provider.setRunEventPort({
      sendEvent: vi.fn().mockResolvedValue(undefined),
      notifyWorkerError: vi.fn().mockResolvedValue(undefined),
      notifyCancelledBeforeReady: vi.fn().mockResolvedValue(undefined),
      recordCommandSent: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a provider instance", () => {
    expect(provider).toBeDefined();
  });

  it("start launches a local runtime instance via RuntimeService and sends the run config as RPC", () => {
    const runConfig = makeRunConfig();
    const runtimeTarget = makeRuntimeTarget();

    const handle = provider.start({ runtimeTarget, runConfig });

    try {
      expect(runtimeService.launchLocal).toHaveBeenCalledWith({
        runId: "run-1",
        env: expect.objectContaining({
          AGEWORK_WORKER_KEEP_ALIVE: "false",
          AGEWORK_WORKER_CHANNEL: "ipc",
          AGEWORK_WORKER_RUN_ID: "run-1",
        }),
      });
      expect(childMock.send).toHaveBeenCalledWith(
        expect.objectContaining({
          jsonrpc: "2.0",
          method: "run.config",
          params: { runId: "run-1", config: runConfig },
          meta: expect.objectContaining({ runId: "run-1", seq: 0 }),
        })
      );
      expect(handle).toMatchObject({
        runId: "run-1",
        runtimeType: "local",
        runtimeInstanceId: "12345:test-token",
        conversationId: "conversation-1",
      });
    } finally {
      provider.cleanup("run-1");
    }
  });

  it("start fails fast when the runtime resource is not local", () => {
    expect(() =>
      provider.start({
        runtimeTarget: makeRuntimeTarget({ runtimeType: "sandbox" }),
        runConfig: makeRunConfig(),
      })
    ).toThrow("LocalRunExecutor cannot start worker for runtime type: sandbox");
    expect(runtimeService.launchLocal).not.toHaveBeenCalled();
  });

  it("sendCommand sends JSON-RPC requests over IPC", () => {
    const handle = provider.start({
      runtimeTarget: makeRuntimeTarget(),
      runConfig: makeRunConfig(),
    });
    childMock.send.mockClear();

    provider.sendCommand(handle, { type: "interrupt", commandId: "cmd-1" });

    expect(childMock.send).toHaveBeenCalledWith(
      expect.objectContaining({
        jsonrpc: "2.0",
        id: "cmd-1",
        method: "run.interrupt",
        params: { runId: "run-1" },
        meta: expect.objectContaining({ runId: "run-1", seq: 1 }),
      })
    );
  });

  it("normalizes worker RPC notifications and responses before forwarding", () => {
    const sendEvent = vi.fn().mockResolvedValue(undefined);
    provider.setRunEventPort({
      sendEvent,
      notifyWorkerError: vi.fn().mockResolvedValue(undefined),
      notifyCancelledBeforeReady: vi.fn().mockResolvedValue(undefined),
      recordCommandSent: vi.fn().mockResolvedValue(undefined),
    });
    provider.start({
      runtimeTarget: makeRuntimeTarget(),
      runConfig: makeRunConfig(),
    });
    const messageHandler = childMock.on.mock.calls.find(
      ([event]) => event === "message"
    )?.[1] as ((message: unknown) => void) | undefined;
    expect(messageHandler).toBeTypeOf("function");

    messageHandler?.({
      jsonrpc: "2.0",
      method: "run.status",
      params: { runId: "run-1", status: { status: "running" } },
      meta: { runId: "run-1", seq: 1, ts: "2026-06-27T00:00:00.000Z" },
    });
    messageHandler?.({
      jsonrpc: "2.0",
      id: "cmd-1",
      result: { ok: true, commandType: "cancel" },
      meta: { runId: "run-1", seq: 2, ts: "2026-06-27T00:00:01.000Z" },
    });

    expect(sendEvent).toHaveBeenNthCalledWith(
      1,
      "run-1",
      expect.objectContaining({ type: "run.status", seq: 1, payload: { status: "running" } })
    );
    expect(sendEvent).toHaveBeenNthCalledWith(
      2,
      "run-1",
      expect.objectContaining({
        type: "command.result",
        seq: 2,
        payload: { commandId: "cmd-1", commandType: "cancel", status: "ok" },
      })
    );
  });

  it("terminateExecution sends SIGTERM to the local worker and clears state", () => {
    const handle = provider.start({
      runtimeTarget: makeRuntimeTarget(),
      runConfig: makeRunConfig(),
    });

    provider.terminateExecution("run-1", "run timeout");

    expect(childMock.kill).toHaveBeenCalledWith("SIGTERM");
    provider.sendCommand(handle, { type: "interrupt", commandId: "command-1" });
    expect(childMock.send).toHaveBeenCalledTimes(1);
  });

  it("onApplicationShutdown terminates all in-flight local workers", () => {
    provider.start({ runtimeTarget: makeRuntimeTarget(), runConfig: makeRunConfig() });

    provider.onApplicationShutdown();

    expect(childMock.kill).toHaveBeenCalledWith("SIGTERM");
    provider.sendCommand(
      {
        runId: "run-1",
        runtimeType: "local",
        runtimeInstanceId: "1:token",
        conversationId: "conversation-1",
      },
      { type: "interrupt", commandId: "command-1" }
    );
    expect(childMock.send).toHaveBeenCalledTimes(1); // only the run.config send
  });

  describe("cleanupInterruptedExecution()", () => {
    it("delegates to RuntimeService.recoverOrphanLocal", async () => {
      await provider.cleanupInterruptedExecution("12345:some-token");
      expect(runtimeService.recoverOrphanLocal).toHaveBeenCalledWith(
        "12345:some-token"
      );
    });
  });
});
```

- [ ] **Step 3: 跑测试确认通过**

Run: `pnpm --filter api test -- local.executor.spec.ts`
Expected: PASS

- [ ] **Step 4: 确认 `run.module.ts` 不需要改动**

`run.module.ts` 已经 `imports: [RuntimeModule, ...]`,`LocalRunExecutor` 新增的 `RuntimeService` 依赖走的是这条已存在的边,不需要改 `run.module.ts`。跑一次 module wiring 测试确认:

Run: `pnpm --filter api test -- run.module.spec.ts`
Expected: PASS

- [ ] **Step 5: 跑 typecheck 确认整个仓库编译通过**

Run: `pnpm --filter api typecheck`
Expected: 通过

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/run/execution/local.executor.ts apps/api/src/run/execution/local.executor.spec.ts
git commit -m "refactor(api): LocalRunExecutor launches via RuntimeService.launchLocal"
```

---

### Task 4: 新建 `worker-host/sandbox/`(`SandboxInstanceExecutor` + `sandbox-utils.ts`,暂不接线)

**Files:**
- Create: `apps/api/src/worker-host/sandbox/sandbox-utils.ts`
- Create: `apps/api/src/worker-host/sandbox/sandbox-utils.spec.ts`
- Create: `apps/api/src/worker-host/sandbox/sandbox-instance.executor.ts`
- Create: `apps/api/src/worker-host/sandbox/sandbox-instance.executor.spec.ts`

**Interfaces:**
- Produces: `SandboxInstanceExecutor`(类,构造函数注入 `ConfigService`、`RuntimeService`、`WorkerHostService`),暴露方法:`acquireInstanceForRun(input)`、`releaseInstanceForRun(runId)`、`shutdownRuntimeInstanceByOwnerId(ownerId)`、`recoverOrphan(runtimeInstanceId)`。这份文件**这一步不注册进 `worker-host.module.ts`**,Task 7 才接线(理由见本文档开头"为什么把 6 个改动点分成 7 个 task"一节)。
- Consumes: `RuntimeService.getOrCreateSandbox`/`resumeSandbox`/`startSandboxWorker`/`stopSandbox`/`recoverOrphanSandbox`(Task 1 产出)。

- [ ] **Step 1: 创建 `sandbox-utils.ts`(内容与原 `runtime/sandbox/sandbox-utils.ts` 完全一致,只是搬家)**

```ts
import { resolveApiBasePath } from "../../common/path.util";
import { EnvKey } from "../../config/registry/env-key";

/**
 * worker 容器访问宿主 API 的 base URL。
 * 默认指向 `host.docker.internal:<PORT>`,并拼上与 main.ts 一致的 API 挂载前缀
 * (`<AGEWORK_CONTEXT>/api/v1`),因为 internal runtime API 也在全局前缀之下。
 */
export function resolveDockerApiBase(
  env: Partial<
    Pick<NodeJS.ProcessEnv, "PORT" | "AGEWORK_CONTEXT">
  > = process.env
): string {
  const port = env[EnvKey.PORT] ?? "3000";
  return `http://host.docker.internal:${port}${resolveApiBasePath(
    env[EnvKey.CONTEXT]
  )}`;
}

/**
 * 空闲 watchdog:当某个 owner 的 active run 引用数降为 0 后,
 * 等待 idleTimeoutSeconds 仍无新 run,则触发 onIdle 回调停止容器/sandbox。
 */
export class IdleWatchdog {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  start(key: string, timeoutMs: number, onIdle: () => void): void {
    this.cancel(key);
    const timer = setTimeout(onIdle, timeoutMs);
    // unref 避免空闲 timer 阻止进程退出
    timer.unref();
    this.timers.set(key, timer);
  }

  cancel(key: string): void {
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
  }
}
```

- [ ] **Step 2: 创建 `sandbox-utils.spec.ts`(复制原 `runtime/sandbox/sandbox-utils.spec.ts` 内容,只改 import 路径中的相对深度——两处深度相同,内容原样不动)**

把 `apps/api/src/runtime/sandbox/sandbox-utils.spec.ts` 的完整内容复制到这个新文件。

Run: `diff apps/api/src/runtime/sandbox/sandbox-utils.spec.ts apps/api/src/worker-host/sandbox/sandbox-utils.spec.ts`
Expected: 无差异(两个文件此时内容完全一致,这是预期的——Task 7 会删掉 `runtime` 那一份)

- [ ] **Step 3: 跑测试确认通过**

Run: `pnpm --filter api test -- worker-host/sandbox/sandbox-utils.spec.ts`
Expected: PASS

- [ ] **Step 4: 创建 `sandbox-instance.executor.spec.ts`(先写测试,验证新类调用 `RuntimeService` 而不是直接调 engine)**

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { RunConfig, SandboxRuntimePlacement } from "@agework/shared/protocol";
import { SandboxInstanceExecutor } from "./sandbox-instance.executor";

function makeRuntimeService() {
  let nextId = 0;
  return {
    getOrCreateSandbox: vi.fn().mockImplementation(async () => ({
      engineType: "docker",
      runtimeInstanceId: `docker-resource-${++nextId}`,
      workspaceMountPath: "/workspace",
    })),
    resumeSandbox: vi.fn(),
    startSandboxWorker: vi.fn().mockResolvedValue(undefined),
    stopSandbox: vi.fn().mockResolvedValue(undefined),
    recoverOrphanSandbox: vi.fn().mockResolvedValue(undefined),
  };
}

function makePlacement(
  overrides: Partial<SandboxRuntimePlacement> = {}
): SandboxRuntimePlacement {
  return {
    runtimeType: "sandbox",
    userId: "user-1",
    workspaceId: "ws-1",
    hostPath: "/host/ws-1",
    runtimePath: "/workspace",
    sandbox: {
      isolationScope: "workspace",
      mountTarget: "/workspace",
      sandboxEngineType: "docker",
    },
    ...overrides,
  };
}

function makeRunConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    runId: "run-1",
    conversationId: "conversation-1",
    workspaceId: "ws-1",
    runtimePath: "/workspace",
    env: {},
    input: {},
    agentProviderConfig: { agentType: "claude", source: "custom" },
    ...overrides,
  } as RunConfig;
}

function makeService(runtimeService = makeRuntimeService()) {
  const config = {
    getSandboxEngine: vi.fn().mockReturnValue("docker"),
    getRuntimeLogDir: vi.fn().mockReturnValue("/tmp/agework-logs/runtime"),
    getIdleTimeoutSeconds: vi.fn().mockReturnValue(5),
  };
  const workerHost = {
    cleanupByOwnerId: vi.fn(),
    upsertRunningRuntime: vi.fn().mockResolvedValue({
      resource: { id: "rr-1", runtimeType: "sandbox" },
      workspaceRuntimeInstance: { id: "wr-1" },
    }),
    markRuntimeStoppedByOwner: vi.fn().mockResolvedValue(undefined),
    isRuntimeInstanceBoundToWorkspace: vi.fn().mockResolvedValue(false),
  };
  const executor = new SandboxInstanceExecutor(
    config as never,
    runtimeService as never,
    workerHost as never
  );
  return { executor, runtimeService, config, workerHost };
}

function makeStartInput(placement = makePlacement(), runId = "run-1") {
  return {
    runConfig: makeRunConfig({ runId, workspaceId: placement.workspaceId }),
    runtimeTarget: {
      ...placement,
      ownerId:
        placement.sandbox?.isolationScope === "user"
          ? placement.userId
          : placement.workspaceId,
    },
  };
}

async function flushPromises() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

describe("SandboxInstanceExecutor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("acquire creates the resource via RuntimeService and resolves ready", async () => {
    const { executor, runtimeService, workerHost } = makeService();

    const result = await executor.acquireInstanceForRun(makeStartInput());

    expect(runtimeService.getOrCreateSandbox).toHaveBeenCalledWith(
      "docker",
      expect.objectContaining({
        placement: expect.objectContaining({ ownerId: "ws-1" }),
        env: expect.objectContaining({ AGEWORK_WORKER_OWNER_ID: "ws-1" }),
      })
    );
    expect(runtimeService.startSandboxWorker).toHaveBeenCalled();
    expect(result).toEqual({ outcome: "ready", runtimeInstanceId: "docker-resource-1" });
    expect(workerHost.upsertRunningRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: "ws-1" }),
      "ws-1",
      "docker-resource-1"
    );
  });

  it("acquire attaches a second run of the same owner to the pending container", async () => {
    const runtimeService = makeRuntimeService();
    let resolveGetOrCreate: (runtime: unknown) => void;
    runtimeService.getOrCreateSandbox.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveGetOrCreate = resolve;
        })
    );
    const { executor } = makeService(runtimeService);

    const first = executor.acquireInstanceForRun(makeStartInput());
    const second = executor.acquireInstanceForRun(
      makeStartInput(makePlacement(), "run-2")
    );
    resolveGetOrCreate!({
      engineType: "docker",
      runtimeInstanceId: "docker-resource-1",
      workspaceMountPath: "/workspace",
    });

    await expect(first).resolves.toMatchObject({
      outcome: "ready",
      runtimeInstanceId: "docker-resource-1",
    });
    await expect(second).resolves.toMatchObject({
      outcome: "ready",
      runtimeInstanceId: "docker-resource-1",
    });
    // 一个 owner 只创建一个容器,第二个 run 复用 pending。
    expect(runtimeService.getOrCreateSandbox).toHaveBeenCalledTimes(1);
  });

  it("acquire resolves cancelledBeforeReady when released before the container is ready", async () => {
    const runtimeService = makeRuntimeService();
    let resolveGetOrCreate: (runtime: unknown) => void;
    runtimeService.getOrCreateSandbox.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveGetOrCreate = resolve;
        })
    );
    const { executor } = makeService(runtimeService);

    const acquire = executor.acquireInstanceForRun(makeStartInput());
    executor.releaseInstanceForRun("run-1");
    resolveGetOrCreate!({
      engineType: "docker",
      runtimeInstanceId: "docker-resource-1",
      workspaceMountPath: "/workspace",
    });

    await expect(acquire).resolves.toEqual({ outcome: "cancelledBeforeReady" });
  });

  it("acquire resolves error when the container fails to create", async () => {
    const runtimeService = makeRuntimeService();
    runtimeService.getOrCreateSandbox.mockRejectedValue(new Error("boom"));
    const { executor, workerHost } = makeService(runtimeService);

    const result = await executor.acquireInstanceForRun(makeStartInput());

    expect(result.outcome).toBe("error");
    expect(workerHost.cleanupByOwnerId).toHaveBeenCalledWith("ws-1");
  });

  it("release after ready lets the idle watchdog stop the container", async () => {
    const { executor, runtimeService, workerHost } = makeService();

    await executor.acquireInstanceForRun(makeStartInput());
    executor.releaseInstanceForRun("run-1");
    await vi.advanceTimersByTimeAsync(5_500);

    expect(runtimeService.stopSandbox).toHaveBeenCalledWith("docker", "docker-resource-1");
    expect(workerHost.markRuntimeStoppedByOwner).toHaveBeenCalledWith(
      "sandbox",
      "workspace",
      "ws-1"
    );
  });

  it("shutdownRuntimeInstanceByOwnerId stops the resource and cleans worker-host owner state", async () => {
    const { executor, runtimeService, workerHost } = makeService();

    await executor.acquireInstanceForRun(makeStartInput());
    executor.shutdownRuntimeInstanceByOwnerId("ws-1");
    await flushPromises();

    expect(runtimeService.stopSandbox).toHaveBeenCalledWith("docker", "docker-resource-1");
    expect(workerHost.cleanupByOwnerId).toHaveBeenCalledWith("ws-1");
    expect(workerHost.markRuntimeStoppedByOwner).toHaveBeenCalledWith(
      "sandbox",
      "workspace",
      "ws-1"
    );
  });

  it("delegates orphan recovery to RuntimeService.recoverOrphanSandbox", async () => {
    const { executor, runtimeService } = makeService();

    await executor.recoverOrphan("resource-abc");

    expect(runtimeService.recoverOrphanSandbox).toHaveBeenCalledWith("resource-abc");
  });
});
```

- [ ] **Step 5: 跑测试确认失败**

Run: `pnpm --filter api test -- sandbox-instance.executor.spec.ts`
Expected: FAIL(`Cannot find module './sandbox-instance.executor'`)

- [ ] **Step 6: 创建 `sandbox-instance.executor.ts`(改编自 `runtime/sandbox/sandbox-instance.service.ts`)**

```ts
import { Injectable, Logger } from "@nestjs/common";
import type {
  AcquireInstanceResult,
  IsolationScope,
  RuntimeTarget,
  SandboxRuntimePlacement,
  WorkerExecutionStartInput,
} from "@agework/shared/protocol";
import { isSandboxPlacement } from "../../runtime/runtime.types";
import { RuntimeService } from "../../runtime/runtime.service";
import { WorkerHostService } from "../worker-host.service";
import { ConfigService } from "../../config/config.service";
import {
  CONTAINER_RUNTIME_LOG_DIR,
  DEFAULT_WORKER_IMAGE,
} from "../../config/registry/defaults";
import { swallow } from "../../common/swallow";
import { IdleWatchdog, resolveDockerApiBase } from "./sandbox-utils";
import type {
  SandboxEngineType,
  SandboxPlacement,
  SandboxRuntime,
  SandboxStartInput,
} from "../../runtime/runtime.types";
import { errorLogFields, safeLogJson } from "../../common/logging";
import { safePathPart } from "../../common/safe-path";

export type SandboxOwnerState = {
  runtimeInstanceId: string;
  /** 上次 idle/心跳超时释放时的容器 ID,供下次 start() resume;resume 成功或全新创建后清空。 */
  lastStoppedRuntimeInstanceId?: string;
  activeRunCount: number;
  isolationScope: IsolationScope;
  engineType: SandboxEngineType;
};

export type SandboxWorkerExecutionContext = {
  runConfig: WorkerExecutionStartInput["runConfig"];
  runtimeTarget: RuntimeTarget;
  placement: SandboxRuntimePlacement;
  runId: string;
  workspaceId: string;
  ownerId: string;
  isolationScope: IsolationScope;
  engineType: SandboxEngineType;
};

export type SandboxRuntimeInstanceAttachment = {
  context: SandboxWorkerExecutionContext;
  ownerState: SandboxOwnerState;
};

export type SandboxRuntimeInstanceCallbacks = {
  runtimeReady(runId: string, runtimeInstanceId: string): void;
  publishWorkerError(runId: string, error: string): void;
  cleanupByOwnerId(ownerId: string): void;
};

/**
 * 一次 run 对持久容器实例的「取得」状态:在容器就绪/失败/早取消之前持有 acquire 的
 * resolve(settle);settle 调用后置空表示已结算,state 仍保留以便 release 释放 owner
 * 引用计数。cancelled 标记取消请求早于就绪到达(由 releaseInstanceForRun 在 pending 期设置)。
 */
type AcquireRunState = {
  ownerId: string;
  cancelled: boolean;
  settle?: (result: AcquireInstanceResult) => void;
};

/**
 * sandbox 实例编排:owner 复用判断、idle watchdog、WorkerRegistry 读写——这些是
 * "要不要新开一个实例、这个 owner 现在绑的实例还活不活"的编排决策,归属 worker-host
 * (设计文档 1.1 节)。物理 sandbox 操作(docker/opensandbox 的 getOrCreate/resume/
 * startWorker/stop)经 `RuntimeService` 转发给 `runtime` 模块,本类不直接认识
 * 具体 engine。
 */
@Injectable()
export class SandboxInstanceExecutor {
  private readonly logger = new Logger(SandboxInstanceExecutor.name);

  private readonly ownerStates = new Map<string, SandboxOwnerState>();
  private readonly acquireStates = new Map<string, AcquireRunState>();
  private readonly pendingSandboxes = new Map<string, Promise<SandboxRuntime>>();
  private readonly idleWatchdog = new IdleWatchdog();

  constructor(
    private readonly configService: ConfigService,
    private readonly runtimeService: RuntimeService,
    private readonly workerHost: WorkerHostService
  ) {}

  /**
   * 为一次 run 取得持久容器实例(创建/复用/attach),把就绪结果一次性回传 run 层执行编排。
   * 自身只管资源生命周期:发 owner accessKey、retain 引用计数、attach/start 实例;
   * worker session 的 openSession / 命令下发由 run 层在 ready 后自行对 worker-host 完成。
   */
  acquireInstanceForRun(
    input: WorkerExecutionStartInput
  ): Promise<AcquireInstanceResult> {
    const context = this.resolveWorkerExecutionContext(input);
    this.logWorkerExecutionStart(context);
    const ownerState = this.ensureOwnerState(context);
    this.retainOwnerRun(context.ownerId);
    return new Promise<AcquireInstanceResult>((resolve) => {
      this.acquireStates.set(context.runId, {
        ownerId: context.ownerId,
        cancelled: false,
        settle: resolve,
      });
      this.attachOrStartRuntimeInstance(
        { context, ownerState },
        this.acquireCallbacks()
      );
    });
  }

  /**
   * 释放一次 run 对持久容器的引用。run 层在 run 终态 cleanup 时调用。
   * 若取得尚未结算(容器未就绪),仅标记 cancelled,待就绪那刻 settle 为
   * cancelledBeforeReady 并释放引用;已结算则直接释放 owner 引用计数。幂等。
   */
  releaseInstanceForRun(runId: string): void {
    const state = this.acquireStates.get(runId);
    if (!state) return;
    if (state.settle) {
      state.cancelled = true;
      return;
    }
    this.releaseOwnerRun(state.ownerId);
    this.acquireStates.delete(runId);
  }

  private acquireCallbacks(): SandboxRuntimeInstanceCallbacks {
    return {
      runtimeReady: (runId, runtimeInstanceId) =>
        this.settleReady(runId, runtimeInstanceId),
      publishWorkerError: (runId, error) => this.settleError(runId, error),
      cleanupByOwnerId: (ownerId) => this.cleanupOwner(ownerId),
    };
  }

  private settleReady(runId: string, runtimeInstanceId: string): void {
    const state = this.acquireStates.get(runId);
    if (!state?.settle) return;
    const settle = state.settle;
    state.settle = undefined;
    if (state.cancelled) {
      this.releaseOwnerRun(state.ownerId);
      this.acquireStates.delete(runId);
      settle({ outcome: "cancelledBeforeReady" });
      return;
    }
    settle({ outcome: "ready", runtimeInstanceId });
  }

  private settleError(runId: string, error: string): void {
    const state = this.acquireStates.get(runId);
    if (!state?.settle) return;
    const settle = state.settle;
    state.settle = undefined;
    settle({ outcome: "error", error });
  }

  /** owner 容器被拆除(创建失败 / 主动停止):结算并清掉该 owner 下所有未释放的 acquire。 */
  private cleanupOwner(ownerId: string): void {
    for (const [runId, state] of this.acquireStates) {
      if (state.ownerId !== ownerId) continue;
      const settle = state.settle;
      state.settle = undefined;
      this.acquireStates.delete(runId);
      settle?.({ outcome: "error", error: "sandbox owner torn down" });
    }
    this.workerHost.cleanupByOwnerId(ownerId);
  }

  private logWorkerExecutionStart(context: SandboxWorkerExecutionContext): void {
    this.logger.log(
      `sandbox run starting ${safeLogJson({
        runId: context.runId,
        conversationId: context.runConfig.conversationId,
        workspaceId: context.workspaceId,
        ownerId: context.ownerId,
        isolationScope: context.isolationScope,
        engineType: context.engineType,
      })}`
    );
  }

  resolveWorkerExecutionContext(
    input: WorkerExecutionStartInput
  ): SandboxWorkerExecutionContext {
    const placement = input.runtimeTarget;
    if (!isSandboxPlacement(placement)) {
      throw new Error(
        `SandboxInstanceExecutor requires sandbox placement, got runtimeType=${placement.runtimeType}`
      );
    }
    const engineType =
      placement.sandbox.sandboxEngineType ?? this.configService.getSandboxEngine();
    return {
      runConfig: input.runConfig,
      runtimeTarget: input.runtimeTarget,
      placement,
      runId: input.runConfig.runId,
      workspaceId: input.runConfig.workspaceId,
      ownerId: input.runtimeTarget.ownerId,
      isolationScope: placement.sandbox.isolationScope,
      engineType,
    };
  }

  private ensureOwnerState(context: SandboxWorkerExecutionContext): SandboxOwnerState {
    let ownerState = this.ownerStates.get(context.ownerId);
    if (!ownerState) {
      ownerState = {
        runtimeInstanceId: "",
        activeRunCount: 0,
        isolationScope: context.isolationScope,
        engineType: context.engineType,
      };
      this.ownerStates.set(context.ownerId, ownerState);
      this.idleWatchdog.cancel(context.ownerId);
      return ownerState;
    }

    if (
      !ownerState.runtimeInstanceId &&
      !this.pendingSandboxes.has(context.ownerId) &&
      !ownerState.lastStoppedRuntimeInstanceId
    ) {
      ownerState.engineType = context.engineType;
    }

    this.idleWatchdog.cancel(context.ownerId);
    return ownerState;
  }

  private retainOwnerRun(ownerId: string): void {
    const ownerState = this.ownerStates.get(ownerId);
    if (!ownerState) return;
    ownerState.activeRunCount += 1;
    this.idleWatchdog.cancel(ownerId);
  }

  private releaseOwnerRun(ownerId: string): void {
    const state = this.ownerStates.get(ownerId);
    if (!state) return;
    state.activeRunCount = Math.max(0, state.activeRunCount - 1);
    if (state.activeRunCount === 0 && state.runtimeInstanceId) {
      const idleTimeoutMs = this.configService.getIdleTimeoutSeconds() * 1000;
      this.idleWatchdog.start(ownerId, idleTimeoutMs, () => this.handleIdle(ownerId));
    }
  }

  private attachOrStartRuntimeInstance(
    attachment: SandboxRuntimeInstanceAttachment,
    callbacks: SandboxRuntimeInstanceCallbacks
  ): void {
    const { context, ownerState } = attachment;
    if (ownerState.runtimeInstanceId) {
      this.attachReadyRuntimeInstance(attachment, callbacks);
      return;
    }

    const existingPending = this.pendingSandboxes.get(context.ownerId);
    if (existingPending) {
      this.attachPendingRuntimeInstance(attachment, existingPending, callbacks);
      return;
    }

    this.startRuntimeInstanceForOwner(attachment, callbacks);
  }

  /** 停止并删除某 owner 的持久容器/沙箱,并清掉其 worker-host 资源。 */
  shutdownRuntimeInstanceByOwnerId(ownerId: string): void {
    const state = this.ownerStates.get(ownerId);
    this.idleWatchdog.cancel(ownerId);
    if (state?.runtimeInstanceId) {
      this.runtimeService
        .stopSandbox(state.engineType, state.runtimeInstanceId)
        .catch(swallow(this.logger, `stop sandbox for runtime owner ${ownerId}`));
    }
    if (state) {
      this.workerHost
        .markRuntimeStoppedByOwner("sandbox", state.isolationScope, ownerId)
        .catch(
          swallow(this.logger, `mark runtime resource stopped for owner ${ownerId}`)
        );
    }
    this.cleanupOwner(ownerId);
    this.ownerStates.delete(ownerId);
    this.pendingSandboxes.delete(ownerId);
  }

  /** 服务重启后清理中断执行残留的 sandbox runtime 实例。 */
  recoverOrphan(runtimeInstanceId: string): Promise<void> {
    return this.runtimeService.recoverOrphanSandbox(runtimeInstanceId);
  }

  private attachReadyRuntimeInstance(
    attachment: SandboxRuntimeInstanceAttachment,
    callbacks: SandboxRuntimeInstanceCallbacks
  ): void {
    const { context, ownerState } = attachment;
    void this.recordWorkspaceRuntime(
      context.placement,
      context.ownerId,
      ownerState.runtimeInstanceId
    );
    callbacks.runtimeReady(context.runId, ownerState.runtimeInstanceId);
  }

  private attachPendingRuntimeInstance(
    attachment: SandboxRuntimeInstanceAttachment,
    runtimePromise: Promise<SandboxRuntime>,
    callbacks: SandboxRuntimeInstanceCallbacks
  ): void {
    const { context } = attachment;
    void runtimePromise
      .then((runtime) => {
        void this.recordWorkspaceRuntime(
          context.placement,
          context.ownerId,
          runtime.runtimeInstanceId
        );
        callbacks.runtimeReady(context.runId, runtime.runtimeInstanceId);
      })
      .catch((err) => {
        callbacks.publishWorkerError(
          context.runId,
          `sandbox create failed: ${String(err)}`
        );
        this.logger.warn(
          `pending sandbox failed ${safeLogJson({
            runId: context.runId,
            ownerId: context.ownerId,
            engineType: context.engineType,
            ...errorLogFields(err),
          })}`
        );
      });
  }

  private startRuntimeInstanceForOwner(
    attachment: SandboxRuntimeInstanceAttachment,
    callbacks: SandboxRuntimeInstanceCallbacks
  ): void {
    const { context, ownerState } = attachment;
    const engineInput = this.buildSandboxStartInput(context);
    const resumeRuntimeInstanceId = ownerState.lastStoppedRuntimeInstanceId;
    ownerState.lastStoppedRuntimeInstanceId = undefined;

    const runtimePromise = this.createSandbox(
      context,
      engineInput,
      resumeRuntimeInstanceId
    );
    this.pendingSandboxes.set(context.ownerId, runtimePromise);

    void runtimePromise
      .then((runtime) => this.onRuntimeInstanceStarted(attachment, runtime, callbacks))
      .catch((err) => this.onRuntimeInstanceStartFailed(context, err, callbacks));
  }

  private buildSandboxStartInput(context: SandboxWorkerExecutionContext): SandboxStartInput {
    const apiBase = resolveDockerApiBase();
    const sandboxPlacement: SandboxPlacement = {
      isolationScope: context.isolationScope,
      ownerId: context.ownerId,
      workspaceId: context.workspaceId,
      workspaceHostPath: context.placement.hostPath,
      workspaceMountPath: context.placement.sandbox.mountTarget,
    };

    return {
      placement: sandboxPlacement,
      image: DEFAULT_WORKER_IMAGE,
      apiBaseUrl: apiBase,
      env: {
        AGEWORK_WORKER_KEEP_ALIVE: "true",
        AGEWORK_WORKER_CHANNEL: "http",
        AGEWORK_WORKER_API_BASE: apiBase,
        AGEWORK_WORKER_OWNER_ID: context.ownerId,
        AGEWORK_WORKER_RUNTIME_TYPE: "sandbox",
        AGEWORK_WORKER_SANDBOX_ENGINE: context.engineType,
        AGEWORK_WORKER_ISOLATION_SCOPE: context.isolationScope,
        AGEWORK_WORKER_RUNTIME_RESOURCE_NAME: `agework-worker-${safePathPart(
          context.ownerId
        )}`,
        AGEWORK_WORKER_LOG_DIR: CONTAINER_RUNTIME_LOG_DIR,
        AGEWORK_WORKER_LOG_FILE: `${CONTAINER_RUNTIME_LOG_DIR}/${safePathPart(
          context.ownerId
        )}.runtime.worker.log`,
      },
      metadata: {
        "agework.io/runtime-owner-id": context.ownerId,
        "agework.io/isolation-scope": context.isolationScope,
      },
      runtimeLogHostPath: this.configService.getRuntimeLogDir(),
      runtimeLogMountPath: CONTAINER_RUNTIME_LOG_DIR,
      isExpectedRuntimeInstance: (runtimeInstanceId: string) =>
        this.workerHost.isRuntimeInstanceBoundToWorkspace(
          "sandbox",
          context.workspaceId,
          runtimeInstanceId
        ),
    };
  }

  private onRuntimeInstanceStarted(
    attachment: SandboxRuntimeInstanceAttachment,
    runtime: SandboxRuntime,
    callbacks: SandboxRuntimeInstanceCallbacks
  ): void {
    const { context } = attachment;
    this.pendingSandboxes.delete(context.ownerId);
    const state = this.ownerStates.get(context.ownerId);
    if (!state) return;

    state.runtimeInstanceId = runtime.runtimeInstanceId;
    this.logger.log(
      `sandbox created ${safeLogJson({
        ownerId: context.ownerId,
        engine: runtime.engineType,
        resourceId: runtime.runtimeInstanceId.slice(0, 12),
        activeRunCount: state.activeRunCount,
      })}`
    );

    void this.recordWorkspaceRuntime(
      context.placement,
      context.ownerId,
      runtime.runtimeInstanceId
    );

    callbacks.runtimeReady(context.runId, runtime.runtimeInstanceId);
  }

  private onRuntimeInstanceStartFailed(
    context: SandboxWorkerExecutionContext,
    err: unknown,
    callbacks: SandboxRuntimeInstanceCallbacks
  ): void {
    this.pendingSandboxes.delete(context.ownerId);
    this.logger.error(
      `sandbox create failed ${safeLogJson({
        runId: context.runId,
        ownerId: context.ownerId,
        engineType: context.engineType,
        ...errorLogFields(err),
      })}`
    );
    callbacks.publishWorkerError(context.runId, `sandbox create failed: ${String(err)}`);

    this.ownerStates.delete(context.ownerId);
    callbacks.cleanupByOwnerId(context.ownerId);
  }

  private async createSandbox(
    context: SandboxWorkerExecutionContext,
    input: SandboxStartInput,
    resumeRuntimeInstanceId?: string
  ): Promise<SandboxRuntime> {
    if (resumeRuntimeInstanceId) {
      try {
        const runtime = await this.runtimeService.resumeSandbox(
          context.engineType,
          resumeRuntimeInstanceId,
          input
        );
        if (runtime) {
          await this.runtimeService.startSandboxWorker(context.engineType, runtime, input);
          return runtime;
        }
      } catch (err) {
        this.logger.warn(
          `resume failed, falling back to getOrCreate ${safeLogJson({
            resumeRuntimeInstanceId,
            ...errorLogFields(err),
          })}`
        );
      }
    }

    const runtime = await this.runtimeService.getOrCreateSandbox(context.engineType, input);
    await this.runtimeService.startSandboxWorker(context.engineType, runtime, input);
    return runtime;
  }

  private handleIdle(ownerId: string): void {
    const state = this.ownerStates.get(ownerId);
    if (!state || !state.runtimeInstanceId) return;
    if (state.activeRunCount > 0) return;

    this.logger.log(
      `sandbox idle timeout ${safeLogJson({
        ownerId,
        resourceId: state.runtimeInstanceId.slice(0, 12),
        engineType: state.engineType,
      })}`
    );

    this.runtimeService
      .stopSandbox(state.engineType, state.runtimeInstanceId)
      .catch(swallow(this.logger, `stop idle sandbox for runtime owner ${ownerId}`));

    this.releaseOwnerRuntime(ownerId, state);
  }

  /**
   * 放弃对某个 runtime owner 当前容器/沙箱的引用:停止心跳与空闲计时、清空
   * activeRunCount 与 runtimeInstanceId(转存为 lastStoppedRuntimeInstanceId 供下次 resume),
   * 并将 RuntimeTarget 标记为 stopped。access key 保留,供 resume 复用。
   * 不负责真正停止/删除容器——是否需要 engine.stop() 由调用方决定。
   */
  private releaseOwnerRuntime(ownerId: string, state: SandboxOwnerState): void {
    this.idleWatchdog.cancel(ownerId);
    state.activeRunCount = 0;
    state.lastStoppedRuntimeInstanceId = state.runtimeInstanceId;
    state.runtimeInstanceId = "";

    this.workerHost
      .markRuntimeStoppedByOwner("sandbox", state.isolationScope, ownerId)
      .catch(
        swallow(this.logger, `mark runtime resource stopped for owner ${ownerId}`)
      );
  }

  private recordWorkspaceRuntime(
    placement: SandboxRuntimePlacement,
    ownerId: string,
    runtimeInstanceId: string
  ): Promise<void> {
    return this.workerHost
      .upsertRunningRuntime(placement, ownerId, runtimeInstanceId)
      .then(() => undefined)
      .catch(swallow(this.logger, `upsert workspace runtime for owner ${ownerId}`));
  }
}
```

- [ ] **Step 7: 跑测试确认通过**

Run: `pnpm --filter api test -- sandbox-instance.executor.spec.ts`
Expected: PASS

- [ ] **Step 8: 跑 typecheck 确认新文件本身没有类型错误(此时还未接入任何 module,不影响其他文件编译)**

Run: `pnpm --filter api typecheck`
Expected: 通过(新文件不在任何 module 里,但类型独立成立)

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/worker-host/sandbox
git commit -m "feat(api): add worker-host SandboxInstanceExecutor (not wired yet)"
```

---

### Task 5: 新建 `worker-host/lifecycle/`(级联清理,暂不接线)

**Files:**
- Create: `apps/api/src/worker-host/lifecycle/lifecycle.service.ts`
- Create: `apps/api/src/worker-host/lifecycle/lifecycle.service.spec.ts`
- Create: `apps/api/src/worker-host/lifecycle/lifecycle.listener.ts`
- Create: `apps/api/src/worker-host/lifecycle/lifecycle.listener.spec.ts`

**Interfaces:**
- Produces: `RuntimeInstanceLifecycleService`(构造函数注入 `WorkerHostService`、`SandboxInstanceExecutor`,Task 4 产出),暴露 `shutdownForWorkspace(workspaceId)`/`shutdownForUser(userId)`;`RuntimeInstanceLifecycleListener` 不变(`@OnEvent` 监听 workspace/user 删除事件)。**这一步不接线进 `worker-host.module.ts`**。
- Consumes: `SandboxInstanceExecutor.shutdownRuntimeInstanceByOwnerId`(同模块直接调用,不再经 `RuntimeProviderRegistry`)。

- [ ] **Step 1: 创建 `lifecycle.service.spec.ts`(先写测试,验证不再依赖 registry,改为按 runtimeType 直接判断)**

```ts
import { describe, it, expect, vi } from "vitest";
import { RuntimeInstanceLifecycleService } from "./lifecycle.service";

function makeResource(overrides: Record<string, unknown> = {}) {
  return {
    id: "rr-1",
    runtimeType: "sandbox",
    isolationScope: "workspace",
    ownerId: "ws-1",
    status: "running",
    ...overrides,
  };
}

function makeWorkerHost(overrides: Record<string, unknown> = {}) {
  return {
    findRuntimeBindingWithResource: vi.fn().mockResolvedValue(null),
    deleteRuntimeWorkspaceBinding: vi.fn().mockResolvedValue(undefined),
    findWorkspaceIdsByUser: vi.fn().mockResolvedValue([]),
    findRunningRuntimesByOwners: vi.fn().mockResolvedValue([]),
    markRuntimeStoppedById: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeSandboxInstances(overrides: Record<string, unknown> = {}) {
  return {
    shutdownRuntimeInstanceByOwnerId: vi.fn(),
    ...overrides,
  };
}

describe("RuntimeInstanceLifecycleService", () => {
  describe("shutdownForWorkspace", () => {
    it("shuts down a workspace-owned sandbox resource and deletes the workspace binding", async () => {
      const workerHost = makeWorkerHost({
        findRuntimeBindingWithResource: vi.fn().mockResolvedValue({
          id: "wr-1",
          workspaceId: "ws-1",
          resource: makeResource(),
        }),
      });
      const sandboxInstances = makeSandboxInstances();
      const service = new RuntimeInstanceLifecycleService(
        workerHost as never,
        sandboxInstances as never
      );

      await service.shutdownForWorkspace("ws-1");

      expect(workerHost.findRuntimeBindingWithResource).toHaveBeenCalledWith("ws-1");
      expect(sandboxInstances.shutdownRuntimeInstanceByOwnerId).toHaveBeenCalledWith(
        "ws-1"
      );
      expect(workerHost.markRuntimeStoppedById).toHaveBeenCalledWith(
        expect.objectContaining({ id: "rr-1" }),
        "owner_released"
      );
      expect(workerHost.deleteRuntimeWorkspaceBinding).toHaveBeenCalledWith("ws-1");
    });

    it("does not stop a shared user-isolated resource when one workspace is deleted", async () => {
      const workerHost = makeWorkerHost({
        findRuntimeBindingWithResource: vi.fn().mockResolvedValue({
          id: "wr-1",
          workspaceId: "ws-1",
          resource: makeResource({ isolationScope: "user", ownerId: "user-1" }),
        }),
      });
      const sandboxInstances = makeSandboxInstances();
      const service = new RuntimeInstanceLifecycleService(
        workerHost as never,
        sandboxInstances as never
      );

      await service.shutdownForWorkspace("ws-1");

      expect(sandboxInstances.shutdownRuntimeInstanceByOwnerId).not.toHaveBeenCalled();
      expect(workerHost.markRuntimeStoppedById).not.toHaveBeenCalled();
      expect(workerHost.deleteRuntimeWorkspaceBinding).toHaveBeenCalledWith("ws-1");
    });

    it("marks legacy local runtime resources stopped without calling the sandbox executor", async () => {
      const workerHost = makeWorkerHost({
        findRuntimeBindingWithResource: vi.fn().mockResolvedValue({
          id: "wr-1",
          workspaceId: "ws-1",
          resource: makeResource({ runtimeType: "local" }),
        }),
      });
      const sandboxInstances = makeSandboxInstances();
      const service = new RuntimeInstanceLifecycleService(
        workerHost as never,
        sandboxInstances as never
      );

      await service.shutdownForWorkspace("ws-1");

      expect(sandboxInstances.shutdownRuntimeInstanceByOwnerId).not.toHaveBeenCalled();
      expect(workerHost.markRuntimeStoppedById).toHaveBeenCalledWith(
        expect.objectContaining({ id: "rr-1", runtimeType: "local" }),
        "owner_released"
      );
      expect(workerHost.deleteRuntimeWorkspaceBinding).toHaveBeenCalledWith("ws-1");
    });
  });

  describe("shutdownForUser", () => {
    it("shuts down all sandbox resources owned by the user (user-scope + workspace-scope)", async () => {
      const workerHost = makeWorkerHost({
        findWorkspaceIdsByUser: vi.fn().mockResolvedValue([{ id: "ws-2" }]),
        findRunningRuntimesByOwners: vi.fn().mockResolvedValue([
          makeResource({ id: "rr-user", isolationScope: "user", ownerId: "user-1" }),
          makeResource({ id: "rr-ws", ownerId: "ws-2" }),
        ]),
      });
      const sandboxInstances = makeSandboxInstances();
      const service = new RuntimeInstanceLifecycleService(
        workerHost as never,
        sandboxInstances as never
      );

      await service.shutdownForUser("user-1");

      expect(workerHost.findWorkspaceIdsByUser).toHaveBeenCalledWith("user-1");
      expect(workerHost.findRunningRuntimesByOwners).toHaveBeenCalledWith([
        "user-1",
        "ws-2",
      ]);
      expect(sandboxInstances.shutdownRuntimeInstanceByOwnerId).toHaveBeenCalledWith(
        "user-1"
      );
      expect(sandboxInstances.shutdownRuntimeInstanceByOwnerId).toHaveBeenCalledWith(
        "ws-2"
      );
      expect(sandboxInstances.shutdownRuntimeInstanceByOwnerId).toHaveBeenCalledTimes(2);
      expect(workerHost.markRuntimeStoppedById).toHaveBeenCalledWith(
        expect.objectContaining({ id: "rr-user" }),
        "owner_released"
      );
      expect(workerHost.markRuntimeStoppedById).toHaveBeenCalledWith(
        expect.objectContaining({ id: "rr-ws" }),
        "owner_released"
      );
    });
  });

  it("logs a warning and continues when the sandbox executor throws", async () => {
    const workerHost = makeWorkerHost({
      findRunningRuntimesByOwners: vi
        .fn()
        .mockResolvedValue([
          makeResource({ id: "rr-1", ownerId: "ws-1" }),
          makeResource({ id: "rr-2", ownerId: "ws-2" }),
        ]),
    });
    const shutdownRuntimeInstanceByOwnerId = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("boom");
      })
      .mockImplementationOnce(() => undefined);
    const sandboxInstances = makeSandboxInstances({ shutdownRuntimeInstanceByOwnerId });
    const service = new RuntimeInstanceLifecycleService(
      workerHost as never,
      sandboxInstances as never
    );

    await expect(service.shutdownForUser("user-1")).resolves.toBeUndefined();
    expect(shutdownRuntimeInstanceByOwnerId).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter api test -- worker-host/lifecycle/lifecycle.service.spec.ts`
Expected: FAIL(`Cannot find module './lifecycle.service'`)

- [ ] **Step 3: 创建 `lifecycle.service.ts`**

```ts
import { Injectable, Logger } from "@nestjs/common";
import { WorkerHostService } from "../worker-host.service";
import { SandboxInstanceExecutor } from "../sandbox/sandbox-instance.executor";

/**
 * Runtime 资源生命周期清理:
 * - workspace 删除:解除 workspace runtime 绑定,只关闭专属于该 workspace 的资源。
 * - user 删除:关闭该用户名下的所有 user/workspace 隔离资源。
 *
 * 只有 sandbox 资源需要物理关闭(经同模块的 SandboxInstanceExecutor);local 目前
 * 不写 WorkerRegistry,永远不会出现在这里查到的资源里,只是保留 runtimeType 判断
 * 作为防御,不依赖任何多态 registry。
 */
@Injectable()
export class RuntimeInstanceLifecycleService {
  private readonly logger = new Logger(RuntimeInstanceLifecycleService.name);

  constructor(
    private readonly workerHost: WorkerHostService,
    private readonly sandboxInstances: SandboxInstanceExecutor
  ) {}

  /** 关闭专属于该 workspace 的 runtime 资源(user 隔离下的共享资源不受影响)。 */
  async shutdownForWorkspace(workspaceId: string): Promise<void> {
    const binding = await this.workerHost.findRuntimeBindingWithResource(workspaceId);
    if (binding?.resource.status === "running") {
      const resource = binding.resource;
      if (resource.isolationScope === "workspace" && resource.ownerId === workspaceId) {
        await this.shutdownResource(resource);
      }
    }
    await this.workerHost.deleteRuntimeWorkspaceBinding(workspaceId);
  }

  /** 关闭该用户名下所有 runtime 资源(user 级共享资源 + 该用户所有 workspace 级资源)。
   *  user 隔离下 ownerId = userId;workspace 隔离下 ownerId = workspaceId(也归该 user),
   *  通过 ownerId IN (userId, 该 user 的 workspace ids) 匹配。 */
  async shutdownForUser(userId: string): Promise<void> {
    const workspaces = await this.workerHost.findWorkspaceIdsByUser(userId);
    const ownerIds = [userId, ...workspaces.map((w) => w.id)];
    const resources = await this.workerHost.findRunningRuntimesByOwners(ownerIds);
    for (const resource of resources) {
      await this.shutdownResource(resource);
    }
  }

  private async shutdownResource(resource: {
    id: string;
    runtimeType: string;
    isolationScope: string;
    ownerId: string;
  }): Promise<void> {
    try {
      if (resource.runtimeType === "sandbox") {
        await Promise.resolve(
          this.sandboxInstances.shutdownRuntimeInstanceByOwnerId(resource.ownerId)
        );
      }
      await this.workerHost.markRuntimeStoppedById(resource, "owner_released");
    } catch (err) {
      this.logger.warn(
        `Failed to shut down runtime resource ${resource.id}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter api test -- worker-host/lifecycle/lifecycle.service.spec.ts`
Expected: PASS

- [ ] **Step 5: 创建 `lifecycle.listener.ts`(内容与原 `runtime/instances/lifecycle.listener.ts` 完全一致,只是搬家——两个位置深度相同,`../../workspace/workspace.events` 等 import 路径不变)**

```ts
import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { RuntimeInstanceLifecycleService } from "./lifecycle.service";
import {
  WORKSPACE_DELETED_EVENT,
  WorkspaceDeletedEvent,
} from "../../workspace/workspace.events";
import {
  USER_DELETED_EVENT,
  USER_DISABLED_EVENT,
  UserDeletedEvent,
  UserDisabledEvent,
} from "../../user/user.events";

/**
 * 监听底层领域的删除事件,清理对应的 runtime 资源。
 * best-effort:失败仅记录日志,不影响来源操作(idle 超时与 GC 仍是兜底)。
 */
@Injectable()
export class RuntimeInstanceLifecycleListener {
  private readonly logger = new Logger(RuntimeInstanceLifecycleListener.name);

  constructor(private readonly lifecycle: RuntimeInstanceLifecycleService) {}

  @OnEvent(WORKSPACE_DELETED_EVENT)
  async onWorkspaceDeleted({ workspaceId }: WorkspaceDeletedEvent): Promise<void> {
    try {
      await this.lifecycle.shutdownForWorkspace(workspaceId);
    } catch (err) {
      this.logger.warn(
        `shutdownForWorkspace failed for ${workspaceId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  @OnEvent([USER_DELETED_EVENT, USER_DISABLED_EVENT])
  async onUserResourcesReleased({
    userId,
  }: UserDeletedEvent | UserDisabledEvent): Promise<void> {
    try {
      await this.lifecycle.shutdownForUser(userId);
    } catch (err) {
      this.logger.warn(
        `shutdownForUser failed for ${userId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
```

- [ ] **Step 6: 创建 `lifecycle.listener.spec.ts`(内容与原 `runtime/instances/lifecycle.listener.spec.ts` 完全一致)**

把原 `apps/api/src/runtime/instances/lifecycle.listener.spec.ts` 的内容复制到这个新文件(只改 `import { RuntimeInstanceLifecycleListener } from "./lifecycle.listener";` 之外的部分完全一致,`../../workspace/workspace.events`/`../../user/user.events` 路径不变)。

- [ ] **Step 7: 跑测试确认通过**

Run: `pnpm --filter api test -- worker-host/lifecycle`
Expected: PASS(两个 spec 文件全过)

- [ ] **Step 8: 跑 typecheck**

Run: `pnpm --filter api typecheck`
Expected: 通过

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/worker-host/lifecycle
git commit -m "feat(api): add worker-host RuntimeInstanceLifecycleService (not wired yet)"
```

---

### Task 6: 新建 `worker-host/admin/`(admin 查询,暂不接线)

**Files:**
- Create: `apps/api/src/worker-host/admin/admin-runtime-query.dto.ts`
- Create: `apps/api/src/worker-host/admin/admin-runtime-query.dto.spec.ts`
- Create: `apps/api/src/worker-host/admin/runtime-instance-id.dto.ts`
- Create: `apps/api/src/worker-host/admin/runtime-instance-id.dto.spec.ts`
- Create: `apps/api/src/worker-host/admin/admin-runtime.controller.ts`
- Create: `apps/api/src/worker-host/admin/admin-runtime.controller.spec.ts`

**Interfaces:**
- Produces: `AdminRuntimeController`(HTTP 路径不变,仍是 `/admin/runtime/*`),改为只调 `WorkerHostService`(Task 7 会往 `WorkerHostService` 加 `getRuntimePolicy`/`getRuntimeStats`/`listResources`/`stopRuntimeInstance` 四个方法,这一步先把 controller 写好)。**这一步不接线进 `worker-host.module.ts` 的 `controllers` 数组**。
- Consumes: `WorkerHostService.getRuntimePolicy`/`getRuntimeStats`/`listResources`/`stopRuntimeInstance`(Task 7 产出,这一步的 spec 用手搓 mock,不受影响)。

- [ ] **Step 1: 创建 `admin-runtime-query.dto.ts`(内容与原文件完全一致,只是搬家——`../../common/...` 路径深度相同)**

```ts
import { IsIn, IsOptional } from "class-validator";
import { PaginationQueryDto } from "../../common/dto/pagination-query.dto";
import { OptionalTrimmedString } from "../../common/decorators/query-value.decorator";

const RUNTIME_INSTANCE_STATUSES = ["running", "stopped", "error", "stale"] as const;

export type RuntimeInstanceStatus = (typeof RUNTIME_INSTANCE_STATUSES)[number];

export class AdminRuntimeResourcesQueryDto extends PaginationQueryDto {
  @IsOptional()
  @OptionalTrimmedString()
  @IsIn([...RUNTIME_INSTANCE_STATUSES])
  status?: RuntimeInstanceStatus;
}
```

- [ ] **Step 2: 复制 `admin-runtime-query.dto.spec.ts`(内容与原文件完全一致)**

把 `apps/api/src/runtime/admin/admin-runtime-query.dto.spec.ts` 的完整内容复制过来,只改顶部 import 的相对路径(与新文件同目录,`./admin-runtime-query.dto` 不变)。

- [ ] **Step 3: 创建 `runtime-instance-id.dto.ts`(内容与原文件完全一致)**

```ts
import { IsNotEmpty, IsString } from "class-validator";
import type { RuntimeInstanceIdRequest } from "@agework/shared/api";

export class RuntimeInstanceIdDto implements RuntimeInstanceIdRequest {
  @IsString()
  @IsNotEmpty()
  id!: string;
}
```

- [ ] **Step 4: 复制 `runtime-instance-id.dto.spec.ts`(内容与原文件完全一致)**

把 `apps/api/src/runtime/admin/runtime-instance-id.dto.spec.ts` 的完整内容复制过来。

- [ ] **Step 5: 跑新增 DTO 测试确认通过**

Run: `pnpm --filter api test -- worker-host/admin`
Expected: PASS(2 个 dto spec 文件)

- [ ] **Step 6: 创建 `admin-runtime.controller.spec.ts`(mock 改成 `WorkerHostService` 形状,方法名不变)**

```ts
import { describe, expect, it, vi } from "vitest";
import { AdminRuntimeController } from "./admin-runtime.controller";

function makeController(workerHost: Record<string, unknown> = {}) {
  return new AdminRuntimeController({
    getRuntimePolicy: vi.fn(),
    getRuntimeStats: vi.fn(),
    listResources: vi.fn(),
    stopRuntimeInstance: vi.fn(),
    ...workerHost,
  } as never);
}

describe("AdminRuntimeController", () => {
  it("delegates resource listing to WorkerHostService", async () => {
    const listResources = vi
      .fn()
      .mockResolvedValue({ list: [], total: 0, pageNo: 1, pageSize: 10 });
    const controller = makeController({ listResources });

    const query = { status: "running", pageNo: 1, pageSize: 10 };
    await controller.listResources(query as never);

    expect(listResources).toHaveBeenCalledWith(query);
  });

  it("delegates stop to WorkerHostService by id", async () => {
    const stopRuntimeInstance = vi.fn().mockResolvedValue({ ok: true });
    const controller = makeController({ stopRuntimeInstance });

    await expect(controller.stopResource({ id: "rr-1" })).resolves.toEqual({
      ok: true,
    });
    expect(stopRuntimeInstance).toHaveBeenCalledWith("rr-1");
  });

  it("delegates policy and stats to WorkerHostService", async () => {
    const getRuntimePolicy = vi.fn().mockReturnValue({ runtimeType: "local" });
    const getRuntimeStats = vi.fn().mockResolvedValue({ activeRuntimes: 0 });
    const controller = makeController({ getRuntimePolicy, getRuntimeStats });

    controller.getRuntimePolicy();
    await controller.getRuntimeStats();

    expect(getRuntimePolicy).toHaveBeenCalled();
    expect(getRuntimeStats).toHaveBeenCalled();
  });
});
```

- [ ] **Step 7: 跑测试确认失败**

Run: `pnpm --filter api test -- worker-host/admin/admin-runtime.controller.spec.ts`
Expected: FAIL(`Cannot find module './admin-runtime.controller'`)

- [ ] **Step 8: 创建 `admin-runtime.controller.ts`(改编自原文件,`RuntimeService` 换成 `WorkerHostService`,方法名/HTTP 路径不变)**

```ts
import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { Roles } from "../../auth/decorators/roles.decorator";
import { WorkerHostService } from "../worker-host.service";
import { RuntimeInstanceIdDto } from "./runtime-instance-id.dto";
import { AdminRuntimeResourcesQueryDto } from "./admin-runtime-query.dto";

@Controller("admin/runtime")
@Roles("admin")
export class AdminRuntimeController {
  constructor(private readonly workerHost: WorkerHostService) {}

  @Get("policy")
  getRuntimePolicy() {
    return this.workerHost.getRuntimePolicy();
  }

  @Get("stats")
  getRuntimeStats() {
    return this.workerHost.getRuntimeStats();
  }

  @Get("resources")
  listResources(@Query() query: AdminRuntimeResourcesQueryDto) {
    return this.workerHost.listResources(query);
  }

  @Post("resources/stop")
  stopResource(@Body() body: RuntimeInstanceIdDto) {
    return this.workerHost.stopRuntimeInstance(body.id);
  }
}
```

- [ ] **Step 9: 跑测试确认通过**

Run: `pnpm --filter api test -- worker-host/admin`
Expected: PASS(全部 4 个 spec 文件)

- [ ] **Step 10: 跑 typecheck**

Run: `pnpm --filter api typecheck`
Expected: 通过(controller 还未注册进任何 module,不影响其他文件)

- [ ] **Step 11: Commit**

```bash
git add apps/api/src/worker-host/admin
git commit -m "feat(api): add worker-host AdminRuntimeController (not wired yet)"
```

---

### Task 7: 翻转依赖方向——接线 worker-host、删除 runtime 旧文件、切 run 模块调用点

**Files:**
- Modify: `apps/api/src/worker-host/worker-host.service.ts`
- Modify: `apps/api/src/worker-host/worker-host.service.spec.ts`
- Modify: `apps/api/src/worker-host/worker-host.module.ts`
- Modify: `apps/api/src/runtime/runtime.service.ts`
- Modify: `apps/api/src/runtime/runtime.service.spec.ts`
- Modify: `apps/api/src/runtime/runtime.module.ts`
- Modify: `apps/api/src/runtime/runtime.module.spec.ts`
- Modify: `apps/api/src/run/execution/sandbox.executor.ts`
- Modify: `apps/api/src/run/execution/sandbox.executor.spec.ts`
- Modify: `apps/api/src/run/recovery/run-recovery.service.ts`
- Modify: `apps/api/src/run/recovery/run-recovery.service.spec.ts`
- Modify: `apps/api/src/run/run.service.ts`
- Modify: `apps/api/src/run/run.service.spec.ts`
- Delete: `apps/api/src/runtime/sandbox/sandbox-instance.service.ts`, `sandbox-instance.service.spec.ts`
- Delete: `apps/api/src/runtime/sandbox/sandbox-runtime-instance.manager.ts`
- Delete: `apps/api/src/runtime/sandbox/sandbox-utils.ts`, `sandbox-utils.spec.ts`
- Delete: `apps/api/src/runtime/instances/lifecycle.service.ts`, `lifecycle.service.spec.ts`
- Delete: `apps/api/src/runtime/instances/lifecycle.listener.ts`, `lifecycle.listener.spec.ts`
- Delete: `apps/api/src/runtime/admin/`(整个目录,6 个文件)
- Delete: `apps/api/src/runtime/providers/provider-registry.ts`, `provider-registry.spec.ts`
- Delete: `apps/api/src/runtime/providers/provider-contracts.ts`

**Interfaces:**
- Produces: `WorkerHostService` 新增 `acquireSandboxInstanceForRun`、`releaseSandboxInstanceForRun`、`recoverOrphanSandboxInstance`、`shutdownSandboxInstanceByOwnerId`、`isRuntimeInstanceUserScoped`、`getRuntimePolicy`、`getRuntimeStats`、`listResources`、`getRuntimeInstanceForAdmin`、`stopRuntimeInstance`。
- Consumes: `RuntimeService.getRuntimePolicy`(唯一还留在 `RuntimeService` 上的纯配置方法)、`SandboxInstanceExecutor`/`RuntimeInstanceLifecycleService`/`RuntimeInstanceLifecycleListener`/`AdminRuntimeController`(Task 4-6 产出,这一步真正接线)。
- 不再 Consumes(从 `RuntimeService` 删除):`acquireInstanceForRun`、`releaseInstanceForRun`、`recoverOrphanInstance`、`getRuntimeStats`、`listResources`、`getRuntimeInstanceForAdmin`、`isRuntimeInstanceUserScoped`、`stopRuntimeInstance`、`shutdownRuntimeInstanceByOwnerId`。

- [ ] **Step 1: 改 `worker-host.service.ts`,新增构造依赖 + 方法**

顶部 import 新增:

```ts
import { NotFoundException } from "@nestjs/common";
import type { AdminRunRuntimeInstanceResponse } from "@agework/shared/api";
import { pageWindow } from "../common/dto/pagination-query.dto";
import { RuntimeService } from "../runtime/runtime.service";
import { SandboxInstanceExecutor } from "./sandbox/sandbox-instance.executor";
```

(`Injectable` 已经 import 过,`NotFoundException` 新增。)

构造函数改成:

```ts
@Injectable()
export class WorkerHostService {
  constructor(
    private readonly endpointHandler: WorkerEndpointHandler,
    private readonly upstream: WorkerUpstreamRegistry,
    private readonly commandDispatcher: WorkerCommandDispatcher,
    private readonly registry: WorkerRegistryRepository,
    private readonly runtimeService: RuntimeService,
    private readonly sandboxInstances: SandboxInstanceExecutor
  ) {}
```

在文件末尾(`deleteRuntimeWorkspaceBinding` 方法之后、`buildRuntimeDiagnostics` 方法之前或之后均可,这里放在 `buildRuntimeDiagnostics` 之后)新增:

```ts

  // ── sandbox 实例编排(owner 复用/idle 决策在 worker-host,物理操作转发 runtime) ──
  // 原 RuntimeService.acquireInstanceForRun 等方法随 SandboxInstanceExecutor 一起
  // 搬过来:owner 是否已有活实例、要不要新建/复用/idle 回收,是 worker-host 自己的
  // WorkerRegistry 数据决定的编排决策,不应该反过来让 runtime 依赖 worker-host。

  /** 为一次 sandbox run 取得持久容器实例,ready/cancelledBeforeReady/error 一次性回传。 */
  acquireSandboxInstanceForRun(
    input: WorkerExecutionStartInput
  ): Promise<AcquireInstanceResult> {
    return this.sandboxInstances.acquireInstanceForRun(input);
  }

  /** 释放一次 run 对持久容器的引用(不停止可复用的 runtime 实例)。run 终态时调用。 */
  releaseSandboxInstanceForRun(runId: string): void {
    this.sandboxInstances.releaseInstanceForRun(runId);
  }

  /** 服务重启后清理中断执行残留的 sandbox runtime 实例。 */
  recoverOrphanSandboxInstance(runtimeInstanceId: string): Promise<void> {
    return this.sandboxInstances.recoverOrphan(runtimeInstanceId);
  }

  /** 停止并删除指定 owner 对应的持久容器/沙箱。 */
  shutdownSandboxInstanceByOwnerId(ownerId: string): void {
    this.sandboxInstances.shutdownRuntimeInstanceByOwnerId(ownerId);
  }

  /** 该 runtime instance 是否为 user 级共享隔离(决定中断 run 是否可清理底层资源)。 */
  async isRuntimeInstanceUserScoped(
    runtimeType: string,
    runtimeInstanceId: string
  ): Promise<boolean> {
    const resource = await this.findRuntimeByRuntimeId(runtimeType, runtimeInstanceId);
    return resource?.isolationScope === "user";
  }

  // ── admin:runtime policy / stats / resources(原 RuntimeService,随 WorkerRegistry
  // 数据搬迁——admin 查询本来就是读这份数据,归属 worker-host 更直接) ──

  getRuntimePolicy() {
    return this.runtimeService.getRuntimePolicy();
  }

  async getRuntimeStats() {
    return { activeRuntimes: await this.countRunningRuntimes() };
  }

  async listResources(query: { status?: string; pageNo?: number; pageSize?: number }) {
    const { pageNo, pageSize, take, skip } = pageWindow(query);
    const { items, total } = await this.listRuntimeResourcesPage({
      status: query.status,
      take,
      skip,
    });
    return {
      list: items.map((item) => this.toRuntimeInstanceResponse(item)),
      total,
      pageNo,
      pageSize,
    };
  }

  /**
   * 管理端 run 详情用:按 run 持久化的 runtime handle 取运行实例视图。
   * runtime 资源归属本领域,run 层经此方法获取,不直接查 runtimeInstance 表。
   */
  async getRuntimeInstanceForAdmin(
    runtimeType: string,
    runtimeInstanceId: string
  ): Promise<AdminRunRuntimeInstanceResponse | null> {
    const record = await this.findRuntimeInstanceView(runtimeType, runtimeInstanceId);
    if (!record) return null;
    const { workspaceRuntimeInstances, ...resource } = record;
    return {
      ...resource,
      expiresAt: resource.expiresAt ? this.toIsoString(resource.expiresAt) : null,
      createdAt: this.toIsoString(resource.createdAt),
      updatedAt: this.toIsoString(resource.updatedAt),
      workspaceRuntimes: workspaceRuntimeInstances.map((binding) => ({
        id: binding.id,
        workspaceId: binding.workspaceId,
        createdAt: this.toIsoString(binding.createdAt),
        updatedAt: this.toIsoString(binding.updatedAt),
      })),
    };
  }

  async stopRuntimeInstance(id: string) {
    const resource = await this.findRuntimeById(id);
    if (!resource || resource.status !== "running") {
      throw new NotFoundException(`Runtime resource ${id} not found or not running`);
    }
    if (resource.runtimeType === "sandbox") {
      this.shutdownSandboxInstanceByOwnerId(resource.ownerId);
    }
    await this.markRuntimeStoppedById(resource, "manual_stop");
    return { ok: true };
  }

  private toRuntimeInstanceResponse(resource: RuntimeInstanceRow) {
    const diagnostics = this.buildRuntimeDiagnostics(resource.metadata);
    const workspaceRuntimes = resource.workspaceRuntimeInstances?.map((binding) => ({
      id: binding.id,
      workspaceId: binding.workspaceId,
      createdAt: this.toIsoString(binding.createdAt),
      updatedAt: this.toIsoString(binding.updatedAt),
    }));

    return {
      id: resource.id,
      runtimeType: resource.runtimeType,
      isolationScope: resource.isolationScope,
      ownerId: resource.ownerId,
      runtimeInstanceId: resource.runtimeInstanceId,
      status: resource.status,
      isReusable: resource.status === "running",
      workspaceCount: workspaceRuntimes?.length ?? 0,
      expiresAt: resource.expiresAt ? this.toIsoString(resource.expiresAt) : null,
      metadata: resource.metadata,
      diagnostics: {
        ...diagnostics,
        ownerId: diagnostics.ownerId ?? resource.ownerId,
        runtimeInstanceId: diagnostics.runtimeInstanceId ?? resource.runtimeInstanceId,
      },
      createdAt: this.toIsoString(resource.createdAt),
      updatedAt: this.toIsoString(resource.updatedAt),
      workspaceRuntimes,
    };
  }

  private toIsoString(value: Date | string): string {
    return value instanceof Date ? value.toISOString() : value;
  }
```

在文件顶部新增 `RuntimeInstanceRow` 类型(从原 `runtime.service.ts` 搬过来,放在 import 区之后、`@Injectable()` 之前):

```ts
type RuntimeInstanceRow = {
  id: string;
  runtimeType: string;
  isolationScope: string;
  ownerId: string;
  runtimeInstanceId: string;
  status: string;
  expiresAt: Date | string | null;
  metadata: unknown;
  createdAt: Date | string;
  updatedAt: Date | string;
  workspaceRuntimeInstances?: Array<{
    id: string;
    workspaceId: string;
    createdAt: Date | string;
    updatedAt: Date | string;
  }>;
};
```

顶部还需要新增 `WorkerExecutionStartInput`/`AcquireInstanceResult` 类型 import,补进已有的 `@agework/shared/protocol` import 列表:

```ts
import type {
  AcquireInstanceResult,
  CommandPayload,
  RunConfig,
  SandboxRuntimePlacement,
  WorkerCommandRpcRequest,
  WorkerExecutionStartInput,
} from "@agework/shared/protocol";
```

- [ ] **Step 2: 改 `worker-host.service.spec.ts`,新增测试**

在现有 `makeService`(如果没有统一的构造 helper,直接在每个 `describe` 的 `beforeEach`/局部构造处)补上第 5、6 个构造参数 `runtimeService`/`sandboxInstances` 的 mock。给出新增测试(追加到文件末尾):

```ts

describe("WorkerHostService sandbox instance orchestration", () => {
  function makeService() {
    const runtimeService = { getRuntimePolicy: vi.fn() };
    const sandboxInstances = {
      acquireInstanceForRun: vi.fn(),
      releaseInstanceForRun: vi.fn(),
      recoverOrphan: vi.fn(),
      shutdownRuntimeInstanceByOwnerId: vi.fn(),
    };
    const service = new WorkerHostService(
      {} as never,
      {} as never,
      {} as never,
      {
        findByRuntimeId: vi.fn().mockResolvedValue({ isolationScope: "user" }),
      } as never,
      runtimeService as never,
      sandboxInstances as never
    );
    return { service, runtimeService, sandboxInstances };
  }

  it("acquireSandboxInstanceForRun forwards to the sandbox executor", async () => {
    const { service, sandboxInstances } = makeService();
    const input = { runConfig: { runId: "run-1" } } as never;
    sandboxInstances.acquireInstanceForRun.mockResolvedValue({ outcome: "ready" });

    await expect(service.acquireSandboxInstanceForRun(input)).resolves.toEqual({
      outcome: "ready",
    });
    expect(sandboxInstances.acquireInstanceForRun).toHaveBeenCalledWith(input);
  });

  it("releaseSandboxInstanceForRun forwards to the sandbox executor", () => {
    const { service, sandboxInstances } = makeService();
    service.releaseSandboxInstanceForRun("run-1");
    expect(sandboxInstances.releaseInstanceForRun).toHaveBeenCalledWith("run-1");
  });

  it("recoverOrphanSandboxInstance forwards to the sandbox executor", async () => {
    const { service, sandboxInstances } = makeService();
    await service.recoverOrphanSandboxInstance("inst-1");
    expect(sandboxInstances.recoverOrphan).toHaveBeenCalledWith("inst-1");
  });

  it("shutdownSandboxInstanceByOwnerId forwards to the sandbox executor", () => {
    const { service, sandboxInstances } = makeService();
    service.shutdownSandboxInstanceByOwnerId("ws-1");
    expect(sandboxInstances.shutdownRuntimeInstanceByOwnerId).toHaveBeenCalledWith(
      "ws-1"
    );
  });

  it("isRuntimeInstanceUserScoped reports whether the resource is user-isolated", async () => {
    const { service } = makeService();
    await expect(
      service.isRuntimeInstanceUserScoped("sandbox", "container-1")
    ).resolves.toBe(true);
  });

  it("getRuntimePolicy forwards to RuntimeService", () => {
    const { service, runtimeService } = makeService();
    runtimeService.getRuntimePolicy.mockReturnValue({ runtimeType: "local" });
    expect(service.getRuntimePolicy()).toEqual({ runtimeType: "local" });
  });
});
```

- [ ] **Step 3: 跑测试确认新用例通过、旧用例不受影响**

Run: `pnpm --filter api test -- worker-host.service.spec.ts`
Expected: 之前需要先在旧的 `makeService`/构造调用处补上第 5、6 个参数(否则 TS 报参数数量不匹配),补完后 PASS

- [ ] **Step 4: 改 `runtime.service.ts`,删除已搬迁的方法与依赖**

删除以下方法:`acquireInstanceForRun`、`releaseInstanceForRun`、`recoverOrphanInstance`、`getRuntimeStats`、`listResources`、`getRuntimeInstanceForAdmin`、`isRuntimeInstanceUserScoped`、`stopRuntimeInstance`、`shutdownRuntimeInstanceByOwnerId`,以及私有方法 `toRuntimeInstanceResponse`、`toIsoString`。

删除构造函数里的 `providerRegistry`(`RuntimeProviderRegistry`)、`workerHost`(`WorkerHostService`)、`sandboxInstances`(`SandboxRuntimeInstanceService`)三个参数,删除对应的 import(`RuntimeProviderRegistry`、`WorkerHostService`、`SandboxRuntimeInstanceService`)。删除文件顶部的 `RuntimeInstanceRow` 类型定义(已搬去 `worker-host.service.ts`)、`pageWindow` import、`AdminRunRuntimeInstanceResponse` import、`NotFoundException` import(如果没有其他地方用到)。

`RuntimeService` 最终形态:

```ts
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { RuntimeTarget } from "@agework/shared/protocol";
import { ConfigService } from "../config/config.service";
import {
  resolveRuntimeTarget,
  type ResolveRuntimeTargetInput,
  type RuntimeTargetDefaults,
} from "./placement/runtime-resource";
import { SANDBOX_ENGINES, type SandboxEngine } from "./sandbox/sandbox-engine";
import type { SandboxEngineType, SandboxRuntime, SandboxStartInput } from "./runtime.types";
import { LocalRuntimeProvider } from "./local/local-runtime.provider";
import type { LocalInstanceHandle, LocalLaunchInput } from "./runtime.types";
import { swallow } from "../common/swallow";

/**
 * Runtime 层对上层的门面:纯 Provider 引擎 + placement 计算。不认识 WorkerRegistry、
 * owner 复用规则、idle 决策——那些是 worker-host 的事(设计文档 1.1/3.6 节)。
 * `runtime` 因此是零依赖模块,唯一调用方是 `worker-host`。
 */
@Injectable()
export class RuntimeService {
  private readonly logger = new Logger(RuntimeService.name);
  private readonly defaults: RuntimeTargetDefaults;
  private readonly sandboxEngines: Map<SandboxEngineType, SandboxEngine>;

  constructor(
    private readonly configService: ConfigService,
    @Inject(SANDBOX_ENGINES) engines: SandboxEngine[],
    private readonly localProvider: LocalRuntimeProvider
  ) {
    this.defaults = {
      runtimeType: configService.getDefaultRuntimeType(),
      isolationScope: configService.getDefaultIsolationScope(),
      sandboxEngine: configService.getSandboxEngine(),
    };
    this.sandboxEngines = new Map(engines.map((e) => [e.type, e]));
  }

  /** 从 run 输入解析出目标运行环境(纯计算,不启动 worker)。 */
  resolveRuntimeTarget(input: ResolveRuntimeTargetInput): RuntimeTarget {
    return resolveRuntimeTarget(input, this.defaults);
  }

  getRuntimePolicy() {
    return {
      runtimeType: this.configService.getDefaultRuntimeType(),
      allowedRuntimeTypes: this.configService.getAllowedRuntimeTypes(),
      isolationScope: this.configService.getDefaultIsolationScope(),
      allowedIsolationScopes: this.configService.getAllowedIsolationScopes(),
      idleTimeoutSeconds: this.configService.getIdleTimeoutSeconds(),
    };
  }

  // ── sandbox engine 引擎面 ──────────────────────────────────────────

  getOrCreateSandbox(
    engineType: SandboxEngineType,
    input: SandboxStartInput
  ): Promise<SandboxRuntime> {
    return this.resolveSandboxEngine(engineType).getOrCreate(input);
  }

  resumeSandbox(
    engineType: SandboxEngineType,
    runtimeInstanceId: string,
    input: SandboxStartInput
  ): Promise<SandboxRuntime> | undefined {
    return this.resolveSandboxEngine(engineType).resume?.(runtimeInstanceId, input);
  }

  startSandboxWorker(
    engineType: SandboxEngineType,
    runtime: SandboxRuntime,
    input: SandboxStartInput
  ): Promise<void> {
    return this.resolveSandboxEngine(engineType).startWorker(runtime, input);
  }

  stopSandbox(engineType: SandboxEngineType, runtimeInstanceId: string): Promise<void> {
    return this.resolveSandboxEngine(engineType).stop(runtimeInstanceId);
  }

  async recoverOrphanSandbox(runtimeInstanceId: string): Promise<void> {
    for (const engine of this.sandboxEngines.values()) {
      await engine
        .recoverOrphan(runtimeInstanceId)
        .catch(swallow(this.logger, `recover orphan via ${engine.type} engine`));
    }
  }

  private resolveSandboxEngine(engineType: SandboxEngineType): SandboxEngine {
    const engine = this.sandboxEngines.get(engineType);
    if (!engine) {
      throw new Error(`Unknown sandbox engine: ${engineType}`);
    }
    return engine;
  }

  // ── local Provider 门面 ────────────────────────────────────────────

  launchLocal(input: LocalLaunchInput): LocalInstanceHandle {
    return this.localProvider.launch(input);
  }

  recoverOrphanLocal(runtimeInstanceId: string): Promise<void> {
    return this.localProvider.recoverOrphan(runtimeInstanceId);
  }
}
```

- [ ] **Step 5: 改 `runtime.service.spec.ts`**

删除所有针对已删方法的测试用例(`acquireInstanceForRun`/`releaseInstanceForRun`/`recoverOrphanInstance` 委托测试、`shutdownRuntimeInstanceByOwnerId` 两个用例、`getRuntimeStats`/`listResources`/`stopRuntimeInstance`/`isRuntimeInstanceUserScoped` 用例),删除 `workerHost`/`sandboxInstances`/`providerRegistry`/`resolveSpy`/`shutdownRuntimeInstanceByOwnerId` 等相关 fixture 与 import。

`beforeEach` 里 `service = new RuntimeService(...)` 改成:

```ts
    service = new RuntimeService(
      configService as ConfigService,
      [engine],
      localProvider as unknown as LocalRuntimeProvider
    );
```

保留(不用改)的测试:`resolveRuntimeTarget delegates to the pure resolver with config`、Task 1 新增的 `sandbox engine facade` describe 块、Task 2 新增的 `local provider facade` describe 块。新增一个 `getRuntimePolicy` 委托测试(原本在 `stopRuntimeInstance`/`getRuntimeStats` 等用例附近隐含验证过 `configService` 调用,这里显式补一个):

```ts
  it("getRuntimePolicy reads from ConfigService", () => {
    configService.getAllowedRuntimeTypes = vi.fn().mockReturnValue(["local", "sandbox"]);
    configService.getAllowedIsolationScopes = vi
      .fn()
      .mockReturnValue(["user", "workspace"]);
    const policy = service.getRuntimePolicy();
    expect(policy).toEqual({
      runtimeType: "local",
      allowedRuntimeTypes: ["local", "sandbox"],
      isolationScope: "user",
      allowedIsolationScopes: ["user", "workspace"],
      idleTimeoutSeconds: 600,
    });
  });
```

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm --filter api test -- runtime.service.spec.ts`
Expected: PASS

- [ ] **Step 7: 改 `worker-host.module.ts`,接线新 provider/controller,加 `imports: [RuntimeModule]`**

```ts
import { Module } from "@nestjs/common";

import { RuntimeModule } from "../runtime/runtime.module";
import { WorkerConfigStore } from "./config/config-store";
import { WorkerCommandQueue } from "./command/command-queue";
import { WorkerUpstreamRegistry } from "./upstream/worker-upstream.registry";
import { WorkerCommandDispatcher } from "./command/command-dispatcher.service";
import { WorkerCommandController } from "./command.controller";
import { WorkerRunController } from "./worker-run.controller";
import { WorkerEndpointHandler } from "./worker-endpoint.handler";
import { WorkerHostService } from "./worker-host.service";
import { WorkerRegistryRepository } from "./registry/worker-registry.repository";
import { SandboxInstanceExecutor } from "./sandbox/sandbox-instance.executor";
import { RuntimeInstanceLifecycleService } from "./lifecycle/lifecycle.service";
import { RuntimeInstanceLifecycleListener } from "./lifecycle/lifecycle.listener";
import { AdminRuntimeController } from "./admin/admin-runtime.controller";

/**
 * worker-host:API ↔ worker 进程之间的通信边界(配置下发、命令下发、上行事件),
 * WorkerRegistry 数据归属,以及 sandbox 实例编排(owner 复用/idle 决策)、runtime
 * 资源级联清理、admin 查询——这些原来分散在 `runtime` 模块里的编排逻辑,这次连同
 * WorkerRegistry 数据一起收拢到这里(设计文档 1.1 节)。物理 sandbox/local 操作
 * 经 `RuntimeService` 转发给 `runtime` 模块——这是 `worker-host → runtime` 唯一
 * 合法方向,`runtime` 从不反过来依赖 `worker-host`。
 *
 * 公开面只暴露 WorkerHostService。
 *
 * 开发阶段暂时移除了 worker 端点鉴权(原 WorkerAccessService/WorkerAuthGuard),
 * 待生命周期管理理清后再补。
 */
@Module({
  imports: [RuntimeModule],
  controllers: [WorkerCommandController, WorkerRunController, AdminRuntimeController],
  providers: [
    WorkerConfigStore,
    WorkerCommandQueue,
    WorkerUpstreamRegistry,
    WorkerCommandDispatcher,
    WorkerEndpointHandler,
    WorkerRegistryRepository,
    SandboxInstanceExecutor,
    RuntimeInstanceLifecycleService,
    RuntimeInstanceLifecycleListener,
    WorkerHostService,
  ],
  exports: [WorkerHostService],
})
export class WorkerHostModule {}
```

- [ ] **Step 8: 改 `runtime.module.ts`,摘掉 `WorkerHostModule`,删除已搬迁的 provider/controller**

```ts
import { Module } from "@nestjs/common";

import { DockerSandboxEngine } from "./sandbox/docker-engine";
import { OpenSandboxEngine } from "./sandbox/opensandbox-engine";
import {
  OpenSandboxClient,
  OPENSANDBOX_CLIENT,
} from "./sandbox/opensandbox-client";
import { SANDBOX_ENGINES } from "./sandbox/sandbox-engine";
import type { SandboxEngine } from "./sandbox/sandbox-engine";
import { LocalRuntimeProvider } from "./local/local-runtime.provider";

import { RuntimeService } from "./runtime.service";

// external deps
import { ConfigService } from "../config/config.service";

/**
 * Runtime 领域:纯 Provider 引擎(docker/opensandbox engine + local fork 机制)
 * + placement 计算。不认识 WorkerRegistry、owner 复用规则、idle 决策,不碰 DB——
 * 是零依赖模块,唯一的调用方是 `worker-host`。
 */
@Module({
  providers: [
    DockerSandboxEngine,
    {
      provide: OPENSANDBOX_CLIENT,
      useFactory: (configService: ConfigService) => new OpenSandboxClient(configService),
      inject: [ConfigService],
    },
    OpenSandboxEngine,
    {
      provide: SANDBOX_ENGINES,
      useFactory: (...engines: SandboxEngine[]) => engines,
      inject: [DockerSandboxEngine, OpenSandboxEngine],
    },
    LocalRuntimeProvider,
    RuntimeService,
  ],
  exports: [
    // 公开面:根 Service 是 runtime 唯一稳定对外入口。
    RuntimeService,
  ],
})
export class RuntimeModule {}
```

- [ ] **Step 9: 删除已搬迁的旧文件**

```bash
git rm apps/api/src/runtime/sandbox/sandbox-instance.service.ts \
       apps/api/src/runtime/sandbox/sandbox-instance.service.spec.ts \
       apps/api/src/runtime/sandbox/sandbox-runtime-instance.manager.ts \
       apps/api/src/runtime/sandbox/sandbox-utils.ts \
       apps/api/src/runtime/sandbox/sandbox-utils.spec.ts \
       apps/api/src/runtime/instances/lifecycle.service.ts \
       apps/api/src/runtime/instances/lifecycle.service.spec.ts \
       apps/api/src/runtime/instances/lifecycle.listener.ts \
       apps/api/src/runtime/instances/lifecycle.listener.spec.ts \
       apps/api/src/runtime/admin/admin-runtime.controller.ts \
       apps/api/src/runtime/admin/admin-runtime.controller.spec.ts \
       apps/api/src/runtime/admin/admin-runtime-query.dto.ts \
       apps/api/src/runtime/admin/admin-runtime-query.dto.spec.ts \
       apps/api/src/runtime/admin/runtime-instance-id.dto.ts \
       apps/api/src/runtime/admin/runtime-instance-id.dto.spec.ts \
       apps/api/src/runtime/providers/provider-registry.ts \
       apps/api/src/runtime/providers/provider-registry.spec.ts \
       apps/api/src/runtime/providers/provider-contracts.ts
```

(`runtime/instances/`、`runtime/admin/`、`runtime/providers/` 三个目录此时应该已经是空的,`git rm` 后确认没有残留文件:`find apps/api/src/runtime/instances apps/api/src/runtime/admin apps/api/src/runtime/providers -type f` 应该报"没有那个文件或目录"或返回空。)

- [ ] **Step 10: 改 `runtime.module.spec.ts`**

```ts
import { Injectable, Module } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigModule } from "../config/config.module";
import { ConfigService } from "../config/config.service";
import {
  OpenSandboxClient,
  OPENSANDBOX_CLIENT,
} from "./sandbox/opensandbox-client";
import { SANDBOX_ENGINES, type SandboxEngine } from "./sandbox/sandbox-engine";
import { LocalRuntimeProvider } from "./local/local-runtime.provider";
import { RuntimeService } from "./runtime.service";
import { RuntimeModule } from "./runtime.module";

@Injectable()
class DownstreamRuntimeConsumer {
  constructor(readonly runtimeService: RuntimeService) {}
}

@Module({
  imports: [RuntimeModule],
  providers: [DownstreamRuntimeConsumer],
})
class DownstreamRuntimeConsumerModule {}

describe("RuntimeModule wiring", () => {
  let testingModule: TestingModule | undefined;

  afterEach(async () => {
    await testingModule?.close();
    testingModule = undefined;
    vi.restoreAllMocks();
  });

  it("compiles with zero imports and resolves runtime provider tokens", async () => {
    testingModule = await createRuntimeTestingModule([RuntimeModule]);

    const engines = testingModule.get<SandboxEngine[]>(SANDBOX_ENGINES);
    expect(engines.map((engine) => engine.type).sort()).toEqual([
      "docker",
      "opensandbox",
    ]);

    expect(testingModule.get(OPENSANDBOX_CLIENT)).toBeInstanceOf(OpenSandboxClient);
    expect(testingModule.get(LocalRuntimeProvider)).toBeInstanceOf(LocalRuntimeProvider);
    expect(testingModule.get(RuntimeService)).toBeInstanceOf(RuntimeService);
  });

  it("exports only RuntimeService to downstream modules", async () => {
    testingModule = await createRuntimeTestingModule([DownstreamRuntimeConsumerModule]);

    const consumer = testingModule.get(DownstreamRuntimeConsumer);
    expect(consumer.runtimeService).toBe(testingModule.get(RuntimeService));
  });
});

async function createRuntimeTestingModule(
  runtimeImports: Parameters<typeof Test.createTestingModule>[0]["imports"]
): Promise<TestingModule> {
  return Test.createTestingModule({
    imports: [ConfigModule, ...(runtimeImports ?? [])],
  })
    .overrideProvider(ConfigService)
    .useValue(createConfigServiceMock())
    .compile();
}

function createConfigServiceMock(): Partial<ConfigService> {
  return {
    getDefaultRuntimeType: vi.fn().mockReturnValue("local"),
    getDefaultIsolationScope: vi.fn().mockReturnValue("workspace"),
    getSandboxEngine: vi.fn().mockReturnValue("docker"),
    getRuntimeLogDir: vi.fn().mockReturnValue("/tmp/agework-runtime-logs"),
    getIdleTimeoutSeconds: vi.fn().mockReturnValue(600),
    getOpenSandboxConfig: vi.fn().mockReturnValue({
      domain: "opensandbox.test",
      protocol: "https",
      apiKey: "test-key",
      image: "agework-worker:test",
      timeoutSeconds: 300,
      useServerProxy: false,
    }),
  };
}
```

(注意:`imports` 数组不再需要 `PrismaModule`,也不再 override `PrismaService`——`runtime` 模块现在真正不碰 DB,这正是这次搬家要验证的东西。)

- [ ] **Step 11: 跑 runtime 相关测试确认全部通过**

Run: `pnpm --filter api test -- runtime.module.spec.ts runtime.service.spec.ts`
Expected: PASS

- [ ] **Step 12: 改 `run/execution/sandbox.executor.ts`,call site 从 `runtimeService` 切到 `workerHost`**

构造函数从:

```ts
  constructor(
    private readonly runtimeService: RuntimeService,
    private readonly workerHost: WorkerHostService
  ) {}
```

改成(删掉 `runtimeService`、删掉对应 import `RuntimeService`):

```ts
  constructor(private readonly workerHost: WorkerHostService) {}
```

`start()` 方法里:

```ts
      this.runtimeService
        .acquireInstanceForRun(input)
```

改成:

```ts
      this.workerHost
        .acquireSandboxInstanceForRun(input)
```

`cancel()`/`onAcquired()` 里:

```ts
      this.runtimeService.releaseInstanceForRun(runId);
```

(两处,`onAcquired` 里的 cancelled 分支 和 `cancel()` 方法里)改成:

```ts
      this.workerHost.releaseSandboxInstanceForRun(runId);
```

`cleanup()` 里同样一处 `this.runtimeService.releaseInstanceForRun(runId);` 改成 `this.workerHost.releaseSandboxInstanceForRun(runId);`。

`cleanupInterruptedExecution()`:

```ts
  cleanupInterruptedExecution(runtimeInstanceId: string): Promise<void> {
    return this.runtimeService.recoverOrphanInstance(runtimeInstanceId);
  }
```

改成:

```ts
  cleanupInterruptedExecution(runtimeInstanceId: string): Promise<void> {
    return this.workerHost.recoverOrphanSandboxInstance(runtimeInstanceId);
  }
```

- [ ] **Step 13: 改 `run/execution/sandbox.executor.spec.ts`**

删掉 `runtimeService` fixture 和相关 import(`import { RuntimeService } from "../../runtime/runtime.service";`),`workerHost` fixture 补上 4 个新方法:

```ts
  let workerHost: {
    acquireSandboxInstanceForRun: ReturnType<typeof vi.fn>;
    releaseSandboxInstanceForRun: ReturnType<typeof vi.fn>;
    recoverOrphanSandboxInstance: ReturnType<typeof vi.fn>;
    openSession: ReturnType<typeof vi.fn>;
    sendCommand: ReturnType<typeof vi.fn>;
    cleanupRun: ReturnType<typeof vi.fn>;
  };
```

`beforeEach` 里:

```ts
    workerHost = {
      acquireSandboxInstanceForRun: vi.fn().mockResolvedValue(ready),
      releaseSandboxInstanceForRun: vi.fn(),
      recoverOrphanSandboxInstance: vi.fn().mockResolvedValue(undefined),
      openSession: vi.fn(),
      sendCommand: vi.fn(),
      cleanupRun: vi.fn(),
    };
    ...
    executor = new SandboxRunExecutor(workerHost as unknown as WorkerHostService);
```

把所有断言里的 `runtimeService.acquireInstanceForRun` → `workerHost.acquireSandboxInstanceForRun`,`runtimeService.releaseInstanceForRun` → `workerHost.releaseSandboxInstanceForRun`,`runtimeService.recoverOrphanInstance` → `workerHost.recoverOrphanSandboxInstance`(共 6 处引用需要替换:`start` 用例 1 处、`cancel before ready` 用例 1 处、`cleanup`/`terminateExecution` 用例各 1 处、`cleanupInterruptedExecution` 用例 1 处、以及 `beforeEach` 里构造 mock 那 1 处)。

- [ ] **Step 14: 跑测试确认通过**

Run: `pnpm --filter api test -- sandbox.executor.spec.ts`
Expected: PASS

- [ ] **Step 15: 改 `run/recovery/run-recovery.service.ts`**

构造函数从:

```ts
  constructor(
    private readonly runRepository: RunRepository,
    private readonly conversations: ConversationService,
    private readonly executionService: ExecutionService,
    private readonly runtimeService: RuntimeService
  ) {}
```

改成(删掉 `RuntimeService` import,新增 `WorkerHostService`):

```ts
  constructor(
    private readonly runRepository: RunRepository,
    private readonly conversations: ConversationService,
    private readonly executionService: ExecutionService,
    private readonly workerHost: WorkerHostService
  ) {}
```

`shouldCleanupInterruptedRuntimeResource` 私有方法里:

```ts
    const userScoped = await this.runtimeService
      .isRuntimeInstanceUserScoped(runtimeInstanceId, runtimeType)
      .catch(() => true);
```

(注意保持参数顺序 `runtimeType, runtimeInstanceId` 与原来一致,原文件是 `this.runtimeService.isRuntimeInstanceUserScoped(runtimeType, runtimeInstanceId)`)改成:

```ts
    const userScoped = await this.workerHost
      .isRuntimeInstanceUserScoped(runtimeType, runtimeInstanceId)
      .catch(() => true);
```

顶部 import 加 `import { WorkerHostService } from "../../worker-host/worker-host.service";`,删掉 `import { RuntimeService } from "../../runtime/runtime.service";`。

- [ ] **Step 16: 改 `run-recovery.service.spec.ts`**

把 `makeRuntimeService` 改名 `makeWorkerHost`,内容不变(仍是 `{ isRuntimeInstanceUserScoped: vi.fn()... }`);三处构造调用里的 `runtimeService as RuntimeService` 改成 `workerHost as WorkerHostService`,import 从 `RuntimeService` 换成 `WorkerHostService`(`import { WorkerHostService } from "../../worker-host/worker-host.service";`)。

- [ ] **Step 17: 跑测试确认通过**

Run: `pnpm --filter api test -- run-recovery.service.spec.ts`
Expected: PASS

- [ ] **Step 18: 改 `run/run.service.ts`**

构造函数从:

```ts
  constructor(
    private readonly runRepository: RunRepository,
    private readonly liveRuns: LiveRunRegistry,
    private readonly executionService: ExecutionService,
    private readonly runEvents: RunEventService,
    private readonly runLauncher: RunLauncher,
    private readonly runtimeService: RuntimeService,
    private readonly runRecovery: RunRecoveryService
  ) {}
```

改成(删掉 `RuntimeService` import,新增 `WorkerHostService`):

```ts
  constructor(
    private readonly runRepository: RunRepository,
    private readonly liveRuns: LiveRunRegistry,
    private readonly executionService: ExecutionService,
    private readonly runEvents: RunEventService,
    private readonly runLauncher: RunLauncher,
    private readonly workerHost: WorkerHostService,
    private readonly runRecovery: RunRecoveryService
  ) {}
```

`getDetailForAdmin` 方法里:

```ts
      ? await this.runtimeService.getRuntimeInstanceForAdmin(
```

改成:

```ts
      ? await this.workerHost.getRuntimeInstanceForAdmin(
```

顶部 import 加 `import { WorkerHostService } from "../worker-host/worker-host.service";`,删掉 `import { RuntimeService } from "../runtime/runtime.service";`。

- [ ] **Step 19: 改 `run.service.spec.ts`**

`mockRuntimeService` 改名 `mockWorkerHost`,内容不变(`{ getRuntimeInstanceForAdmin: vi.fn().mockResolvedValue(null) }`),import 从 `RuntimeService` 换成 `WorkerHostService`,构造调用里 `mockRuntimeService as RuntimeService` 改成 `mockWorkerHost as WorkerHostService`。

- [ ] **Step 20: 跑测试确认通过**

Run: `pnpm --filter api test -- run.service.spec.ts`
Expected: PASS

- [ ] **Step 21: 全量跑 api 测试 + typecheck + eslint**

```bash
pnpm --filter api typecheck
pnpm --filter api test
pnpm --filter api lint
```

Expected: 三个命令全部通过(用 `pnpm --filter api lint` 而不只信 tsc——type-aware 的 eslint 规则能抓到 tsc 增量缓存漏报的问题)。

- [ ] **Step 22: 确认 `run.module.ts`/`app.module.ts` 不需要改动**

`run.module.ts` 已经同时 `imports: [RuntimeModule, WorkerHostModule, ...]`,两条边都还在合法使用(`LocalRunExecutor`/`RunLauncher` 用 `RuntimeModule`,`SandboxRunExecutor`/`RunRecoveryService`/`RunService` 用 `WorkerHostModule`),不需要改。`worker-host.module.ts` 新增的 `imports: [RuntimeModule]` 不会导致循环——`RuntimeModule` 此时 `imports: []`。跑一次 `run.module.spec.ts` 确认整图仍然可以正确 bootstrap:

Run: `pnpm --filter api test -- run.module.spec.ts worker-host.module.spec.ts`
Expected: PASS(如果 `worker-host.module.spec.ts` 不存在就跳过,不用新建——本次不要求补这个文件)

- [ ] **Step 23: 手工验证 admin 页面 URL 未变**

```bash
grep -n "admin/runtime" apps/web/src/api/runtime.ts
```

Expected: 4 个 `/api/v1/admin/runtime/*` 路径原样不动,前端不需要任何改动。

- [ ] **Step 24: Commit**

```bash
git add apps/api/src/worker-host apps/api/src/runtime apps/api/src/run
git commit -m "refactor(api): narrow runtime module to pure Provider engine, worker-host owns sandbox orchestration + admin"
```

---

## Self-Review 备注(写计划过程中的自检,供实现时参考)

- **Spec 覆盖**:设计文档 1.1 节"runtime 收窄为纯 Provider 引擎层"→ Task 1/2/7 覆盖;"WorkerRegistry 数据 + 实例编排搬去 worker-host"(已在 Phase 1 完成数据部分)→ Task 4/7 覆盖编排部分;3.5 节"launch() 返回 channel 字段"→ Task 2/3 覆盖(仅 local,且只做机制不做行为迁移);"worker-host → runtime 唯一合法方向"→ Task 7 Step 7 的 `imports: [RuntimeModule]` 覆盖。**没有覆盖、留给 Phase 3**:`resolveInstance()` 本身、local 按 owner 长期复用、worker-host 接管 IPC channel 收发、`run` 只依赖 `worker-host` 一个模块——这些已经跟用户确认过是下一阶段的范围,这份计划的 Global Constraints 里也写明了。
- **命名一致性**:`SandboxInstanceExecutor`(Task 4)在 Task 5/7 里保持同名;`RuntimeService` 新方法名(`getOrCreateSandbox`/`resumeSandbox`/`startSandboxWorker`/`stopSandbox`/`recoverOrphanSandbox`/`launchLocal`/`recoverOrphanLocal`)在 Task 1/2 定义、Task 4 消费、Task 7 最终形态里保持一致;`WorkerHostService` 新方法名(`acquireSandboxInstanceForRun`/`releaseSandboxInstanceForRun`/`recoverOrphanSandboxInstance`/`shutdownSandboxInstanceByOwnerId`/`isRuntimeInstanceUserScoped`/`getRuntimePolicy`/`getRuntimeStats`/`listResources`/`getRuntimeInstanceForAdmin`/`stopRuntimeInstance`)在 Task 7 定义、run 模块消费处(`SandboxRunExecutor`/`RunRecoveryService`/`RunService`)保持一致。
- **占位符扫描**:全文没有 "TBD"/"后面实现"/"参照 Task N" 这类占位,每个 Step 要么是完整代码,要么是"内容与原文件一致,只是搬家"并给出可执行的验证方式(`diff` 或列出要点)。
