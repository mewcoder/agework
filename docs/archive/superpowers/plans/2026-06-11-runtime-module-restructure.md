# Runtime 模块重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `runs/` 和 `runtime/` 合并为单一 `runtime/` 模块，按 domain/providers/internal-api 分层，拆分 RunService 职责，抽取 RunLauncherService，消除循环依赖。

**Architecture:** 单向依赖 `agent/` → `runtime/` → `threads/`，不再有 forwardRef。`runtime/` 是系统中唯一理解 worker 生命周期的模块，`agent/` 通过 `RunLauncherService` 门面交互。

**Tech Stack:** NestJS 11, Vitest, TypeScript

---

## File Structure

### 新建文件
| 文件 | 职责 |
|---|---|
| `runtime/domain/run.service.ts` | Run 表 CRUD（从 `runs/run.service.ts` 迁移，去掉 runConfigRegistry） |
| `runtime/domain/run.service.spec.ts` | RunService 测试（迁移，去掉 runConfigRegistry 用例） |
| `runtime/domain/run-registry.service.ts` | 内存 handle 注册表（从 `runs/run-registry.service.ts` 迁移） |
| `runtime/domain/run-registry.service.spec.ts` | 迁移 |
| `runtime/domain/run-event-bus.service.ts` | 上行事件处理（从 `runs/run-event-bus.service.ts` 迁移） |
| `runtime/domain/run-event-bus.service.spec.ts` | 迁移，import 路径调整 |
| `runtime/providers/run-config-store.service.ts` | **新增**：内存 RunConfig 暂存（从 RunService 拆出） |
| `runtime/providers/run-config-store.service.spec.ts` | **新增**：RunConfigStore 测试 |
| `runtime/providers/local-process-provider.service.ts` | 从 `runs/local-process-provider.service.ts` 迁移 |
| `runtime/providers/local-process-provider.service.spec.ts` | 迁移，import 路径调整 |
| `runtime/providers/docker-provider.service.ts` | 从 `runs/docker-provider.service.ts` 迁移，改用 RunConfigStore |
| `runtime/providers/runtime-provider.registry.ts` | 从 `runs/runtime-provider-registry.service.ts` 迁移 |
| `runtime/providers/runtime-provider.registry.spec.ts` | 迁移，import 路径调整 |
| `runtime/providers/provider-helpers.ts` | 从 `runs/runtime-provider-helpers.ts` 迁移 |
| `runtime/internal-api/runtime.controller.ts` | 从 `runtime/runtime.controller.ts` 迁移，改用 RunConfigStore |
| `runtime/internal-api/runtime-auth.guard.ts` | 从 `runtime/runtime-auth.guard.ts` 迁移 |
| `runtime/internal-api/runtime-token.service.ts` | 从 `runtime/runtime-token.service.ts` 迁移 |
| `runtime/internal-api/runtime-token.service.spec.ts` | 迁移 |
| `runtime/internal-api/control-queue.service.ts` | 从 `runtime/control-queue.service.ts` 迁移 |
| `runtime/internal-api/control-queue.service.spec.ts` | 迁移 |
| `runtime/run.controller.ts` | 从 `runs/run.controller.ts` 迁移 |
| `runtime/run-launcher.service.ts` | **新增**：运行编排门面（从 AgentController 抽取） |
| `runtime/run-launcher.service.spec.ts` | **新增**：RunLauncherService 测试 |
| `runtime/runtime.module.ts` | 合并原 `runs.module.ts` + `runtime.module.ts` |

### 修改文件
| 文件 | 变更 |
|---|---|
| `agent/agent.controller.ts` | 瘦身：删除 RunRegistry/RunEventBus/RuntimeProviderRegistry/RunService/ConfigService 直接依赖，改为调用 RunLauncherService |
| `agent/agent.module.ts` | imports 从 `RunsModule` 改为 `RuntimeModule` |
| `app.module.ts` | 移除 `RuntimeModule` 单独注册（已被 AgentModule 间接引入），确认无 RunsModule 残留引用 |

### 删除文件
| 文件 | 原因 |
|---|---|
| `runs/` 整个目录 | 全部迁移到 `runtime/` 子目录 |
| `runtime/runtime.module.ts`（旧） | 被 `runtime/runtime.module.ts`（新）替代 |
| `runtime/runtime.controller.ts`（旧） | 迁移到 `runtime/internal-api/` |
| `runtime/runtime-auth.guard.ts`（旧） | 迁移到 `runtime/internal-api/` |
| `runtime/runtime-token.service.ts`（旧） | 迁移到 `runtime/internal-api/` |
| `runtime/runtime-token.service.spec.ts`（旧） | 迁移到 `runtime/internal-api/` |
| `runtime/control-queue.service.ts`（旧） | 迁移到 `runtime/internal-api/` |
| `runtime/control-queue.service.spec.ts`（旧） | 迁移到 `runtime/internal-api/` |

---

### Task 1: 创建目录结构 + 迁移 domain 层文件

