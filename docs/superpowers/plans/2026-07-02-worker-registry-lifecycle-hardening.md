# WorkerRegistry 生命周期强化(Phase 5)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把设计文档 `docs/superpowers/specs/2026-06-30-agent-run-new-architecture-design.md` 3.7 节"启动握手状态机"真正落地(`starting` 状态写入 + Phase 1 建好但从未使用过的并发防重唯一索引真正生效 + 启动超时),同时实现"仍待讨论"第 12 条(重启不再物理拆实例,改发 `cancel` 命令)和第 13 条(重启后 local 残留的 `starting`/`running` 行必须清理,否则并发防重唯一索引会把这个 owner 卡死)。

**Architecture:**

现状核实(Phase 4 结束时,已用 Explore agent 逐文件核实过代码,不是从旧记忆推断):

1. **`RuntimeInstance.status` 从未写过 `"starting"`。** `WorkerRegistryRepository.upsertRunning()`(`apps/api/src/worker-host/registry/worker-registry.repository.ts:45-100`)是唯一的写入路径,直接硬编码 `status: "running"`,在物理实例(容器/进程)已经成功创建*之后*才调用。`SandboxInstanceExecutor`/`LocalInstanceExecutor` 的冷启动路径完全不写 DB,直到物理创建成功。Phase 1 建好的并发防重唯一索引(`runtime_instance_active_owner_idx`,`ON RuntimeInstance(ownerId) WHERE status IN ('starting','running')`)因此从未被任何 INSERT 真正命中过——这次要让它第一次真正生效。
2. **冷启动判断目前只看内存,从不查 DB。** `SandboxInstanceExecutor`/`LocalInstanceExecutor` 各自的 `ownerStates`/`pendingSandboxes` 是纯内存态。API 重启后内存清空,但 sandbox 容器是独立进程,重启后大概率还活着,DB 里那一行也还是 `running`——现状代码对此完全无感知,会对着一个仍然活着的 owner 重新起一个容器(旧容器被静默孤立,不再回收)。这次给 sandbox 补上:插入 `starting` 行时如果撞见一条已存在的 `running` 行(唯一索引冲突),直接复用它,不重复起。local 场景不适用(IPC 父子进程关系重启后必然断,复用没有意义,详见设计文档 2.4/仍待讨论第 15 条),遇到任何冲突都直接报错。
3. **重启恢复目前仍然物理拆实例。** `RunRecoveryService.recoverInterruptedRuns()`(`apps/api/src/run/recovery/run-recovery.service.ts`)对非 user-scope 的中断 run 调用 `ExecutionService.cleanupInterruptedExecution()`,顺着 `WorkerRunExecutor → WorkerHostService.recoverOrphanInstance → {SandboxInstanceExecutor,LocalInstanceExecutor}.recoverOrphan → RuntimeService.{recoverOrphanSandbox,recoverOrphanLocal} → engine/provider.recoverOrphan` 这条完整链路,最终物理销毁容器/进程。这条链路**除了这一个调用点之外没有任何其他生产调用方**(已逐个 grep 确认)——这次把它换成"向绑定实例发一条 `cancel` 命令",原有链路里 sandbox 那一半(`SandboxInstanceExecutor.recoverOrphan`、`RuntimeService.recoverOrphanSandbox`、`docker-engine.ts`/`opensandbox-engine.ts` 的 `recoverOrphan()`、`SandboxEngine.recoverOrphan` 接口成员)因此变成死代码,一并删除。local 那一半(`LocalInstanceExecutor.recoverOrphan` → `RuntimeService.recoverOrphanLocal` → `LocalRuntimeProvider.recoverOrphan`,按 `pid:token` 发 `SIGTERM`)**保留**,改由本轮新增的"启动时扫尾"逻辑直接调用——local 进程重启后必然断线,这是唯一还需要真正杀掉底层进程的场景。

**为什么这次要点大:** 3.7 节的握手状态机、"发 cancel 而不是物理拆"、"重启后清理残留 local 行"这三件事互相牵connected——第 3 点(cancel 替代拆除)腾出了 `LocalInstanceExecutor.recoverOrphan` 这个物理清理能力,第 6 个 task(下面)把它接到新的"启动时扫尾"钩子上,不然这个方法会变成孤儿。第 1 点(握手状态机)引入 `starting` 状态后,任何一条卡在 `starting` 的残留行都会通过并发防重唯一索引把对应 owner 彻底卡死——所以"启动时扫尾"必须清空**所有** `starting` 行(不分 runtimeType,因为 `starting` 行本质上就是"上一个进程还没确认完成的启动尝试",那个进程都不在了,不可能再确认),这是第 13 条"实现落地前必须处理"的直接原因。三件事拆开做无法保持每个 task 结束时代码库都是绿的,所以放在同一份计划里,按依赖顺序排列 task。

**本轮明确排除、不做的事(记录在案,不是遗漏)**:
- **不做完整的"取消超时中的物理创建"。** `withTimeout()` 只是放弃等待、把 DB 行标记为 `error`,不会真正取消后台还在跑的 `getOrCreateSandbox`/`startSandboxWorker` 调用——如果这个调用最终还是成功了,会创建出一个没有任何 DB 记录跟踪的孤儿容器。要做到"超时后真正取消/清理背后的物理调用",需要 Provider 契约本身先支持"调用前预生成 instanceId"(设计文档 3.5 节的目标形态,`RuntimeLaunchInput.instanceId`),这是比本轮改动大得多的另一个课题,留给以后。
- **不做真正的"等待另一个并发 launch 完成"轮询机制。** 设计文档 3.7 节字面上说"后到的请求...转去等前面那条记录变成 running 后直接复用",但鉴于:(a) 本项目单进程部署,同进程内的并发 launch 早已被现有的同步内存态检查(`pendingSandboxes`/`ownerStates` 的 check-then-set 之间没有 `await`)完全挡住;(b) `starting` 行本轮会在每次启动时被清空(见上),不会有跨重启的残留 `starting` 冲突;真正撞上"并发防重索引冲突且冲突对象是 starting"这种情况在实践中几乎不可达,直接报错让调用方重试是可接受的简化,不值得为一个几乎不会触发的分支写轮询逻辑。
- **不碰 `missing` 状态**(仍待讨论第 16 条,继续搁置)、**不加自注册鉴权**(第 1 条)、**不改 command-queue 的多 worker 限制**(第 6 条)——这些跟本轮无关。
- **不改变现有可观察行为之外的东西**:sandbox 的 owner 复用/idle 超时语义、local 的 keep-alive 复用语义、admin 查询的 URL 与响应形状,全部保持不变(除了新增的 `starting` 状态会在 admin 面板短暂可见,这是本轮想要的效果,不是意外)。

**Tech Stack:** NestJS 11、TypeScript、Prisma(SQLite)、Vitest(手搓 mock + 构造函数注入)。

## Global Constraints

- 后端命名规则见 `.claude/rules/backend-naming.md`,模块边界规则见 `.claude/rules/backend-architecture.md`——repository/internal provider 不导出,跨模块只调对方导出的根 Service,禁止 `forwardRef`,禁止循环依赖。
- `RuntimeInstance.status` 是 Prisma schema 里的普通 `String` 列(不是 enum),写入 `"starting"` 不需要新的 migration——Phase 1 已经把并发防重唯一索引(`runtime_instance_active_owner_idx`,覆盖 `status IN ('starting','running')`)建好了,本轮第一次真正使用它。
- 每个 task 结束时代码库必须能通过 `pnpm --filter api typecheck`、`pnpm --filter api lint`、`pnpm --filter api test`。
- Prisma 唯一约束冲突用现有仓库约定的 duck-type 检测(`(err as {code?: string})?.code === "P2002"`,参考 `apps/api/src/run-event/run-event.repository.ts:229-236`、`apps/api/src/user/user.repository.ts:204`),每个新写这个检测的文件各自本地定义一份,不抽共享 util(这是仓库现有的两处先例已经确立的约定)。
- 不做本轮范围外的事:见上方"本轮明确排除"清单。

---

### Task 1: `WorkerRegistryRepository` 新增握手状态机需要的三个方法

**Files:**
- Modify: `apps/api/src/worker-host/registry/worker-registry.repository.ts`
- Modify: `apps/api/src/worker-host/registry/worker-registry.repository.spec.ts`

**Interfaces:**
- Produces:
  - `WorkerRegistryRepository.insertStarting(input: UpsertRunningInput, runtimeInstanceId: string, transport: string): Promise<InsertStartingResult>`,其中 `InsertStartingResult = { ok: true } | { ok: false; existing: { runtimeInstanceId: string; status: string } }`。
  - `WorkerRegistryRepository.markAllStartingAsError(): Promise<void>`
  - `WorkerRegistryRepository.findRunningByRuntimeType(runtimeType: string): Promise<Array<{ id: string; runtimeType: string; isolationScope: string; ownerId: string; runtimeInstanceId: string }>>`
  - Task 2/3 消费 `insertStarting`;Task 4 消费 `markAllStartingAsError`/`findRunningByRuntimeType`(经 `WorkerHostService` 新增的透传方法)。

- [ ] **Step 1: 写 `insertStarting` 的失败测试**

在 `apps/api/src/worker-host/registry/worker-registry.repository.spec.ts` 文件末尾追加(该文件已有 `makePrismaMock()` 辅助函数,直接复用):