**Files:**
- Move: `runs/run.service.ts` → `runtime/domain/run.service.ts`
- Move: `runs/run.service.spec.ts` → `runtime/domain/run.service.spec.ts`
- Move: `runs/run-registry.service.ts` → `runtime/domain/run-registry.service.ts`
- Move: `runs/run-registry.service.spec.ts` → `runtime/domain/run-registry.service.spec.ts`
- Move: `runs/run-event-bus.service.ts` → `runtime/domain/run-event-bus.service.ts`
- Move: `runs/run-event-bus.service.spec.ts` → `runtime/domain/run-event-bus.service.spec.ts`

- [ ] **Step 1: 创建子目录并 git mv 文件**

```bash
cd apps/api/src
mkdir -p runtime/domain runtime/providers runtime/internal-api
git mv runs/run.service.ts runtime/domain/run.service.ts
git mv runs/run.service.spec.ts runtime/domain/run.service.spec.ts
git mv runs/run-registry.service.ts runtime/domain/run-registry.service.ts
git mv runs/run-registry.service.spec.ts runtime/domain/run-registry.service.spec.ts
git mv runs/run-event-bus.service.ts runtime/domain/run-event-bus.service.ts
git mv runs/run-event-bus.service.spec.ts runtime/domain/run-event-bus.service.spec.ts
```

- [ ] **Step 2: 修正 domain 层文件的 import 路径**

`runtime/domain/run.service.ts` — import 路径不变（只依赖 `@agework/protocol` 和 `../prisma/prisma.service`），无需修改。

`runtime/domain/run.service.spec.ts` — mock 路径需更新：

```ts
// 将
vi.mock("../prisma/prisma.service", ...
// 改为
vi.mock("../../prisma/prisma.service", ...
```

`runtime/domain/run-registry.service.ts` — import 不变（只依赖 `@agework/protocol` 和 `../agent/run-aggregator`）：

```ts
// 将
import type { RunAggregator } from "../agent/run-aggregator";
// 改为
import type { RunAggregator } from "../../agent/run-aggregator";
```

`runtime/domain/run-event-bus.service.ts` — 三个 import 需更新：

```ts
// 将
import { RunService } from "./run.service";
import { RunRegistry } from "./run-registry.service";
import { ThreadService } from "../threads/thread.service";
import type { RunAggregator } from "../agent/run-aggregator";
// 改为
import { RunService } from "./run.service";
import { RunRegistry } from "./run-registry.service";
import { ThreadService } from "../../threads/thread.service";
import type { RunAggregator } from "../../agent/run-aggregator";
```

`runtime/domain/run-event-bus.service.spec.ts` — import 路径更新：

```ts
// 将
import { RunEventBus } from "./run-event-bus.service";
import { RunService } from "./run.service";
import { RunRegistry } from "./run-registry.service";
import { ThreadService } from "../threads/thread.service";
import { RunAggregator } from "../agent/run-aggregator";
// 改为
import { RunEventBus } from "./run-event-bus.service";
import { RunService } from "./run.service";
import { RunRegistry } from "./run-registry.service";
import { ThreadService } from "../../threads/thread.service";
import { RunAggregator } from "../../agent/run-aggregator";
```

`runtime/domain/run-registry.service.spec.ts` — import 不变（`./run-registry.service` 仍在同目录）。

- [ ] **Step 3: 验证 domain 层编译通过**

```bash
pnpm typecheck
```

Expected: PASS（此时其他文件仍引用旧路径，可能有错误，但 domain 层自身应无错）

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "refactor: migrate domain layer files to runtime/domain/"
```

---

### Task 2: 迁移 providers 层文件

**Files:**
- Move: `runs/local-process-provider.service.ts` → `runtime/providers/local-process-provider.service.ts`
- Move: `runs/local-process-provider.service.spec.ts` → `runtime/providers/local-process-provider.service.spec.ts`
- Move: `runs/docker-provider.service.ts` → `runtime/providers/docker-provider.service.ts`
- Move: `runs/runtime-provider-registry.service.ts` → `runtime/providers/runtime-provider.registry.ts`
- Move: `runs/runtime-provider-registry.service.spec.ts` → `runtime/providers/runtime-provider.registry.spec.ts`
- Move: `runs/runtime-provider-helpers.ts` → `runtime/providers/provider-helpers.ts`

- [ ] **Step 1: git mv 文件**

```bash
cd apps/api/src
git mv runs/local-process-provider.service.ts runtime/providers/local-process-provider.service.ts
git mv runs/local-process-provider.service.spec.ts runtime/providers/local-process-provider.service.spec.ts
git mv runs/docker-provider.service.ts runtime/providers/docker-provider.service.ts
git mv runs/runtime-provider-registry.service.ts runtime/providers/runtime-provider.registry.ts
git mv runs/runtime-provider-registry.service.spec.ts runtime/providers/runtime-provider.registry.spec.ts
git mv runs/runtime-provider-helpers.ts runtime/providers/provider-helpers.ts
```

- [ ] **Step 2: 修正 providers 层文件的 import 路径**

`runtime/providers/local-process-provider.service.ts`：

```ts
// 将
import { RunEventBus } from "./run-event-bus.service";
import { HeartbeatWatchdog, nextControlEnvelope, publishWorkerErrorStatus } from "./runtime-provider-helpers";
// 改为
import { RunEventBus } from "../domain/run-event-bus.service";
import { HeartbeatWatchdog, nextControlEnvelope, publishWorkerErrorStatus } from "./provider-helpers";
```

`runtime/providers/local-process-provider.service.spec.ts`：

```ts
// 将
import { LocalProcessProvider } from "./local-process-provider.service";
import { RunEventBus } from "./run-event-bus.service";
// 改为
import { LocalProcessProvider } from "./local-process-provider.service";
import { RunEventBus } from "../domain/run-event-bus.service";
```

`runtime/providers/docker-provider.service.ts`：

```ts
// 将
import { RunEventBus } from "../runs/run-event-bus.service";
import { RunService } from "../runs/run.service";
import { RuntimeTokenService } from "../runtime/runtime-token.service";
import { ControlQueue } from "../runtime/control-queue.service";
import { HeartbeatWatchdog, nextControlEnvelope, publishWorkerErrorStatus } from "./runtime-provider-helpers";
// 改为
import { RunEventBus } from "../domain/run-event-bus.service";
import { RunService } from "../domain/run.service";
import { RuntimeTokenService } from "../internal-api/runtime-token.service";
import { ControlQueue } from "../internal-api/control-queue.service";
import { HeartbeatWatchdog, nextControlEnvelope, publishWorkerErrorStatus } from "./provider-helpers";
```

`runtime/providers/runtime-provider.registry.ts`：

```ts
// 将
import { LocalProcessProvider } from "./local-process-provider.service";
import { DockerProvider } from "./docker-provider.service";
// 改为 — 不变（同目录）
```

`runtime/providers/runtime-provider.registry.spec.ts`：

```ts
// 将
import { RuntimeProviderRegistry } from "./runtime-provider-registry.service";
import { LocalProcessProvider } from "./local-process-provider.service";
import { DockerProvider } from "./docker-provider.service";
// 改为
import { RuntimeProviderRegistry } from "./runtime-provider.registry";
import { LocalProcessProvider } from "./local-process-provider.service";
import { DockerProvider } from "./docker-provider.service";
```

`runtime/providers/provider-helpers.ts`：

```ts
// 将
import type { RunEventBus } from "./run-event-bus.service";
// 改为
import type { RunEventBus } from "../domain/run-event-bus.service";
```

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "refactor: migrate provider layer files to runtime/providers/"
```

---

### Task 3: 迁移 internal-api 层文件

**Files:**
- Move: `runtime/runtime.controller.ts` → `runtime/internal-api/runtime.controller.ts`
- Move: `runtime/runtime-auth.guard.ts` → `runtime/internal-api/runtime-auth.guard.ts`
- Move: `runtime/runtime-token.service.ts` → `runtime/internal-api/runtime-token.service.ts`
- Move: `runtime/runtime-token.service.spec.ts` → `runtime/internal-api/runtime-token.service.spec.ts`
- Move: `runtime/control-queue.service.ts` → `runtime/internal-api/control-queue.service.ts`
- Move: `runtime/control-queue.service.spec.ts` → `runtime/internal-api/control-queue.service.spec.ts`

- [ ] **Step 1: git mv 文件**

```bash
cd apps/api/src
git mv runtime/runtime.controller.ts runtime/internal-api/runtime.controller.ts
git mv runtime/runtime-auth.guard.ts runtime/internal-api/runtime-auth.guard.ts
git mv runtime/runtime-token.service.ts runtime/internal-api/runtime-token.service.ts
git mv runtime/runtime-token.service.spec.ts runtime/internal-api/runtime-token.service.spec.ts
git mv runtime/control-queue.service.ts runtime/internal-api/control-queue.service.ts
git mv runtime/control-queue.service.spec.ts runtime/internal-api/control-queue.service.spec.ts
```

- [ ] **Step 2: 修正 internal-api 层文件的 import 路径**

`runtime/internal-api/runtime.controller.ts`：

```ts
// 将
import { RuntimeAuthGuard } from "./runtime-auth.guard";
import { RunEventBus } from "../runs/run-event-bus.service";
import { RunService } from "../runs/run.service";
import { DockerProvider } from "../runs/docker-provider.service";
import { ControlQueue } from "./control-queue.service";
import { RuntimeTokenService } from "./runtime-token.service";
// 改为
import { RuntimeAuthGuard } from "./runtime-auth.guard";
import { RunEventBus } from "../domain/run-event-bus.service";
import { RunService } from "../domain/run.service";
import { DockerProvider } from "../providers/docker-provider.service";
import { ControlQueue } from "./control-queue.service";
import { RuntimeTokenService } from "./runtime-token.service";
```

`runtime/internal-api/runtime-auth.guard.ts`：