```ts
describe("insertStarting", () => {
  it("creates a starting row and returns ok:true when no active row exists for the owner", async () => {
    const prismaMocks = makePrismaMock();
    prismaMocks.runtimeInstance.create.mockResolvedValue({ id: "rr-1" });
    const repo = new WorkerRegistryRepository(prismaMocks as never);

    const result = await repo.insertStarting(
      { runtimeType: "sandbox", isolationScope: "workspace", workspaceId: "ws-1", ownerId: "ws-1" },
      "placeholder-1",
      "http"
    );

    expect(result).toEqual({ ok: true });
    expect(prismaMocks.runtimeInstance.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          runtimeType: "sandbox",
          isolationScope: "workspace",
          ownerId: "ws-1",
          runtimeInstanceId: "placeholder-1",
          transport: "http",
          status: "starting",
        }),
      })
    );
  });

  it("returns ok:false with the existing active row when the unique constraint is violated", async () => {
    const prismaMocks = makePrismaMock();
    prismaMocks.runtimeInstance.create.mockRejectedValue({ code: "P2002" });
    prismaMocks.runtimeInstance.findFirst.mockResolvedValue({
      runtimeInstanceId: "docker-resource-1",
      status: "running",
    });
    const repo = new WorkerRegistryRepository(prismaMocks as never);

    const result = await repo.insertStarting(
      { runtimeType: "sandbox", isolationScope: "workspace", workspaceId: "ws-1", ownerId: "ws-1" },
      "placeholder-2",
      "http"
    );

    expect(result).toEqual({
      ok: false,
      existing: { runtimeInstanceId: "docker-resource-1", status: "running" },
    });
    expect(prismaMocks.runtimeInstance.findFirst).toHaveBeenCalledWith({
      where: { ownerId: "ws-1", status: { in: ["starting", "running"] } },
    });
  });

  it("rethrows a P2002 error when no active row is found for the owner (unexpected constraint)", async () => {
    const prismaMocks = makePrismaMock();
    const err = { code: "P2002" };
    prismaMocks.runtimeInstance.create.mockRejectedValue(err);
    prismaMocks.runtimeInstance.findFirst.mockResolvedValue(null);
    const repo = new WorkerRegistryRepository(prismaMocks as never);

    await expect(
      repo.insertStarting(
        { runtimeType: "sandbox", isolationScope: "workspace", workspaceId: "ws-1", ownerId: "ws-1" },
        "placeholder-3",
        "http"
      )
    ).rejects.toBe(err);
  });

  it("rethrows a non-unique-constraint error unchanged", async () => {
    const prismaMocks = makePrismaMock();
    const err = new Error("connection refused");
    prismaMocks.runtimeInstance.create.mockRejectedValue(err);
    const repo = new WorkerRegistryRepository(prismaMocks as never);

    await expect(
      repo.insertStarting(
        { runtimeType: "sandbox", isolationScope: "workspace", workspaceId: "ws-1", ownerId: "ws-1" },
        "placeholder-4",
        "http"
      )
    ).rejects.toBe(err);
    expect(prismaMocks.runtimeInstance.findFirst).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter api test -- worker-registry.repository`
Expected: FAIL(`repo.insertStarting is not a function`)。

- [ ] **Step 3: 实现 `insertStarting`**

编辑 `apps/api/src/worker-host/registry/worker-registry.repository.ts`,在 `upsertRunning` 方法之后新增:

```ts
export type InsertStartingResult =
  | { ok: true }
  | { ok: false; existing: { runtimeInstanceId: string; status: string } };

function isPrismaUniqueError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "P2002"
  );
}
```

在 `upsertRunning` 方法之后新增方法:

```ts
  /**
   * 冷启动前插入一条 starting 记录,靠 Phase 1 建好的 partial unique index
   * (runtime_instance_active_owner_idx,ON ownerId WHERE status IN
   * ('starting','running'))做并发防重。撞见冲突时返回已存在的活跃行,由
   * 调用方决定是复用还是报错(sandbox/local 的策略不同,不在这一层判断)。
   */
  async insertStarting(
    input: UpsertRunningInput,
    runtimeInstanceId: string,
    transport: string
  ): Promise<InsertStartingResult> {
    try {
      await this.prisma.runtimeInstance.create({
        data: {
          id: generateId(),
          ...ownerWhere(input.runtimeType, input.isolationScope, input.ownerId),
          runtimeInstanceId,
          transport,
          status: "starting",
          metadata: runtimeInstanceMetadataJson(
            statusInstanceMetadata({
              runtimeType: input.runtimeType,
              isolationScope: input.isolationScope,
              ownerId: input.ownerId,
              reason: "starting",
            })
          ),
        },
      });
      return { ok: true };
    } catch (err) {
      if (!isPrismaUniqueError(err)) throw err;
      const existing = await this.prisma.runtimeInstance.findFirst({
        where: { ownerId: input.ownerId, status: { in: ["starting", "running"] } },
      });
      if (!existing) throw err;
      return {
        ok: false,
        existing: {
          runtimeInstanceId: existing.runtimeInstanceId,
          status: existing.status,
        },
      };
    }
  }
```

在文件顶部 import 区,把:

```ts
import {
  runtimeInstanceMetadataJson,
  runningInstanceMetadata,
  statusInstanceMetadata,
  stoppedInstanceMetadata,
} from "./worker-registry-metadata";
```

确认 `statusInstanceMetadata` 已经在其中(已有,不用改)。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter api test -- worker-registry.repository`
Expected: PASS(4 个新用例)。

- [ ] **Step 5: 写 `markAllStartingAsError`/`findRunningByRuntimeType` 的失败测试**

在同一个 spec 文件里追加:

```ts
describe("markAllStartingAsError", () => {
  it("updates every starting row to error, regardless of runtimeType", async () => {
    const prismaMocks = makePrismaMock();
    prismaMocks.runtimeInstance.updateMany.mockResolvedValue({ count: 2 });
    const repo = new WorkerRegistryRepository(prismaMocks as never);

    await repo.markAllStartingAsError();

    expect(prismaMocks.runtimeInstance.updateMany).toHaveBeenCalledWith({
      where: { status: "starting" },
      data: expect.objectContaining({ status: "error" }),
    });
  });
});

describe("findRunningByRuntimeType", () => {
  it("finds all running rows for the given runtimeType", async () => {
    const prismaMocks = makePrismaMock();
    prismaMocks.runtimeInstance.findMany.mockResolvedValue([
      { id: "rr-1", runtimeType: "local", isolationScope: "workspace", ownerId: "ws-1", runtimeInstanceId: "4242:token" },
    ]);
    const repo = new WorkerRegistryRepository(prismaMocks as never);

    const result = await repo.findRunningByRuntimeType("local");

    expect(prismaMocks.runtimeInstance.findMany).toHaveBeenCalledWith({
      where: { runtimeType: "local", status: "running" },
    });
    expect(result).toEqual([
      { id: "rr-1", runtimeType: "local", isolationScope: "workspace", ownerId: "ws-1", runtimeInstanceId: "4242:token" },
    ]);
  });
});
```

- [ ] **Step 6: 跑测试确认失败,然后实现**

Run: `pnpm --filter api test -- worker-registry.repository`
Expected: FAIL(两个新方法不存在)。

在 `worker-registry.repository.ts` 里,`markErrorByOwner` 方法之后新增:

```ts
  /**
   * 服务重启后的扫尾用:把所有还卡在 starting 的行标记为 error——这些行代表
   * 上一个(已经不在了的)进程没来得及确认完成的启动尝试,不可能再被确认,
   * 必须清空,否则并发防重唯一索引会把对应 owner 永久卡死(仍待讨论第 13 条)。
   * 不区分 runtimeType:starting 行本身的语义跟放置方式无关。
   */
  async markAllStartingAsError(): Promise<void> {
    await this.prisma.runtimeInstance.updateMany({
      where: { status: "starting" },
      data: {
        status: "error",
        metadata: runtimeInstanceMetadataJson(
          statusInstanceMetadata({
            runtimeType: "",
            isolationScope: "",
            ownerId: "",
            reason: "interrupted_by_restart",
          })
        ),
      },
    });
  }

  /** 按 runtimeType 查找所有 running 状态的行,供重启扫尾用。 */
  findRunningByRuntimeType(runtimeType: string) {
    return this.prisma.runtimeInstance.findMany({
      where: { runtimeType, status: "running" },
    });
  }
```

- [ ] **Step 7: 跑测试确认通过**

Run: `pnpm --filter api test -- worker-registry.repository`
Expected: PASS(全部 6 个新用例)。

- [ ] **Step 8: typecheck + lint**

Run: `pnpm --filter api typecheck && pnpm --filter api lint`
Expected: 零报错。

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/worker-host/registry/worker-registry.repository.ts apps/api/src/worker-host/registry/worker-registry.repository.spec.ts
git commit -m "feat(api): add WorkerRegistryRepository.insertStarting + restart-sweep queries"
```

---

### Task 2: `SandboxInstanceExecutor` 冷启动接入握手状态机(starting → running/error,超时,重启后按 DB 复用)

**Files:**
- Create: `apps/api/src/common/with-timeout.ts`
- Create: `apps/api/src/common/with-timeout.spec.ts`
- Modify: `apps/api/src/config/registry/defaults.ts`
- Modify: `apps/api/src/config/registry/settings-registry.ts`
- Modify: `apps/api/src/config/config.service.ts`
- Modify: `apps/api/src/worker-host/sandbox/sandbox-instance.executor.ts`
- Modify: `apps/api/src/worker-host/sandbox/sandbox-instance.executor.spec.ts`