```ts
// 将
import { RuntimeTokenService } from "./runtime-token.service";
import { extractBearerToken } from "../auth/extract-bearer-token";
// 改为
import { RuntimeTokenService } from "./runtime-token.service";
import { extractBearerToken } from "../../auth/extract-bearer-token";
```

`runtime/internal-api/runtime-token.service.ts` — 不变（只依赖 `@nestjs/common` 和 `@nestjs/jwt`）。

`runtime/internal-api/runtime-token.service.spec.ts` — 不变（只依赖 `./runtime-token.service` 和 `@nestjs/jwt`）。

`runtime/internal-api/control-queue.service.ts` — 不变（只依赖 `@nestjs/common` 和 `@agework/protocol`）。

`runtime/internal-api/control-queue.service.spec.ts` — 不变。

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "refactor: migrate internal-api layer files to runtime/internal-api/"
```

---

### Task 4: 迁移 run.controller.ts + 删除旧 runs/ 目录残留

**Files:**
- Move: `runs/run.controller.ts` → `runtime/run.controller.ts`
- Delete: `runs/runs.module.ts`（将被新的 `runtime.module.ts` 替代）
- Delete: `runs/` 目录（应已清空）

- [ ] **Step 1: git mv run.controller.ts**

```bash
cd apps/api/src
git mv runs/run.controller.ts runtime/run.controller.ts
```

- [ ] **Step 2: 修正 run.controller.ts 的 import 路径**

`runtime/run.controller.ts`：

```ts
// 将
import { RunService } from "./run.service";
// 改为
import { RunService } from "./domain/run.service";
```

- [ ] **Step 3: 删除旧 runs.module.ts 和清空 runs/ 目录**

```bash
cd apps/api/src
git rm runs/runs.module.ts
# 确认 runs/ 目录已空，然后删除
rmdir runs
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "refactor: migrate run.controller.ts and remove old runs/ directory"
```

---

### Task 5: 新建 RunConfigStore + 从 RunService 拆出 runConfigRegistry

**Files:**
- Create: `runtime/providers/run-config-store.service.ts`
- Create: `runtime/providers/run-config-store.service.spec.ts`
- Modify: `runtime/domain/run.service.ts` — 删除 runConfigRegistry 相关代码
- Modify: `runtime/providers/docker-provider.service.ts` — 改用 RunConfigStore
- Modify: `runtime/internal-api/runtime.controller.ts` — 改用 RunConfigStore

- [ ] **Step 1: 写 RunConfigStore 测试**

`runtime/providers/run-config-store.service.spec.ts`：

```ts
import { describe, it, expect } from "vitest";
import { RunConfigStore } from "./run-config-store.service";