**Interfaces:**
- Consumes: `WorkerRegistryRepository.insertStarting`(Task 1)。
- Produces: `common/with-timeout.ts` 导出 `withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T>`(Task 3 也会用到同一个工具函数)。`ConfigService.getLaunchTimeoutSeconds(): number`(Task 3 不需要,只有 sandbox 场景异步等待才需要超时)。

- [ ] **Step 1: 写 `withTimeout` 的失败测试**

创建 `apps/api/src/common/with-timeout.spec.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withTimeout } from "./with-timeout";

describe("withTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with the promise's value when it settles before the timeout", async () => {
    const promise = Promise.resolve("done");

    await expect(withTimeout(promise, 1000, "timed out")).resolves.toBe(
      "done"
    );
  });

  it("rejects with a timeout error when the promise never settles in time", async () => {
    const promise = new Promise(() => {
      /* never resolves */
    });

    const result = withTimeout(promise, 1000, "timed out after 1s");
    const assertion = expect(result).rejects.toThrow("timed out after 1s");
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it("rejects with the original error when the promise rejects before the timeout", async () => {
    const promise = Promise.reject(new Error("boom"));

    await expect(withTimeout(promise, 1000, "timed out")).rejects.toThrow(
      "boom"
    );
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter api test -- with-timeout`
Expected: FAIL(`Cannot find module './with-timeout'`)。

- [ ] **Step 3: 实现 `withTimeout`**

创建 `apps/api/src/common/with-timeout.ts`:

```ts
/** 让一个 Promise 跟超时赛跑,超时抛错;不取消原 Promise 本身,只是不再等它。 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter api test -- with-timeout`
Expected: PASS(3 个用例)。

- [ ] **Step 5: 加 `RUNTIME_LAUNCH_TIMEOUT_SECONDS` 配置项**

编辑 `apps/api/src/config/registry/defaults.ts`,在 `DEFAULT_IDLE_TIMEOUT_SECONDS`/`DEFAULT_RUN_TIMEOUT_SECONDS` 之后新增:

```ts
export const DEFAULT_LAUNCH_TIMEOUT_SECONDS = 120;
```

编辑 `apps/api/src/config/registry/settings-registry.ts`,把:

```ts
export const SettingKey = {
  APP_NAME: "AGEWORK_APP_NAME",
  RUNTIME_IDLE_TIMEOUT_SECONDS: "AGEWORK_RUNTIME_IDLE_TIMEOUT_SECONDS",
  RUNTIME_RUN_TIMEOUT_SECONDS: "AGEWORK_RUNTIME_RUN_TIMEOUT_SECONDS",
} as const;
```

改为:

```ts
export const SettingKey = {
  APP_NAME: "AGEWORK_APP_NAME",
  RUNTIME_IDLE_TIMEOUT_SECONDS: "AGEWORK_RUNTIME_IDLE_TIMEOUT_SECONDS",
  RUNTIME_RUN_TIMEOUT_SECONDS: "AGEWORK_RUNTIME_RUN_TIMEOUT_SECONDS",
  RUNTIME_LAUNCH_TIMEOUT_SECONDS: "AGEWORK_RUNTIME_LAUNCH_TIMEOUT_SECONDS",
} as const;
```

把顶部 import 的 `DEFAULT_IDLE_TIMEOUT_SECONDS, DEFAULT_RUN_TIMEOUT_SECONDS` 改成同时引入 `DEFAULT_LAUNCH_TIMEOUT_SECONDS`,并在 `SETTINGS_REGISTRY` 数组里,`RUNTIME_RUN_TIMEOUT_SECONDS` 那一项之后新增:

```ts
  {
    key: SettingKey.RUNTIME_LAUNCH_TIMEOUT_SECONDS,
    type: "number",
    label: "Runtime 启动超时(秒)",
    description: "新建 runtime 实例(容器/进程)超过该时长未就绪则判定为启动失败",
    defaultValue: String(DEFAULT_LAUNCH_TIMEOUT_SECONDS),
  },
```

编辑 `apps/api/src/config/config.service.ts`,在 `getRunTimeoutSeconds()` 方法之后新增:

```ts
  getLaunchTimeoutSeconds(): number {
    return (
      this.getSettingNumber(SettingKey.RUNTIME_LAUNCH_TIMEOUT_SECONDS) ??
      DEFAULT_LAUNCH_TIMEOUT_SECONDS
    );
  }
```

确认文件顶部已经 import `DEFAULT_LAUNCH_TIMEOUT_SECONDS`(如果 `defaults.ts` 是按需具名 import,需要把它加进现有的 import 列表)。

- [ ] **Step 6: 跑现有 config 测试确认零回归**

Run: `pnpm --filter api test -- config`
Expected: 全部通过(不需要为 `getLaunchTimeoutSeconds` 单独写测试——`getIdleTimeoutSeconds`/`getRunTimeoutSeconds` 现有测试模式已经覆盖了这个 helper 的通用逻辑,新方法只是同一个模式的第三次调用)。

- [ ] **Step 7: 写 `SandboxInstanceExecutor` 冷启动新行为的失败测试**

编辑 `apps/api/src/worker-host/sandbox/sandbox-instance.executor.spec.ts`。先把 `makeService()` 辅助函数里的 `registry` mock 补上新方法(`insertStarting`/`markErrorByOwner`),把:

```ts
  const registry = {
    upsertRunning: vi.fn().mockResolvedValue({
      resource: { id: "rr-1", runtimeType: "sandbox" },
      workspaceRuntimeInstance: { id: "wr-1" },
    }),
    markStoppedByOwner: vi.fn().mockResolvedValue(undefined),
    isRuntimeInstanceBoundToWorkspace: vi.fn().mockResolvedValue(false),
  };
```

改为:

```ts
  const registry = {
    insertStarting: vi.fn().mockResolvedValue({ ok: true }),
    upsertRunning: vi.fn().mockResolvedValue({
      resource: { id: "rr-1", runtimeType: "sandbox" },
      workspaceRuntimeInstance: { id: "wr-1" },
    }),
    markStoppedByOwner: vi.fn().mockResolvedValue(undefined),
    markErrorByOwner: vi.fn().mockResolvedValue(undefined),
    isRuntimeInstanceBoundToWorkspace: vi.fn().mockResolvedValue(false),
  };
```

把 `config` mock 补上 `getLaunchTimeoutSeconds`:

```ts
  const config = {
    getSandboxEngine: vi.fn().mockReturnValue("docker"),
    getRuntimeLogDir: vi.fn().mockReturnValue("/tmp/agework-logs/runtime"),
    getIdleTimeoutSeconds: vi.fn().mockReturnValue(5),
    getLaunchTimeoutSeconds: vi.fn().mockReturnValue(60),
  };
```

在文件末尾(`describe("SandboxInstanceExecutor", ...)` 块内,`it("delegates orphan recovery...` 用例之前)追加以下用例:

```ts
  it("writes a starting row before creating the container, then flips it to running", async () => {
    const { executor, registry } = makeService();

    await executor.acquireInstanceForRun(makeStartInput());

    expect(registry.insertStarting).toHaveBeenCalledWith(
      { runtimeType: "sandbox", isolationScope: "workspace", workspaceId: "ws-1", ownerId: "ws-1" },
      expect.any(String),
      "http"
    );
    expect(registry.upsertRunning).toHaveBeenCalledWith(
      { runtimeType: "sandbox", isolationScope: "workspace", workspaceId: "ws-1", ownerId: "ws-1" },
      "docker-resource-1",
      "http"
    );
  });

  it("attaches to an existing running row on insertStarting conflict instead of creating a new container", async () => {
    const runtimeService = makeRuntimeService();
    const { executor, registry } = makeService(runtimeService);
    registry.insertStarting.mockResolvedValueOnce({
      ok: false,
      existing: { runtimeInstanceId: "docker-resource-existing", status: "running" },
    });

    const result = await executor.acquireInstanceForRun(makeStartInput());

    expect(result).toEqual({
      outcome: "ready",
      runtimeInstanceId: "docker-resource-existing",
    });
    expect(runtimeService.getOrCreateSandbox).not.toHaveBeenCalled();
  });

  it("resolves error on insertStarting conflict against a starting row (concurrent launch in progress)", async () => {
    const runtimeService = makeRuntimeService();
    const { executor, registry } = makeService(runtimeService);
    registry.insertStarting.mockResolvedValueOnce({
      ok: false,
      existing: { runtimeInstanceId: "placeholder-x", status: "starting" },
    });

    const result = await executor.acquireInstanceForRun(makeStartInput());

    expect(result.outcome).toBe("error");
    expect(runtimeService.getOrCreateSandbox).not.toHaveBeenCalled();
  });

  it("marks the row as error when the container never becomes ready within the launch timeout", async () => {
    const runtimeService = makeRuntimeService();
    runtimeService.getOrCreateSandbox.mockImplementation(
      () => new Promise(() => {
        /* never resolves */
      })
    );
    const { executor, registry, config } = makeService(runtimeService);
    config.getLaunchTimeoutSeconds.mockReturnValue(1);

    const acquire = executor.acquireInstanceForRun(makeStartInput());
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await acquire;

    expect(result.outcome).toBe("error");
    expect(registry.markErrorByOwner).toHaveBeenCalledWith(
      "sandbox",
      "workspace",
      "ws-1",
      expect.stringContaining("timed out")
    );
  });
```

- [ ] **Step 8: 跑测试确认新用例失败**

Run: `pnpm --filter api test -- sandbox-instance.executor`
Expected: FAIL(`registry.insertStarting` 未被调用等断言失败,因为实现还没改)。

- [ ] **Step 9: 实现——`startRuntimeInstanceForOwner` 接入握手状态机**

编辑 `apps/api/src/worker-host/sandbox/sandbox-instance.executor.ts`。

顶部 import 区新增:

```ts
import { generateId } from "@agework/shared";
import { withTimeout } from "../../common/with-timeout";
```

把现有的:

```ts
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
      .then((runtime) =>
        this.onRuntimeInstanceStarted(attachment, runtime, callbacks)
      )
      .catch((err) =>
        this.onRuntimeInstanceStartFailed(context, err, callbacks)
      );
  }
```

替换为:

```ts
  private startRuntimeInstanceForOwner(
    attachment: SandboxRuntimeInstanceAttachment,
    callbacks: SandboxRuntimeInstanceCallbacks
  ): void {
    const { context } = attachment;
    const runtimePromise = this.launchWithHandshake(attachment);
    this.pendingSandboxes.set(context.ownerId, runtimePromise);

    void runtimePromise
      .then((runtime) =>
        this.onRuntimeInstanceStarted(attachment, runtime, callbacks)
      )
      .catch((err) =>
        this.onRuntimeInstanceStartFailed(context, err, callbacks)
      );
  }

  /**
   * 3.7 节握手状态机:先插入 starting 行(靠 Task 1 的唯一索引防并发重复
   * launch)。撞见冲突且已有行是 running——说明 API 重启导致内存丢了但容器
   * 其实还活着(sandbox 容器不随 API 进程重启而死),直接复用,不重复起；
   * 撞见冲突且已有行是 starting——同进程内真正的并发竞态早已被
   * pendingSandboxes 的同步 check-then-set 挡住,理论上不可达,报错让调用方
   * 重试即可,不做轮询等待(见计划 Architecture 一节)。
   * 插入成功后才真正调用 Provider,超时或失败都把这一行标记为 error。
   */
  private async launchWithHandshake(
    attachment: SandboxRuntimeInstanceAttachment
  ): Promise<SandboxRuntime> {
    const { context, ownerState } = attachment;
    const placeholderInstanceId = generateId();
    const insertResult = await this.registry.insertStarting(
      {
        runtimeType: context.placement.runtimeType,
        isolationScope: context.isolationScope,
        workspaceId: context.workspaceId,
        ownerId: context.ownerId,
      },
      placeholderInstanceId,
      "http"
    );

    if (!insertResult.ok) {
      if (insertResult.existing.status === "running") {
        return {
          engineType: context.engineType,
          runtimeInstanceId: insertResult.existing.runtimeInstanceId,
          workspaceMountPath: context.placement.sandbox.mountTarget,
        };
      }
      throw new Error(
        `owner ${context.ownerId} has a concurrent launch already starting`
      );
    }

    const engineInput = this.buildSandboxStartInput(context);
    const resumeRuntimeInstanceId = ownerState.lastStoppedRuntimeInstanceId;
    ownerState.lastStoppedRuntimeInstanceId = undefined;

    try {
      return await withTimeout(
        this.createSandbox(context, engineInput, resumeRuntimeInstanceId),
        this.configService.getLaunchTimeoutSeconds() * 1000,
        `sandbox launch timed out for owner ${context.ownerId}`
      );
    } catch (err) {
      await this.registry
        .markErrorByOwner(
          context.placement.runtimeType,
          context.isolationScope,
          context.ownerId,
          err instanceof Error ? err.message : String(err)
        )
        .catch(
          swallow(this.logger, `mark launch error for owner ${context.ownerId}`)
        );
      throw err;
    }
  }
```

（`onRuntimeInstanceStarted`/`recordWorkspaceRuntime` 不需要改——它们已经调用 `registry.upsertRunning(...)`,`upsertRunning` 内部 `findFirst` + 更新的写法本来就会把 Task 1 插入的 starting 行原地覆盖成 running,不需要额外代码区分"从 starting 转 running"和"全新插入"这两种情况。`onRuntimeInstanceStartFailed` 也不需要改——`launchWithHandshake` 的 catch 块已经把 DB 行标记为 error 再往上抛,`onRuntimeInstanceStartFailed` 继续做它原来做的内存态清理即可。）

- [ ] **Step 10: 跑测试确认通过**

Run: `pnpm --filter api test -- sandbox-instance.executor`
Expected: PASS(含新增的 4 个用例;`vi.advanceTimersByTimeAsync` 那个超时用例要确认真的会等到 fake timer 推进后再断言,不要提前 await)。

- [ ] **Step 11: typecheck + lint**

Run: `pnpm --filter api typecheck && pnpm --filter api lint`
Expected: 零报错。

- [ ] **Step 12: Commit**

```bash
git add apps/api/src/common/with-timeout.ts apps/api/src/common/with-timeout.spec.ts apps/api/src/config apps/api/src/worker-host/sandbox/sandbox-instance.executor.ts apps/api/src/worker-host/sandbox/sandbox-instance.executor.spec.ts
git commit -m "feat(api): sandbox cold start writes starting row, reattaches across restarts, times out"
```

---

### Task 3: `LocalInstanceExecutor` 冷启动接入握手状态机(starting → running/error,冲突一律报错)

**Files:**
- Modify: `apps/api/src/worker-host/local/local-instance.executor.ts`
- Modify: `apps/api/src/worker-host/local/local-instance.executor.spec.ts`

**Interfaces:**
- Consumes: `WorkerRegistryRepository.insertStarting`(Task 1)。
- Produces: 无新公开接口——`acquireInstanceForRun` 的签名/返回类型不变,只是内部行为变化。

**为什么 local 不需要超时/不需要"冲突即复用"**:`runtimeService.launchLocal()` 是同步调用(`fork()` 立即返回),没有异步等待窗口可超时。冲突处理也跟 sandbox 不对称——local 走 IPC,父子进程关系一旦断了(重启)就没有"重连"这回事(设计文档 2.4 节、仍待讨论第 15 条),所以撞见任何冲突(不管已有行是 `starting` 还是 `running`)都直接报错,不尝试复用。副作用:这次改动顺带堵上了一个 Phase 3 就存在的真实竞态——`LocalInstanceExecutor.acquireInstanceForRun` 目前完全没有类似 `SandboxInstanceExecutor.pendingSandboxes` 的同进程并发去重,两个并发请求打到同一个全新 owner 会各自 fork 一个进程;`insertStarting` 的唯一索引会让后到的那个在 DB 层面被拒绝,不需要另外补内存态去重。

- [ ] **Step 1: 写 `LocalInstanceExecutor` 冷启动新行为的失败测试**

编辑 `apps/api/src/worker-host/local/local-instance.executor.spec.ts`。先把 `makeRegistry()` 补上新方法:

```ts
function makeRegistry() {
  return {
    findActiveByWorkspace: vi.fn().mockResolvedValue(null),
    insertStarting: vi.fn().mockResolvedValue({ ok: true }),
    upsertRunning: vi.fn().mockResolvedValue({
      resource: { id: "rr-1" },
      workspaceRuntimeInstance: { id: "wr-1" },
    }),
    markStoppedByOwner: vi.fn().mockResolvedValue(undefined),
    markErrorByOwner: vi.fn().mockResolvedValue(undefined),
  };
}
```

在 `describe("acquireInstanceForRun", ...)` 块内,追加以下用例:

```ts
    it("writes a starting row before launching, then flips it to running", async () => {
      const { executor, registry } = makeExecutor();

      await executor.acquireInstanceForRun({
        runConfig: { runId: "run-1", workspaceId: "ws-1" } as never,
        runtimeTarget: { runtimeType: "local", ownerId: "ws-1", workspaceId: "ws-1" } as never,
      });

      expect(registry.insertStarting).toHaveBeenCalledWith(
        { runtimeType: "local", isolationScope: "workspace", workspaceId: "ws-1", ownerId: "ws-1" },
        expect.any(String),
        "ipc"
      );
      expect(registry.upsertRunning).toHaveBeenCalledWith(
        { runtimeType: "local", isolationScope: "workspace", workspaceId: "ws-1", ownerId: "ws-1" },
        "4242:token-1",
        "ipc"
      );
    });

    it("resolves error on insertStarting conflict without forking a process (local can never reattach across restarts)", async () => {
      const { executor, runtimeService, registry } = makeExecutor();
      registry.insertStarting.mockResolvedValueOnce({
        ok: false,
        existing: { runtimeInstanceId: "9999:stale-token", status: "running" },
      });

      const result = await executor.acquireInstanceForRun({
        runConfig: { runId: "run-1", workspaceId: "ws-1" } as never,
        runtimeTarget: { runtimeType: "local", ownerId: "ws-1", workspaceId: "ws-1" } as never,
      });

      expect(result.outcome).toBe("error");
      expect(runtimeService.launchLocal).not.toHaveBeenCalled();
    });

    it("marks the row as error when launchLocal throws synchronously", async () => {
      const runtimeService = makeRuntimeService();
      runtimeService.launchLocal.mockImplementation(() => {
        throw new Error("fork failed: EAGAIN");
      });
      const { executor, registry } = makeExecutor({ runtimeService });

      const result = await executor.acquireInstanceForRun({
        runConfig: { runId: "run-1", workspaceId: "ws-1" } as never,
        runtimeTarget: { runtimeType: "local", ownerId: "ws-1", workspaceId: "ws-1" } as never,
      });

      expect(result.outcome).toBe("error");
      expect(registry.markErrorByOwner).toHaveBeenCalledWith(
        "local",
        "workspace",
        "ws-1",
        expect.stringContaining("fork failed")
      );
    });
```