describe("RunConfigStore", () => {
  it("registers, retrieves and unregisters a run config", () => {
    const store = new RunConfigStore();
    const config = { runId: "run-1" } as any;

    store.register("run-1", config);
    expect(store.get("run-1")).toBe(config);

    store.unregister("run-1");
    expect(store.get("run-1")).toBeUndefined();
  });

  it("returns undefined for an unknown run id", () => {
    const store = new RunConfigStore();
    expect(store.get("missing")).toBeUndefined();
  });

  it("unregister is idempotent", () => {
    const store = new RunConfigStore();
    store.unregister("nonexistent"); // should not throw
    expect(store.get("nonexistent")).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm test:api -- runtime/providers/run-config-store.service.spec.ts
```

Expected: FAIL — `RunConfigStore` 不存在

- [ ] **Step 3: 写 RunConfigStore 实现**

`runtime/providers/run-config-store.service.ts`：

```ts
import { Injectable } from "@nestjs/common";
import type { RunConfig } from "@agework/protocol";

/**
 * 内存 RunConfig 暂存。
 * DockerProvider.start() 时 register，worker HTTP 拉取时 get，终态后 unregister。
 * LocalProcessProvider 不使用此 store（IPC 直接发送 config）。
 */
@Injectable()
export class RunConfigStore {
  private readonly configs = new Map<string, RunConfig>();

  register(runId: string, config: RunConfig): void {
    this.configs.set(runId, config);
  }

  get(runId: string): RunConfig | undefined {
    return this.configs.get(runId);
  }

  unregister(runId: string): void {
    this.configs.delete(runId);
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
pnpm test:api -- runtime/providers/run-config-store.service.spec.ts
```

Expected: PASS

- [ ] **Step 5: 从 RunService 删除 runConfigRegistry**

`runtime/domain/run.service.ts` — 删除以下内容：

```ts
// 删除字段
private readonly runConfigRegistry = new Map<string, RunConfig>();

// 删除三个方法
registerRunConfig(runId: string, config: RunConfig): void { ... }
getRunConfig(runId: string): RunConfig | undefined { ... }
unregisterRunConfig(runId: string): void { ... }
```

同时删除 `RunConfig` 的 import（如果不再被其他方法引用）。`RunService` 的构造函数只保留 `private prisma: PrismaService`。

- [ ] **Step 6: DockerProvider 改用 RunConfigStore**

`runtime/providers/docker-provider.service.ts`：

```ts
// 将
import { RunService } from "../domain/run.service";
// 改为
import { RunConfigStore } from "./run-config-store.service";

// 构造函数将
constructor(
  private readonly runEventBus: RunEventBus,
  private readonly runService: RunService,
  private readonly runtimeTokenService: RuntimeTokenService,
  private readonly controlQueue: ControlQueue
) {}
// 改为
constructor(
  private readonly runEventBus: RunEventBus,
  private readonly runConfigStore: RunConfigStore,
  private readonly runtimeTokenService: RuntimeTokenService,
  private readonly controlQueue: ControlQueue
) {}

// start() 中将
this.runService.registerRunConfig(runId, runConfig);
// 改为
this.runConfigStore.register(runId, runConfig);

// cleanup() 中将
this.runService.unregisterRunConfig(runId);
// 改为
this.runConfigStore.unregister(runId);
```

- [ ] **Step 7: RuntimeController 改用 RunConfigStore**

`runtime/internal-api/runtime.controller.ts`：

```ts
// 将
import { RunService } from "../domain/run.service";
import { DockerProvider } from "../providers/docker-provider.service";
// 改为
import { RunConfigStore } from "../providers/run-config-store.service";
import { DockerProvider } from "../providers/docker-provider.service";

// 构造函数将
constructor(
  private readonly runEventBus: RunEventBus,
  private readonly runService: RunService,
  private readonly dockerProvider: DockerProvider,
  private readonly controlQueue: ControlQueue,
  private readonly runtimeTokenService: RuntimeTokenService
) {}
// 改为
constructor(
  private readonly runEventBus: RunEventBus,
  private readonly runConfigStore: RunConfigStore,
  private readonly dockerProvider: DockerProvider,
  private readonly controlQueue: ControlQueue,
  private readonly runtimeTokenService: RuntimeTokenService
) {}

// getRunConfig() 中将
const config = this.runService.getRunConfig(runId);
// 改为
const config = this.runConfigStore.get(runId);
```

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "refactor: extract RunConfigStore from RunService, update DockerProvider and RuntimeController"
```

---

### Task 6: 新建 RunLauncherService + 瘦身 AgentController

**Files:**
- Create: `runtime/run-launcher.service.ts`
- Create: `runtime/run-launcher.service.spec.ts`
- Modify: `agent/agent.controller.ts` — 删除底层依赖，改为调用 RunLauncherService

- [ ] **Step 1: 写 RunLauncherService 测试**

`runtime/run-launcher.service.spec.ts`：

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { RunLauncherService } from "./run-launcher.service";
import { RunService } from "./domain/run.service";
import { RunRegistry } from "./domain/run-registry.service";
import { RunEventBus } from "./domain/run-event-bus.service";
import { RuntimeProviderRegistry } from "./providers/runtime-provider.registry";

describe("RunLauncherService", () => {
  let service: RunLauncherService;
  let mockRunService: Partial<RunService>;
  let mockRunRegistry: Partial<RunRegistry>;
  let mockRunEventBus: Partial<RunEventBus>;
  let mockProviderRegistry: Partial<RuntimeProviderRegistry>;
  let mockConfigService: { getRuntimeProviderType: () => "local" | "docker" };

  beforeEach(() => {
    mockRunService = {
      create: vi.fn().mockResolvedValue({ id: "run-1" }),
      findActiveByThreadId: vi.fn().mockResolvedValue(null),
      markError: vi.fn().mockResolvedValue(undefined),
      markCancelling: vi.fn().mockResolvedValue(undefined),
      markFinished: vi.fn().mockResolvedValue(undefined),
    };
    mockRunRegistry = {
      register: vi.fn(),
      unregister: vi.fn(),
      get: vi.fn().mockReturnValue(undefined),
    };
    mockRunEventBus = {
      registerContext: vi.fn(),
      unregisterContext: vi.fn(),
      publish: vi.fn().mockResolvedValue(undefined),
    };
    mockProviderRegistry = {
      resolve: vi.fn().mockReturnValue({
        start: vi.fn().mockReturnValue({ runId: "run-1", providerType: "local", runtimeId: "1:token" }),
        sendControl: vi.fn(),
        cancel: vi.fn(),
      }),
    };
    mockConfigService = {
      getRuntimeProviderType: vi.fn().mockReturnValue("local"),
    };

    service = new RunLauncherService(
      mockRunService as RunService,
      mockRunRegistry as RunRegistry,
      mockRunEventBus as RunEventBus,
      mockProviderRegistry as RuntimeProviderRegistry,
      mockConfigService as any,
    );
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("start()", () => {
    it("should create run, register event bus context, start provider and register handle", async () => {
      const res = { on: vi.fn(), writableEnded: false } as any;
      const runConfig = { runId: "run-1", threadId: "thread-1" } as any;
      const aggregator = {} as any;
      const saveRun = vi.fn();

      await service.start({
        runId: "run-1",
        threadId: "thread-1",
        projectId: "project-1",
        userId: "user-1",
        agentType: "claude",
        runConfig,
        res,
        aggregator,
        saveRun,
      });

      expect(mockRunService.create).toHaveBeenCalledWith({
        id: "run-1", threadId: "thread-1", projectId: "project-1", userId: "user-1", agentType: "claude",
      });
      expect(mockRunEventBus.registerContext).toHaveBeenCalledWith("run-1", expect.objectContaining({
        runId: "run-1", threadId: "thread-1", res, aggregator, saveRun,
      }));
      expect(mockProviderRegistry.resolve).toHaveBeenCalledWith("local");
      expect(mockRunRegistry.register).toHaveBeenCalledWith("run-1", expect.objectContaining({
        runId: "run-1",
      }));
    });

    it("should rollback on provider.start() failure", async () => {
      const provider = {
        start: vi.fn().mockImplementation(() => { throw new Error("spawn failed"); }),
      };
      mockProviderRegistry.resolve = vi.fn().mockReturnValue(provider);

      const res = { on: vi.fn(), writableEnded: false, end: vi.fn() } as any;

      await service.start({
        runId: "run-1",
        threadId: "thread-1",
        projectId: "project-1",
        userId: "user-1",
        agentType: "claude",
        runConfig: {} as any,
        res,
        aggregator: {} as any,
        saveRun: vi.fn(),
      });

      expect(mockRunEventBus.unregisterContext).toHaveBeenCalledWith("run-1");
      expect(mockRunService.markError).toHaveBeenCalledWith("run-1", "Failed to start worker");
    });
  });

  describe("sendApprovalResolved()", () => {
    it("should throw NotFoundException when no active run found", async () => {
      mockRunService.findActiveByThreadId = vi.fn().mockResolvedValue(null);
      await expect(service.sendApprovalResolved("thread-1", {})).rejects.toThrow();
    });
  });

  describe("stop()", () => {
    it("should mark finished when no active handle but run record exists", async () => {
      mockRunService.findActiveByThreadId = vi.fn().mockResolvedValue({ id: "run-1" });
      mockRunRegistry.get = vi.fn().mockReturnValue(undefined);

      await service.stop("thread-1", "running");

      expect(mockRunService.markFinished).toHaveBeenCalledWith("run-1");
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
pnpm test:api -- runtime/run-launcher.service.spec.ts
```

Expected: FAIL — `RunLauncherService` 不存在

- [ ] **Step 3: 写 RunLauncherService 实现**

`runtime/run-launcher.service.ts`：

```ts
import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type { RunConfig, ControlPayload, RuntimeHandle } from "@agework/protocol";
import { RunService } from "./domain/run.service";
import { RunRegistry } from "./domain/run-registry.service";
import { RunEventBus } from "./domain/run-event-bus.service";
import { RuntimeProviderRegistry } from "./providers/runtime-provider.registry";
import { ConfigService } from "../config/config.service";
import type { RunAggregator } from "../agent/run-aggregator";

@Injectable()
export class RunLauncherService {
  private readonly logger = new Logger(RunLauncherService.name);

  constructor(
    private readonly runService: RunService,
    private readonly runRegistry: RunRegistry,
    private readonly runEventBus: RunEventBus,
    private readonly runtimeProviderRegistry: RuntimeProviderRegistry,
    private readonly configService: ConfigService,
  ) {}

  async start(params: {
    runId: string;
    threadId: string;
    projectId: string;
    userId: string;
    agentType: string;
    runConfig: RunConfig;
    res: Response;
    aggregator: RunAggregator;
    saveRun: (complete: boolean) => void;
    onAgentResumeId?: (resumeId: string) => void;
  }): Promise<void> {
    const { runId, threadId, runConfig, res, aggregator, saveRun, onAgentResumeId } = params;

    // Create Run record
    try {
      await this.runService.create({
        id: runId,
        threadId,
        projectId: params.projectId,
        userId: params.userId,
        agentType: params.agentType,
      });
    } catch (err) {
      this.logger.warn(
        `Failed to create Run for thread ${threadId}: ${err instanceof Error ? err.message : String(err)}`
      );
      if (!res.writableEnded) res.end();
      return;
    }

    // Register RunEventBus context
    this.runEventBus.registerContext(runId, {
      runId,
      threadId,
      res,
      aggregator,
      saveRun,
      onAgentResumeId,
    });

    // Start worker via provider
    const providerType = this.configService.getRuntimeProviderType();
    const provider = this.runtimeProviderRegistry.resolve(providerType);
    let runtimeHandle: RuntimeHandle;
    try {
      runtimeHandle = provider.start(runConfig);
    } catch (err) {
      this.logger.error(`Failed to start worker: ${String(err)}`);
      this.runEventBus.unregisterContext(runId);
      await this.runService.markError(runId, "Failed to start worker");
      if (!res.writableEnded) res.end();
      return;
    }

    // Register with RunRegistry
    this.runRegistry.register(runId, {
      runtimeHandle,
      res,
      aggregator,
      threadId,
      runId,
      stopRequested: false,
    });

    // SSE disconnect: null out the response ref (don't cancel the run)
    res.on("close", () => {
      const handle = this.runRegistry.get(runId);
      if (handle) {
        handle.res = null;
      }
      const ctx = (this.runEventBus as any).contexts?.get(runId);
      if (ctx) ctx.res = null;
    });
  }

  sendApprovalResolved(threadId: string, answers: Record<string, string | string[]>): void {
    const activeRun = this.runService.findActiveByThreadId(threadId);
    // findActiveByThreadId is async, but we need sync access to the registry.
    // The controller already awaits this, so we keep the same pattern:
    // This method is intentionally async-compatible — see controller usage.
    throw new Error("Use the async overload instead");
  }

  async sendApprovalResolvedAsync(
    threadId: string,
    answers: Record<string, string | string[]>
  ): Promise<void> {
    const activeRun = await this.runService.findActiveByThreadId(threadId);
    const handle = activeRun ? this.runRegistry.get(activeRun.id) : undefined;
    if (!handle) {
      throw new NotFoundException(`No active run for thread: ${threadId}`);
    }
    const provider = this.runtimeProviderRegistry.resolve(handle.runtimeHandle.providerType);
    provider.sendControl(handle.runtimeHandle, {
      type: "approval_resolved",
      commandId: randomUUID(),
      threadId,
      answers: answers ?? {},
    });
  }

  async stop(threadId: string, currentRunStatus: string): Promise<void> {
    const activeRunRecord = await this.runService.findActiveByThreadId(threadId);
    const handle = activeRunRecord ? this.runRegistry.get(activeRunRecord.id) : undefined;
    if (!handle) {
      if (currentRunStatus === "running") {
        // No in-memory handle but DB says running — clean up stale state
      }
      if (activeRunRecord) {
        await this.runService.markFinished(activeRunRecord.id);
      }
      return;
    }
    handle.stopRequested = true;
    if (activeRunRecord) {
      await this.runService.markCancelling(activeRunRecord.id);
    }
    const provider = this.runtimeProviderRegistry.resolve(handle.runtimeHandle.providerType);
    provider.cancel(handle.runtimeHandle);
  }
}
```

注意：`sendApprovalResolved` 方法需要是 async 的（因为 `findActiveByThreadId` 是 async）。上面的实现中 `sendApprovalResolvedAsync` 是实际使用的方法。在最终实现中直接命名为 `sendApprovalResolved` 并标记为 async，删除同步版本。

- [ ] **Step 4: 运行测试确认通过**

```bash
pnpm test:api -- runtime/run-launcher.service.spec.ts
```

Expected: PASS

- [ ] **Step 5: 瘦身 AgentController**

`agent/agent.controller.ts` — 改为通过 `RunLauncherService` 交互：

```ts
// 删除这些 import
import { RunService } from "../runs/run.service";
import { RunRegistry } from "../runs/run-registry.service";
import { RunEventBus } from "../runs/run-event-bus.service";
import { RuntimeProviderRegistry } from "../runs/runtime-provider-registry.service";
import { ConfigService } from "../config/config.service";

// 新增
import { RunLauncherService } from "../runtime/run-launcher.service";
```

构造函数简化为：

```ts
constructor(
  private readonly agentService: AgentService,
  private readonly threadService: ThreadService,
  private readonly traceLogger: AgentTraceLogger,
  private readonly titleService: TitleService,
  private readonly runLauncher: RunLauncherService,
) {}
```

`run()` 方法瘦身 — 保留的职责：
1. 解析请求参数（threadId, runId, userMessage, agentType, modelConfigId）
2. 保存用户消息
3. 解析 thread/project 关联
4. `agentService.buildRunConfig()`
5. 生成标题（并行）
6. 设置 SSE headers
7. `threadService.setRunStatus(threadId, "running")`
8. 创建 aggregator + saveRun 闭包
9. 调用 `this.runLauncher.start(...)` — 所有底层操作下沉

`answerQuestion()` 方法：

```ts
@Post("threads/:threadId/question-answer")
async answerQuestion(
  @Param("threadId") threadId: string,
  @Body() body: { answers: Record<string, string | string[]> },
  @CurrentUser() _user: JwtUser
) {
  await this.runLauncher.sendApprovalResolved(threadId, body.answers);
}
```

`stop()` 方法：

```ts
@Post("threads/:threadId/stop")
async stop(
  @Param("threadId") threadId: string,
  @CurrentUser() user: JwtUser
) {
  const thread = await this.threadService.findOne(user.userId, threadId);
  await this.runLauncher.stop(threadId, thread.runStatus);
}
```

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "refactor: add RunLauncherService, slim down AgentController"
```

---

### Task 7: 合并 runtime.module.ts + 更新 AgentModule + AppModule

**Files:**
- Create: `runtime/runtime.module.ts`（新，合并版）
- Delete: `runtime/runtime.module.ts`（旧，已在 Task 3 前被覆盖，此处确保是新内容）
- Modify: `agent/agent.module.ts`
- Modify: `app.module.ts`

- [ ] **Step 1: 写新的 runtime.module.ts**

`runtime/runtime.module.ts`：

```ts
import { Module, OnModuleInit, Logger } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";

// domain
import { RunService } from "./domain/run.service";
import { RunRegistry } from "./domain/run-registry.service";
import { RunEventBus } from "./domain/run-event-bus.service";

// providers
import { RunConfigStore } from "./providers/run-config-store.service";
import { LocalProcessProvider } from "./providers/local-process-provider.service";
import { DockerProvider } from "./providers/docker-provider.service";
import { RuntimeProviderRegistry } from "./providers/runtime-provider.registry";

// internal-api
import { RuntimeController } from "./internal-api/runtime.controller";
import { RuntimeTokenService } from "./internal-api/runtime-token.service";
import { RuntimeAuthGuard } from "./internal-api/runtime-auth.guard";
import { ControlQueue } from "./internal-api/control-queue.service";

// facade
import { RunLauncherService } from "./run-launcher.service";

// admin
import { RunController } from "./run.controller";

// external deps
import { ThreadModule } from "../threads/thread.module";
import { ThreadService } from "../threads/thread.service";

@Module({
  imports: [
    ThreadModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET ?? "agework-dev-secret",
    }),
  ],
  controllers: [RunController, RuntimeController],
  providers: [
    // domain
    RunService, RunRegistry, RunEventBus,
    // providers
    RunConfigStore, LocalProcessProvider, DockerProvider, RuntimeProviderRegistry,
    // internal-api
    RuntimeTokenService, RuntimeAuthGuard, ControlQueue,
    // facade
    RunLauncherService,
  ],
  exports: [RunService, RunLauncherService],
})
export class RuntimeModule implements OnModuleInit {
  private readonly logger = new Logger(RuntimeModule.name);

  constructor(
    private readonly runService: RunService,
    private readonly threadService: ThreadService
  ) {}

  async onModuleInit() {
    await this.recoverOrphanRuns();
  }

  private async recoverOrphanRuns() {
    try {
      const activeRuns = await this.runService.findAllActive();
      if (activeRuns.length === 0) {
        this.logger.log("No orphan runs found.");
        return;
      }

      this.logger.warn(
        `Found ${activeRuns.length} orphan run(s) — marking as error`
      );

      for (const run of activeRuns) {
        if (run.runtimeId) {
          const parts = run.runtimeId.split(":");
          if (parts.length === 2) {
            const pid = parseInt(parts[0], 10);
            if (!isNaN(pid)) {
              try {
                process.kill(pid, "SIGTERM");
              } catch {
                // ESRCH: process already gone
              }
            }
          }
        }

        await this.runService.markError(run.id, "服务重启导致运行中断");
        await this.threadService
          .setPendingAction(run.threadId, null)
          .catch(() => {});
        await this.threadService
          .setRunStatus(run.threadId, "error")
          .catch(() => {});

        this.logger.log(`Marked orphan run ${run.id} as error`);
      }
    } catch (err) {
      this.logger.error(
        `Failed to recover orphan runs: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
```

- [ ] **Step 2: 更新 agent.module.ts**

`agent/agent.module.ts`：

```ts
import { Module } from "@nestjs/common";
import { AgentController } from "./agent.controller";
import { AgentService } from "./agent.service";
import { AgentTraceLogger } from "./agent-trace-logger";
import { TitleService } from "./title.service";
import { ThreadModule } from "../threads/thread.module";
import { RuntimeModule } from "../runtime/runtime.module";

@Module({
  imports: [ThreadModule, RuntimeModule],
  controllers: [AgentController],
  providers: [AgentService, AgentTraceLogger, TitleService],
})
export class AgentModule {}
```

- [ ] **Step 3: 更新 app.module.ts**

确认 `app.module.ts` 中：
- 移除 `import { RuntimeModule } from "./runtime/runtime.module";` 和 `RuntimeModule` 在 imports 数组中的条目（因为 `AgentModule` 已间接引入）
- 确认无 `RunsModule` 的残留引用

- [ ] **Step 4: 删除旧的 runtime.module.ts（如果仍存在旧版）**

旧的 `runtime/runtime.module.ts` 已在 Step 1 中被覆盖为新内容，无需额外删除。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "refactor: merge RunsModule+RuntimeModule into single RuntimeModule, update imports"
```

---

### Task 8: 全量 typecheck + test + 修复残留问题

**Files:**
- 可能修改：任何仍有旧 import 路径的文件

- [ ] **Step 1: 运行 typecheck**

```bash
pnpm typecheck
```

Expected: PASS。如有错误，逐一修复残留的旧路径 import（如 `../runs/...` → `../runtime/domain/...` 等）。

- [ ] **Step 2: 运行全量后端测试**

```bash
pnpm test:api
```

Expected: PASS。如有失败，根据错误信息修复。

- [ ] **Step 3: 运行 lint**

```bash
pnpm lint
```

Expected: PASS。如有 lint 错误，用 `pnpm lint:fix` 修复。

- [ ] **Step 4: 最终 Commit**

```bash
git add -A && git commit -m "refactor: fix residual import paths after runtime module restructure"
```