- [ ] **Step 2: 跑测试确认新用例失败**

Run: `pnpm --filter api test -- local-instance.executor`
Expected: FAIL(`registry.insertStarting` 未被调用等断言失败)。

- [ ] **Step 3: 实现——`acquireInstanceForRun` 接入握手状态机**

编辑 `apps/api/src/worker-host/local/local-instance.executor.ts`。

顶部 import 区新增:

```ts
import { generateId } from "@agework/shared";
```

把现有的:

```ts
  async acquireInstanceForRun(
    input: WorkerExecutionStartInput
  ): Promise<AcquireInstanceResult> {
    const ownerId = input.runtimeTarget.ownerId;
    const workspaceId = input.runConfig.workspaceId;
    const existing = this.ownerStates.get(ownerId);
    if (existing) {
      return {
        outcome: "ready",
        runtimeInstanceId: existing.runtimeInstanceId,
      };
    }

    const { runtimeInstanceId, channel } = this.runtimeService.launchLocal({
      runId: input.runConfig.runId,
      env: {
        AGEWORK_WORKER_KEEP_ALIVE: "true",
        AGEWORK_WORKER_CHANNEL: "ipc",
        ...(input.runConfig.workerLogFilePath
          ? { AGEWORK_WORKER_LOG_FILE: input.runConfig.workerLogFilePath }
          : {}),
      },
    });

    const state: LocalOwnerState = {
      runtimeInstanceId,
      channel,
      commandSeq: 0,
    };
    this.ownerStates.set(ownerId, state);
    this.attachChannelListeners(ownerId, channel);

    await this.registry
      .upsertRunning(
        {
          runtimeType: "local",
          isolationScope: "workspace",
          workspaceId,
          ownerId,
        },
        runtimeInstanceId,
        "ipc"
      )
      .catch(swallow(this.logger, `record local runtime for owner ${ownerId}`));

    this.logger.log(
      `local worker keep-alive started ${safeLogJson({ ownerId, pid: channel.pid })}`
    );
    return { outcome: "ready", runtimeInstanceId };
  }
```

替换为:

```ts
  async acquireInstanceForRun(
    input: WorkerExecutionStartInput
  ): Promise<AcquireInstanceResult> {
    const ownerId = input.runtimeTarget.ownerId;
    const workspaceId = input.runConfig.workspaceId;
    const existing = this.ownerStates.get(ownerId);
    if (existing) {
      return {
        outcome: "ready",
        runtimeInstanceId: existing.runtimeInstanceId,
      };
    }

    const insertResult = await this.registry.insertStarting(
      { runtimeType: "local", isolationScope: "workspace", workspaceId, ownerId },
      generateId(),
      "ipc"
    );
    if (!insertResult.ok) {
      // local 走 IPC,父子进程关系一旦断了就没有重连这回事(设计文档 2.4 节)。
      // 已有行不管是 starting 还是 running,都不能安全复用,统一报错。
      return {
        outcome: "error",
        error: `owner ${ownerId} already has an active local instance record (status=${insertResult.existing.status}); this process cannot reattach to it`,
      };
    }

    let launched: { runtimeInstanceId: string; channel: LocalOwnerState["channel"] };
    try {
      launched = this.runtimeService.launchLocal({
        runId: input.runConfig.runId,
        env: {
          AGEWORK_WORKER_KEEP_ALIVE: "true",
          AGEWORK_WORKER_CHANNEL: "ipc",
          ...(input.runConfig.workerLogFilePath
            ? { AGEWORK_WORKER_LOG_FILE: input.runConfig.workerLogFilePath }
            : {}),
        },
      });
    } catch (err) {
      await this.registry
        .markErrorByOwner(
          "local",
          "workspace",
          ownerId,
          err instanceof Error ? err.message : String(err)
        )
        .catch(swallow(this.logger, `mark launch error for owner ${ownerId}`));
      return {
        outcome: "error",
        error: `launch local worker failed: ${String(err)}`,
      };
    }

    const { runtimeInstanceId, channel } = launched;
    const state: LocalOwnerState = {
      runtimeInstanceId,
      channel,
      commandSeq: 0,
    };
    this.ownerStates.set(ownerId, state);
    this.attachChannelListeners(ownerId, channel);

    await this.registry
      .upsertRunning(
        {
          runtimeType: "local",
          isolationScope: "workspace",
          workspaceId,
          ownerId,
        },
        runtimeInstanceId,
        "ipc"
      )
      .catch(swallow(this.logger, `record local runtime for owner ${ownerId}`));

    this.logger.log(
      `local worker keep-alive started ${safeLogJson({ ownerId, pid: channel.pid })}`
    );
    return { outcome: "ready", runtimeInstanceId };
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter api test -- local-instance.executor`
Expected: PASS(含新增的 3 个用例 + 原有用例)。

- [ ] **Step 5: typecheck + lint**

Run: `pnpm --filter api typecheck && pnpm --filter api lint`
Expected: 零报错。

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/worker-host/local/local-instance.executor.ts apps/api/src/worker-host/local/local-instance.executor.spec.ts
git commit -m "feat(api): local cold start writes starting row, fails fast on any conflict"
```

---

### Task 4: 启动时扫尾——清空残留 starting 行,回收孤立的 local 进程

**Files:**
- Modify: `apps/api/src/worker-host/worker-host.service.ts`
- Modify: `apps/api/src/worker-host/worker-host.service.spec.ts`
- Modify: `apps/api/src/worker-host/lifecycle/lifecycle.service.ts`
- Modify: `apps/api/src/worker-host/lifecycle/lifecycle.service.spec.ts`

**Interfaces:**
- Consumes: `WorkerRegistryRepository.markAllStartingAsError`/`findRunningByRuntimeType`(Task 1),`LocalInstanceExecutor.recoverOrphan`(既有方法,本 task 是它在 Phase 5 里的新调用方——旧调用方在 Task 6 才会被删掉,这个顺序保证它任何时刻都至少有一个调用方,不会出现中间态的死代码)。
- Produces: `WorkerHostService.markAllStartingRuntimesAsError(): Promise<void>`、`WorkerHostService.findRunningRuntimesByType(runtimeType: string)`。`RuntimeInstanceLifecycleService` 新增 `OnApplicationBootstrap` 钩子。

- [ ] **Step 1: `WorkerHostService` 新增两个透传方法**

编辑 `apps/api/src/worker-host/worker-host.service.ts`,在 `findRuntimeBindingWithResource` 方法之后新增:

```ts
  /** 服务重启后的扫尾用:把所有卡在 starting 的行标记为 error(仍待讨论第 13 条)。 */
  markAllStartingRuntimesAsError() {
    return this.registry.markAllStartingAsError();
  }

  /** 按 runtimeType 查找所有 running 状态的行,供重启扫尾用。 */
  findRunningRuntimesByType(runtimeType: string) {
    return this.registry.findRunningByRuntimeType(runtimeType);
  }
```

- [ ] **Step 2: 给这两个透传方法写测试**

在文件末尾(最后一个 `describe` 块之后)新增一个自成一体的 describe 块,风格对齐既有的 `"WorkerHostService sandbox instance orchestration"`/`"WorkerHostService local instance orchestration"` 块(各自 new 一个只填自己需要的构造参数的 `WorkerHostService` 实例,不复用顶层 `makeService()`——那个顶层 helper 把 `registry` 构造成 `{} as unknown as WorkerRegistryRepository`,不适合断言 registry 调用):

```ts
describe("WorkerHostService — restart sweep queries", () => {
  function makeService() {
    const registry = {
      markAllStartingAsError: vi.fn().mockResolvedValue(undefined),
      findRunningByRuntimeType: vi.fn().mockResolvedValue([]),
    };
    const service = new WorkerHostService(
      {} as never,
      {} as never,
      {} as never,
      registry as never,
      {} as never,
      {} as never,
      {} as never
    );
    return { service, registry };
  }

  it("routes markAllStartingRuntimesAsError to the registry", async () => {
    const { service, registry } = makeService();

    await service.markAllStartingRuntimesAsError();

    expect(registry.markAllStartingAsError).toHaveBeenCalled();
  });

  it("routes findRunningRuntimesByType to the registry", async () => {
    const { service, registry } = makeService();

    await service.findRunningRuntimesByType("local");

    expect(registry.findRunningByRuntimeType).toHaveBeenCalledWith("local");
  });
});
```

（构造函数参数顺序对齐 `WorkerHostService` 现有构造函数——`endpointHandler, upstream, commandDispatcher, registry, runtimeService, sandboxInstances, localInstances` 七个参数,这里只需要真实填第四个 `registry`,其余用 `{} as never` 占位,跟文件里其它 describe 块的写法一致。）

- [ ] **Step 3: 跑测试确认通过**

Run: `pnpm --filter api test -- worker-host.service`
Expected: PASS。

- [ ] **Step 4: 写 `RuntimeInstanceLifecycleService` 启动扫尾的失败测试**

编辑 `apps/api/src/worker-host/lifecycle/lifecycle.service.spec.ts`。把 `makeWorkerHost()` 补上新方法:

```ts
function makeWorkerHost(overrides: Record<string, unknown> = {}) {
  return {
    findRuntimeBindingWithResource: vi.fn().mockResolvedValue(null),
    deleteRuntimeWorkspaceBinding: vi.fn().mockResolvedValue(undefined),
    findWorkspaceIdsByUser: vi.fn().mockResolvedValue([]),
    findRunningRuntimesByOwners: vi.fn().mockResolvedValue([]),
    markRuntimeStoppedById: vi.fn().mockResolvedValue(undefined),
    markAllStartingRuntimesAsError: vi.fn().mockResolvedValue(undefined),
    findRunningRuntimesByType: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}
```

在文件末尾追加:

```ts
describe("onApplicationBootstrap", () => {
  it("marks all starting rows as error, then recovers orphaned local rows", async () => {
    const workerHost = makeWorkerHost({
      findRunningRuntimesByType: vi.fn().mockResolvedValue([
        { id: "rr-1", runtimeType: "local", isolationScope: "workspace", ownerId: "ws-1", runtimeInstanceId: "4242:token" },
        { id: "rr-2", runtimeType: "local", isolationScope: "workspace", ownerId: "ws-2", runtimeInstanceId: "5555:token" },
      ]),
    });
    const sandboxInstances = makeSandboxInstances();
    const localInstances = makeLocalInstances({ recoverOrphan: vi.fn().mockResolvedValue(undefined) });
    const service = new RuntimeInstanceLifecycleService(
      workerHost as never,
      sandboxInstances as never,
      localInstances as never
    );

    await service.onApplicationBootstrap();

    expect(workerHost.markAllStartingRuntimesAsError).toHaveBeenCalledTimes(1);
    expect(workerHost.findRunningRuntimesByType).toHaveBeenCalledWith("local");
    expect(localInstances.recoverOrphan).toHaveBeenCalledWith("4242:token");
    expect(localInstances.recoverOrphan).toHaveBeenCalledWith("5555:token");
    expect(workerHost.markRuntimeStoppedById).toHaveBeenCalledWith(
      expect.objectContaining({ id: "rr-1" }),
      "interrupted_by_restart"
    );
    expect(workerHost.markRuntimeStoppedById).toHaveBeenCalledWith(
      expect.objectContaining({ id: "rr-2" }),
      "interrupted_by_restart"
    );
  });

  it("does not touch running sandbox rows (containers survive an API restart)", async () => {
    const workerHost = makeWorkerHost();
    const sandboxInstances = makeSandboxInstances();
    const localInstances = makeLocalInstances();
    const service = new RuntimeInstanceLifecycleService(
      workerHost as never,
      sandboxInstances as never,
      localInstances as never
    );

    await service.onApplicationBootstrap();

    expect(workerHost.findRunningRuntimesByType).toHaveBeenCalledWith("local");
    expect(workerHost.findRunningRuntimesByType).not.toHaveBeenCalledWith(
      "sandbox"
    );
  });

  it("logs a warning and continues when recovering one orphaned local row throws", async () => {
    const workerHost = makeWorkerHost({
      findRunningRuntimesByType: vi.fn().mockResolvedValue([
        { id: "rr-1", runtimeType: "local", isolationScope: "workspace", ownerId: "ws-1", runtimeInstanceId: "4242:token" },
        { id: "rr-2", runtimeType: "local", isolationScope: "workspace", ownerId: "ws-2", runtimeInstanceId: "5555:token" },
      ]),
    });
    const sandboxInstances = makeSandboxInstances();
    const recoverOrphan = vi
      .fn()
      .mockRejectedValueOnce(new Error("ESRCH"))
      .mockResolvedValueOnce(undefined);
    const localInstances = makeLocalInstances({ recoverOrphan });
    const service = new RuntimeInstanceLifecycleService(
      workerHost as never,
      sandboxInstances as never,
      localInstances as never
    );

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(recoverOrphan).toHaveBeenCalledTimes(2);
    expect(workerHost.markRuntimeStoppedById).toHaveBeenCalledTimes(2);
  });
});
```

也把 `makeLocalInstances()` 辅助函数补上 `recoverOrphan`:

```ts
function makeLocalInstances(overrides: Record<string, unknown> = {}) {
  return {
    shutdownRuntimeInstanceByOwnerId: vi.fn(),
    recoverOrphan: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}
```

- [ ] **Step 5: 跑测试确认失败**

Run: `pnpm --filter api test -- lifecycle.service`
Expected: FAIL(`service.onApplicationBootstrap is not a function`)。

- [ ] **Step 6: 实现 `onApplicationBootstrap`**

编辑 `apps/api/src/worker-host/lifecycle/lifecycle.service.ts`。

顶部 import 改成:

```ts
import { Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import { WorkerHostService } from "../worker-host.service";
import { SandboxInstanceExecutor } from "../sandbox/sandbox-instance.executor";
import { LocalInstanceExecutor } from "../local/local-instance.executor";
import { swallow } from "../../common/swallow";
```

class 声明改成:

```ts
export class RuntimeInstanceLifecycleService implements OnApplicationBootstrap {
```

在 `shutdownForUser` 方法之后、`shutdownResource` 私有方法之前,新增:

```ts
  /**
   * 服务重启后的扫尾:(1) 清空所有卡在 starting 的行——这些行代表上一个
   * (已经不在了的)进程没来得及确认完成的启动尝试,不清空会让并发防重
   * 唯一索引把对应 owner 永久卡死(仍待讨论第 13 条)。(2) 回收残留的
   * local running 行——local 走 IPC,父子进程关系随 API 进程重启必然断,
   * 不存在"重连"这回事(设计文档 2.4 节),物理杀掉可能还在跑的孤儿进程
   * 并把行标记为 stopped。sandbox 的 running 行不在这次扫尾范围内:容器
   * 是独立进程,大概率在 API 重启后还活着,盲目清空会把仍在正常工作的
   * 容器错误标记为已停止(Phase 1 移除的 blanket 清理正是这个教训)。
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.workerHost.markAllStartingRuntimesAsError();

    const staleLocalRows = await this.workerHost.findRunningRuntimesByType("local");
    for (const row of staleLocalRows) {
      try {
        await this.localInstances.recoverOrphan(row.runtimeInstanceId);
      } catch (err) {
        this.logger.warn(
          `Failed to recover orphaned local instance ${row.runtimeInstanceId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      await this.workerHost
        .markRuntimeStoppedById(row, "interrupted_by_restart")
        .catch(
          swallow(this.logger, `mark stopped for orphaned local row ${row.id}`)
        );
    }
  }
```

- [ ] **Step 7: 跑测试确认通过**

Run: `pnpm --filter api test -- lifecycle.service`
Expected: PASS(含新增的 3 个用例 + 原有用例)。

- [ ] **Step 8: typecheck + lint**

Run: `pnpm --filter api typecheck && pnpm --filter api lint`
Expected: 零报错。

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/worker-host/worker-host.service.ts apps/api/src/worker-host/worker-host.service.spec.ts apps/api/src/worker-host/lifecycle/lifecycle.service.ts apps/api/src/worker-host/lifecycle/lifecycle.service.spec.ts
git commit -m "feat(api): sweep stale starting rows and orphaned local instances on API boot"
```

---

### Task 5: `RunRecoveryService` 改发 cancel 命令,不再物理拆实例(仍待讨论第 12 条)

**Files:**
- Modify: `apps/api/src/run/recovery/run-recovery.service.ts`
- Modify: `apps/api/src/run/recovery/run-recovery.service.spec.ts`

**Interfaces:**
- Consumes: `WorkerHostService.findRuntimeByRuntimeId(runtimeType, runtimeInstanceId)`(既有方法,不变)、`WorkerHostService.sendCommand(ownerId, runId, command)`(既有方法,不变)。
- Produces: `RunRecoveryService` 的构造函数从四个依赖收窄成三个(`RunRepository`、`ConversationService`、`WorkerHostService`)——`ExecutionService` 不再被这个类使用,整个删掉(不是保留一个不用的字段);`ExecutionService.cleanupInterruptedExecution`/`WorkerHostService.isRuntimeInstanceUserScoped` 这两个方法在 Task 6 会被确认没有其他调用方后删除。

- [ ] **Step 1: 写新行为的失败测试**

把 `apps/api/src/run/recovery/run-recovery.service.spec.ts` 整个文件替换为:

```ts
import { describe, it, expect, vi } from "vitest";
import { RunRecoveryService } from "./run-recovery.service";
import { RunRepository } from "../run.repository";
import { ConversationService } from "../../conversation/conversation.service";
import { WorkerHostService } from "../../worker-host/worker-host.service";

function makeWorkerHost(
  overrides: Record<string, unknown> = {}
): Partial<WorkerHostService> {
  return {
    findRuntimeByRuntimeId: vi.fn().mockResolvedValue(null),
    sendCommand: vi.fn(),
    ...overrides,
  };
}

describe("RunRecoveryService.recoverInterruptedRuns", () => {
  it("sends a cancel command to the bound instance instead of tearing it down", async () => {
    const mockRunRepository: Partial<RunRepository> = {
      findAllActive: vi.fn().mockResolvedValue([
        {
          id: "run-1",
          conversationId: "conversation-1",
          runtimeType: "sandbox",
          runtimeInstanceId: "container-abc",
        },
      ]),
      markError: vi.fn().mockResolvedValue(undefined),
    };
    const mockConversations: Partial<ConversationService> = {
      setRunStatus: vi.fn().mockResolvedValue(undefined),
    };
    const workerHost = makeWorkerHost({
      findRuntimeByRuntimeId: vi.fn().mockResolvedValue({ ownerId: "ws-1" }),
    });

    const service = new RunRecoveryService(
      mockRunRepository as RunRepository,
      mockConversations as ConversationService,
      workerHost as WorkerHostService
    );

    await service.recoverInterruptedRuns();

    expect(workerHost.findRuntimeByRuntimeId).toHaveBeenCalledWith(
      "sandbox",
      "container-abc"
    );
    expect(workerHost.sendCommand).toHaveBeenCalledWith(
      "ws-1",
      "run-1",
      expect.objectContaining({
        type: "cancel",
        runId: "run-1",
        conversationId: "conversation-1",
      })
    );
    expect(mockRunRepository.markError).toHaveBeenCalledWith(
      "run-1",
      "服务重启导致运行中断"
    );
    expect(mockConversations.setRunStatus).toHaveBeenCalledWith(
      "conversation-1",
      "error"
    );
  });

  it("skips sending a cancel command when a run has no persisted runtimeInstanceId", async () => {
    const mockRunRepository: Partial<RunRepository> = {
      findAllActive: vi.fn().mockResolvedValue([
        {
          id: "run-1",
          conversationId: "conversation-1",
          runtimeType: "local",
          runtimeInstanceId: null,
        },
      ]),
      markError: vi.fn().mockResolvedValue(undefined),
    };
    const mockConversations: Partial<ConversationService> = {
      setRunStatus: vi.fn().mockResolvedValue(undefined),
    };
    const workerHost = makeWorkerHost();

    const service = new RunRecoveryService(
      mockRunRepository as RunRepository,
      mockConversations as ConversationService,
      workerHost as WorkerHostService
    );

    await service.recoverInterruptedRuns();

    expect(workerHost.findRuntimeByRuntimeId).not.toHaveBeenCalled();
    expect(workerHost.sendCommand).not.toHaveBeenCalled();
    expect(mockRunRepository.markError).toHaveBeenCalledWith(
      "run-1",
      "服务重启导致运行中断"
    );
  });

  it("skips sending a cancel command when no WorkerRegistry row is found for the instance", async () => {
    const mockRunRepository: Partial<RunRepository> = {
      findAllActive: vi.fn().mockResolvedValue([
        {
          id: "run-1",
          conversationId: "conversation-1",
          runtimeType: "local",
          runtimeInstanceId: "4242:token",
        },
      ]),
      markError: vi.fn().mockResolvedValue(undefined),
    };
    const mockConversations: Partial<ConversationService> = {
      setRunStatus: vi.fn().mockResolvedValue(undefined),
    };
    const workerHost = makeWorkerHost({
      findRuntimeByRuntimeId: vi.fn().mockResolvedValue(null),
    });

    const service = new RunRecoveryService(
      mockRunRepository as RunRepository,
      mockConversations as ConversationService,
      workerHost as WorkerHostService
    );

    await service.recoverInterruptedRuns();

    expect(workerHost.sendCommand).not.toHaveBeenCalled();
    expect(mockRunRepository.markError).toHaveBeenCalledWith(
      "run-1",
      "服务重启导致运行中断"
    );
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter api test -- run-recovery.service`
Expected: FAIL(现有实现还在调 `isRuntimeInstanceUserScoped`/`cleanupInterruptedExecution`,新断言全部落空)。

- [ ] **Step 3: 重写 `RunRecoveryService`**

把 `apps/api/src/run/recovery/run-recovery.service.ts` 整个文件替换为:

```ts
import { Injectable, Logger } from "@nestjs/common";
import { generateId } from "@agework/shared";
import { RunRepository } from "../run.repository";
import { WorkerHostService } from "../../worker-host/worker-host.service";
import { ConversationService } from "../../conversation/conversation.service";
import { swallow } from "../../common/swallow";

/**
 * 服务重启后恢复中断 run:找到所有仍处于 active 状态的 run,向它绑定的
 * runtime 实例(如果 WorkerRegistry 里还找得到)发一条 cancel 命令让 Worker
 * 自己收尾,不碰实例本身的生死——这个 run 中断不代表实例本身有问题,可能还在
 * 正常服务其它 run(仍待讨论第 12 条)。实例已经不在了,这条命令发出去没人
 * 收,无副作用。随后统一把 run/thread 状态标记为 error。
 */
@Injectable()
export class RunRecoveryService {
  private readonly logger = new Logger(RunRecoveryService.name);

  constructor(
    private readonly runRepository: RunRepository,
    private readonly conversations: ConversationService,
    private readonly workerHost: WorkerHostService
  ) {}

  async recoverInterruptedRuns(): Promise<void> {
    try {
      const activeRuns = await this.runRepository.findAllActive();
      if (activeRuns.length === 0) {
        this.logger.log("No interrupted active runs found.");
      } else {
        this.logger.warn(
          `Found ${activeRuns.length} interrupted active run(s) — marking as error`
        );

        for (const run of activeRuns) {
          if (run.runtimeInstanceId) {
            await this.sendCancelToBoundInstance(run).catch(
              swallow(this.logger, `send cancel for interrupted run ${run.id}`)
            );
          }

          await this.runRepository.markError(run.id, "服务重启导致运行中断");
          await this.conversations
            .setRunStatus(run.conversationId, "error")
            .catch(
              swallow(
                this.logger,
                `set conversation active run status to error for run ${run.id}`
              )
            );

          this.logger.log(`Marked interrupted run ${run.id} as error`);
        }
      }
    } catch (err) {
      this.logger.error(
        `Failed to cleanup interrupted runs: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async sendCancelToBoundInstance(run: {
    id: string;
    conversationId: string;
    runtimeType: string;
    runtimeInstanceId: string | null;
  }): Promise<void> {
    if (!run.runtimeInstanceId) return;
    const resource = await this.workerHost.findRuntimeByRuntimeId(
      run.runtimeType,
      run.runtimeInstanceId
    );
    if (!resource) return;

    this.workerHost.sendCommand(resource.ownerId, run.id, {
      type: "cancel",
      commandId: generateId(),
      runId: run.id,
      conversationId: run.conversationId,
    });
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter api test -- run-recovery.service`
Expected: PASS(3 个用例)。

- [ ] **Step 5: typecheck + lint**

Run: `pnpm --filter api typecheck && pnpm --filter api lint`
Expected: 零报错。

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/run/recovery/run-recovery.service.ts apps/api/src/run/recovery/run-recovery.service.spec.ts
git commit -m "refactor(api): restart recovery sends cancel command instead of tearing down instances"
```

---

### Task 6: 删除死代码——旧的物理拆除链路(仍待讨论第 12 条收尾)

**为什么放最后**:Task 5 已经让 `RunRecoveryService` 不再调用 `ExecutionService.cleanupInterruptedExecution`;Task 4 已经让 `LocalInstanceExecutor.recoverOrphan` 有了新的调用方(启动扫尾)。到这一步,`ExecutionService.cleanupInterruptedExecution → WorkerRunExecutor.cleanupInterruptedExecution → WorkerHostService.recoverOrphanInstance → {SandboxInstanceExecutor,LocalInstanceExecutor}.recoverOrphan → RuntimeService.{recoverOrphanSandbox,recoverOrphanLocal} → engine/provider.recoverOrphan` 这条链路里,sandbox 那一半彻底没有调用方了,local 那一半的调用方已经换成 Task 4 新增的扫尾逻辑(不再经过 `WorkerHostService.recoverOrphanInstance`)。这是跟 Phase 4 Task 3 同样性质的"翻转"任务——先删、再核实、再跑全量测试。

**Files:**
- Modify: `apps/api/src/run/execution/executor.ts`(接口去掉 `cleanupInterruptedExecution?`)
- Modify: `apps/api/src/run/execution/worker-run.executor.ts` + spec(删除 `cleanupInterruptedExecution` 方法)
- Modify: `apps/api/src/run/execution/execution.service.ts` + spec(删除 `cleanupInterruptedExecution` 方法)
- Modify: `apps/api/src/worker-host/worker-host.service.ts` + spec(删除 `recoverOrphanInstance`、`isRuntimeInstanceUserScoped`)
- Modify: `apps/api/src/worker-host/sandbox/sandbox-instance.executor.ts` + spec(删除 `recoverOrphan` 方法)
- Modify: `apps/api/src/runtime/runtime.service.ts` + spec(删除 `recoverOrphanSandbox` 方法)
- Modify: `apps/api/src/runtime/sandbox/sandbox-engine.ts`(接口去掉 `recoverOrphan`)
- Modify: `apps/api/src/runtime/sandbox/docker-engine.ts` + spec(删除 `recoverOrphan` 方法)
- Modify: `apps/api/src/runtime/sandbox/opensandbox-engine.ts`(删除 `recoverOrphan` 方法)

- [ ] **Step 1: 逐个 grep 核实调用方,确认可以安全删除**

```bash
grep -rn "cleanupInterruptedExecution" apps/api/src --include="*.ts" | grep -v ".spec.ts"
grep -rn "recoverOrphanInstance\b" apps/api/src --include="*.ts" | grep -v ".spec.ts"
grep -rn "isRuntimeInstanceUserScoped" apps/api/src --include="*.ts" | grep -v ".spec.ts"
grep -rn "\.recoverOrphan\b" apps/api/src/worker-host/sandbox --include="*.ts" | grep -v ".spec.ts"
grep -rn "recoverOrphanSandbox\b" apps/api/src --include="*.ts" | grep -v ".spec.ts"
grep -rn "\brecoverOrphan\(" apps/api/src/runtime --include="*.ts" | grep -v ".spec.ts"
```

预期(如果实际结果跟这里列的不一致,说明代码库状态跟计划假设的不一样,停下来,不要凭空猜测该不该删):
- `cleanupInterruptedExecution` 只出现在 `executor.ts`(接口声明)、`execution.service.ts`(实现)、`worker-run.executor.ts`(实现)三处——Task 5 之后 `run-recovery.service.ts` 里不应该再有它。
- `recoverOrphanInstance` 只出现在 `worker-host.service.ts`(定义)、`worker-run.executor.ts`(调用)两处。
- `isRuntimeInstanceUserScoped` 只出现在 `worker-host.service.ts`(定义)一处——Task 5 之后 `run-recovery.service.ts` 里不应该再有它。
- `SandboxInstanceExecutor.recoverOrphan` 只出现在 `sandbox-instance.executor.ts`(定义)、`worker-host.service.ts`(调用,在 `recoverOrphanInstance` 内部)两处。
- `recoverOrphanSandbox` 只出现在 `runtime.service.ts`(定义)、`sandbox-instance.executor.ts`(调用)两处。
- `runtime/` 下的 `recoverOrphan` 只出现在 `sandbox-engine.ts`(接口)、`docker-engine.ts`(实现)、`opensandbox-engine.ts`(实现)、`runtime.service.ts`(循环调用每个 engine)——**不**包括 `local-runtime.provider.ts`(那个要保留,`RuntimeService.recoverOrphanLocal` 还在用)。

- [ ] **Step 2: 删除 `RunExecutor` 接口的 `cleanupInterruptedExecution?`**

编辑 `apps/api/src/run/execution/executor.ts`,删除:

```ts
  /** 服务重启后清理中断执行的残留（如 local worker pid / sandbox runtime resource）。 */
  cleanupInterruptedExecution?(
    runtimeType: string,
    runtimeInstanceId: string
  ): Promise<void>;
```

- [ ] **Step 3: 删除 `WorkerRunExecutor.cleanupInterruptedExecution`**

编辑 `apps/api/src/run/execution/worker-run.executor.ts`,删除:

```ts
  cleanupInterruptedExecution(
    runtimeType: string,
    runtimeInstanceId: string
  ): Promise<void> {
    return this.workerHost.recoverOrphanInstance(runtimeType, runtimeInstanceId);
  }
```

编辑 `apps/api/src/run/execution/worker-run.executor.spec.ts`,删除测试用例 `"cleanupInterruptedExecution forwards runtimeType and runtimeInstanceId to recoverOrphanInstance"`(在 `describe.each(["local", "sandbox"] as const)` 块内),以及 `makeWorkerHost()` 辅助函数里的 `recoverOrphanInstance: vi.fn(),` 那一行(如果删除后没有其它用例再引用它)。

- [ ] **Step 4: 删除 `ExecutionService.cleanupInterruptedExecution`**

编辑 `apps/api/src/run/execution/execution.service.ts`,删除:

```ts
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
```

编辑 `apps/api/src/run/execution/execution.service.spec.ts`,删除测试用例 `"forwards cleanupInterruptedExecution with runtimeType and runtimeInstanceId"`,以及 `makeExecutor()` 辅助函数里的 `cleanupInterruptedExecution: vi.fn(),` 那一行。

- [ ] **Step 5: 删除 `WorkerHostService.recoverOrphanInstance` 与 `isRuntimeInstanceUserScoped`**

编辑 `apps/api/src/worker-host/worker-host.service.ts`,删除:

```ts
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
```

以及:

```ts
  /** 该 runtime instance 是否为 user 级共享隔离(决定中断 run 是否可清理底层资源)。 */
  async isRuntimeInstanceUserScoped(
    runtimeType: string,
    runtimeInstanceId: string
  ): Promise<boolean> {
    const resource = await this.findRuntimeByRuntimeId(
      runtimeType,
      runtimeInstanceId
    );
    return resource?.isolationScope === "user";
  }
```

编辑 `apps/api/src/worker-host/worker-host.service.spec.ts`,删除对应的两组测试用例(`resolveInstance dispatches...` describe 块内没有它们,应该分别在独立的 `it` 里——搜索 `recoverOrphanInstance`/`isRuntimeInstanceUserScoped` 定位并删除)。

- [ ] **Step 6: 删除 `SandboxInstanceExecutor.recoverOrphan`**

编辑 `apps/api/src/worker-host/sandbox/sandbox-instance.executor.ts`,删除:

```ts
  /** 服务重启后清理中断执行残留的 sandbox runtime 实例。 */
  recoverOrphan(runtimeInstanceId: string): Promise<void> {
    return this.runtimeService.recoverOrphanSandbox(runtimeInstanceId);
  }
```

编辑 `apps/api/src/worker-host/sandbox/sandbox-instance.executor.spec.ts`,删除测试用例 `"delegates orphan recovery to RuntimeService.recoverOrphanSandbox"`,以及 `makeRuntimeService()` 辅助函数里的 `recoverOrphanSandbox: vi.fn().mockResolvedValue(undefined),` 那一行(如果删除后没有其它用例再引用它)。

- [ ] **Step 7: 删除 `RuntimeService.recoverOrphanSandbox`**

编辑 `apps/api/src/runtime/runtime.service.ts`,删除:

```ts
  async recoverOrphanSandbox(runtimeInstanceId: string): Promise<void> {
    for (const engine of this.sandboxEngines.values()) {
      await engine
        .recoverOrphan(runtimeInstanceId)
        .catch(
          swallow(this.logger, `recover orphan via ${engine.type} engine`)
        );
    }
  }
```

如果 `swallow`/`this.logger` 在删除这个方法后不再被其它方法使用,保留 import(其它方法多半还在用,不用特意检查——只有在 typecheck/lint 真的报未使用时才删对应 import,不要提前猜)。

编辑对应的 `apps/api/src/runtime/runtime.service.spec.ts`,删除引用 `recoverOrphanSandbox` 的测试用例。

- [ ] **Step 8: 从 `SandboxEngine` 接口删除 `recoverOrphan`,删除两个引擎实现**

编辑 `apps/api/src/runtime/sandbox/sandbox-engine.ts`,删除接口里的:

```ts
  recoverOrphan(runtimeInstanceId: string): Promise<void>;
```

编辑 `apps/api/src/runtime/sandbox/docker-engine.ts`,删除:

```ts
  async recoverOrphan(runtimeInstanceId: string): Promise<void> {
    try {
      await this.dockerStop(runtimeInstanceId);
    } catch {
      await this.dockerKill(runtimeInstanceId).catch(
        swallow(
          this.logger,
          `recover orphan: docker kill ${runtimeInstanceId.slice(0, 12)}`
        )
      );
    }
  }
```

（`dockerStop`/`dockerKill` 私有方法本身如果还被 `stop()` 等其它方法使用则保留,不要连带删除——先 grep 确认。）

编辑 `apps/api/src/runtime/sandbox/opensandbox-engine.ts`,删除:

```ts
  async recoverOrphan(runtimeInstanceId: string): Promise<void> {
    this.sandboxes.delete(runtimeInstanceId);
    await this.client.deleteSandbox(runtimeInstanceId);
  }
```

编辑对应的 `apps/api/src/runtime/sandbox/docker-engine.spec.ts`(如果存在引用 `recoverOrphan` 的用例,删除)。`opensandbox-engine.ts` 目前没有 `.spec.ts`(如果 Task 执行时发现有,同样处理)。

- [ ] **Step 9: 跑全量测试 + typecheck + lint**

Run: `pnpm --filter api test`
Expected: 全部通过。

Run: `pnpm --filter api typecheck`
Expected: 零报错。

Run: `pnpm --filter api lint`
Expected: 零报错。

- [ ] **Step 10: 二次 grep 确认没有遗留引用**

```bash
grep -rn "cleanupInterruptedExecution\|recoverOrphanInstance\|isRuntimeInstanceUserScoped\|recoverOrphanSandbox" apps/api/src --include="*.ts"
```

Expected: 零匹配(生产代码和测试代码都不应该再提到这几个名字)。

```bash
grep -rn "recoverOrphan" apps/api/src --include="*.ts" | grep -v ".spec.ts"
```

Expected: 只剩 `local-instance.executor.ts`(定义 + 供 Task 4 扫尾调用)、`runtime.service.ts` 的 `recoverOrphanLocal`、`local-runtime.provider.ts` 的 `recoverOrphan` 三处——这条链路是本轮保留、不删的那一半。

- [ ] **Step 11: Commit**

```bash
git add apps/api/src/run/execution apps/api/src/worker-host/worker-host.service.ts apps/api/src/worker-host/worker-host.service.spec.ts apps/api/src/worker-host/sandbox apps/api/src/runtime
git commit -m "refactor(api): remove dead physical-teardown chain superseded by cancel-command recovery"
```

---

## 完成后校验

- [ ] `pnpm --filter api typecheck && pnpm --filter api lint && pnpm --filter api test` 全绿。
- [ ] `grep -rn '"starting"' apps/api/src/worker-host` 能找到真实的写入路径(`insertStarting`),不再只是 migration 注释里的孤立提及。
- [ ] `RunRecoveryService` 不再注入/调用任何物理拆除方法,只经 `WorkerHostService.sendCommand` 下发 `cancel`。
- [ ] `apps/api/src/worker-host/lifecycle/lifecycle.service.ts` 实现 `OnApplicationBootstrap`,扫尾逻辑分两步:全量清 `starting`、只回收 local 的 `running`。
- [ ] sandbox 冷启动路径在 `insertStarting` 撞见 `running` 冲突时会复用现有行,不重复创建容器。
- [ ] `apps/api/src/runtime/sandbox/sandbox-engine.ts`/`docker-engine.ts`/`opensandbox-engine.ts` 不再有 `recoverOrphan`;`apps/api/src/runtime/local/local-runtime.provider.ts` 的 `recoverOrphan` 保留且仍被调用。
