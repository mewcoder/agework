# SandboxEngine 抽取实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `DockerRuntimeProvider`（530 行）和 `OpenSandboxRuntimeProvider`（612 行）的共有编排逻辑抽取到 `SandboxRuntimeProvider`，底层基础设施操作分别下沉到 `DockerSandboxEngine` 和 `OpenSandboxEngine`，对外行为不变。

**Architecture:** 现有三个 provider（`local` / `docker` / `opensandbox`）注册到 `RuntimeProviderRegistry`。重构后 registry 只注册 `local` + `sandbox` 两个 provider。`SandboxRuntimeProvider`（`type="sandbox"`）持有所有沙箱编排逻辑（scope 状态、pending 追踪、取消、心跳、空闲、control queue、access key、cleanup），通过 `SandboxEngine` 接口委托底层操作。`DockerSandboxEngine` 封装 `docker run/stop/kill/rm`；`OpenSandboxEngine` 封装 `OpenSandboxClient` 的创建/连接/删除/启动 worker。`RuntimePlacementService` 将 `docker`/`opensandbox` 映射为 `runtimeType="sandbox"`，在 placement 的 `metadata`（或新增字段）中携带 engine 类型。

**Tech Stack:** NestJS 11、Vitest、TypeScript、Prisma、docker CLI（child_process.execFile）、@alibaba-group/opensandbox SDK

---

## 文件结构

```
apps/api/src/runtime/
├── providers/
│   ├── sandbox-engine.ts                    # CREATE — SandboxEngine 接口 + 类型
│   ├── docker-sandbox-engine.ts             # CREATE — DockerSandboxEngine 实现
│   ├── docker-sandbox-engine.spec.ts        # CREATE — Docker engine 单测
│   ├── opensandbox-sandbox-engine.ts        # CREATE — OpenSandboxEngine 实现
│   ├── opensandbox-sandbox-engine.spec.ts   # CREATE — OpenSandbox engine 单测
│   ├── sandbox-runtime-provider.ts          # CREATE — SandboxRuntimeProvider 编排
│   ├── sandbox-runtime-provider.spec.ts     # CREATE — 编排层单测
│   ├── sandbox-engine.token.ts              # CREATE — DI token: SANDBOX_ENGINES
│   ├── local-runtime-provider.ts            # KEEP — 不动
│   ├── local-runtime-provider.spec.ts       # KEEP — 不动
│   ├── runtime-provider-registry.ts         # MODIFY — 不需要改代码，注册项由 module 注入变化自动生效
│   ├── runtime-provider-registry.spec.ts    # MODIFY — 改为 local + sandbox
│   ├── runtime-provider-utils.ts            # KEEP — 不动
│   ├── runtime-provider-utils.spec.ts       # KEEP — 不动
│   ├── runtime-provider.token.ts            # KEEP — 不动
│   ├── opensandbox-client.ts                # KEEP — 不动，OpenSandboxEngine 引用它
│   ├── opensandbox-client.token.ts          # KEEP — 不动
│   ├── docker-runtime-provider.ts           # DELETE — 迁移完成后删除
│   ├── docker-runtime-provider.spec.ts      # DELETE — 迁移完成后删除
│   ├── opensandbox-runtime-provider.ts      # DELETE — 迁移完成后删除
│   └── opensandbox-runtime-provider.spec.ts # DELETE — 迁移完成后删除
├── runtime.module.ts                        # MODIFY — 注入新 provider/engine，移除旧 provider
├── core/
│   └── runtime-placement.service.ts         # MODIFY — docker/opensandbox 映射为 "sandbox"，携带 engineType
│   └── runtime-placement.service.spec.ts    # MODIFY — 更新预期 runtimeType
└── config/
    └── config.service.ts                    # MODIFY — 新增 getSandboxEngine() 方法
```

### 类型设计关键决策

1. **`RuntimePlacement` 如何携带 engineType？** 在 `SandboxRuntimeProvider.start()` 内部，需要知道用哪个 engine。方案：`RuntimePlacement` 新增可选字段 `sandboxEngineType?: SandboxEngineType`，由 `RuntimePlacementService` 在映射时填入。`local` placement 不带此字段。

2. **`SandboxRuntimeProvider` 如何选择 engine？** 持有 `Map<SandboxEngineType, SandboxEngine>`，按 `placement.sandboxEngineType` 选。A 阶段只有一种 engine（由 `SANDBOX_ENGINE` 配置决定），但仍按 map 查找，为 B 阶段（per-workspace engine）预留扩展。

3. **scope state 字段名统一：** Docker 用 `containerId`，OpenSandbox 用 `sandboxId`。统一为 `runtimeResourceId: string`。

4. **`heartbeatScope` 方法：** Docker provider 没有 `heartbeatScope`，OpenSandbox 有。统一收入 `SandboxRuntimeProvider`，Docker engine 不需要但 provider 层统一暴露。

5. **`getStateByWorkspaceId` 返回值：** 当前返回 `{ containerId: string }`。统一改为 `{ runtimeResourceId: string }`，但需要检查调用方。若调用方强依赖 `containerId` 字段名，则保留兼容。搜索后确认调用方是 `runtime-workspace.controller.ts` 和 `runtime-runtime.controller.ts`，它们只读 `containerId` 用于日志/查询，统一改名需要同步改调用方。**决策：** 统一为 `runtimeResourceId`，同步改调用方，因为这是内部 API 且开发阶段无兼容负担。

---

## Task 1: 定义 SandboxEngine 接口与类型

**Files:**
- Create: `apps/api/src/runtime/providers/sandbox-engine.ts`

- [ ] **Step 1: 创建 `sandbox-engine.ts`，定义 SandboxEngine 接口和所有相关类型**

```ts
import type { OpenSandboxClientLike } from "./opensandbox-client";

// ── SandboxEngine 类型标识 ──────────────────────────────────────────────

export type SandboxEngineType = "docker" | "opensandbox";

// ── Sandbox 放置信息（从 RuntimePlacement 提取） ──────────────────────────

export type SandboxPlacement = {
  scope: "user" | "workspace";
  scopeId: string;
  workspaceId: string;
  workspaceHostPath: string;
  workspaceMountPath: string;
  resourceName: string;
  isolationScope: import("@agework/shared/protocol").RuntimeIsolationScope;
};

// ── Engine 启动输入 ────────────────────────────────────────────────────

export type SandboxStartInput = {
  placement: SandboxPlacement;
  image: string;
  apiBaseUrl: string;
  accessKey: string;
  env: Record<string, string>;
  metadata: Record<string, string>;
  /** OpenSandbox 专用：binding 恢复时传已有的 runtimeBindingId */
  runtimeBindingId?: string;
};

// ── Engine 返回的运行时信息 ────────────────────────────────────────────

export type SandboxRuntime = {
  engineType: SandboxEngineType;
  runtimeResourceId: string;
  workspaceMountPath: string;
};

// ── SandboxEngine 接口 ─────────────────────────────────────────────────

export interface SandboxEngine {
  readonly type: SandboxEngineType;

  /**
   * 获取或创建沙箱运行环境。
   * - 如果对应 scopeId 的沙箱已存在（内存/DB），返回已有实例。
   * - 如果不存在，创建新实例并返回。
   */
  getOrCreate(input: SandboxStartInput): Promise<SandboxRuntime>;

  /**
   * 在已有沙箱中启动 worker 进程。
   * Docker engine 是空操作（worker 通过容器 entrypoint 启动）。
   * OpenSandbox engine 需要调 sandbox.runCommand()。
   */
  startWorker(runtime: SandboxRuntime, input: SandboxStartInput): Promise<void>;

  /**
   * 停止并删除沙箱运行环境。
   * Docker: docker stop + rm。
   * OpenSandbox: client.deleteSandbox。
   */
  stop(runtimeResourceId: string): Promise<void>;

  /**
   * 服务重启后，根据持久化的 runtimeResourceId 终止孤儿资源。幂等。
   */
  recoverOrphan(runtimeResourceId: string): Promise<void>;

  /**
   * 检查沙箱是否健康。可选，用于 DB binding 恢复时验证。
   */
  isHealthy?(runtimeResourceId: string): Promise<boolean>;
}
```

- [ ] **Step 2: 运行类型检查确认无错误**

Run: `pnpm --filter api typecheck`
Expected: 通过（新文件无引用方，不影响现有代码）

---

## Task 2: 创建 DI token

**Files:**
- Create: `apps/api/src/runtime/providers/sandbox-engine.token.ts`

- [ ] **Step 1: 创建 `sandbox-engine.token.ts`**

```ts
import type { SandboxEngine } from "./sandbox-engine";

/**
 * DI token：聚合所有已注册的 SandboxEngine 实现。
 * 新增 engine 时，只需新建一个实现类并加入 runtime.module.ts
 * 的 providers 数组与本 token 的 inject 列表。
 */
export const SANDBOX_ENGINES = Symbol("SANDBOX_ENGINES");
```

---

## Task 3: 实现 DockerSandboxEngine

**Files:**
- Create: `apps/api/src/runtime/providers/docker-sandbox-engine.ts`
- Create: `apps/api/src/runtime/providers/docker-sandbox-engine.spec.ts`

从 `DockerRuntimeProvider` 的以下方法迁移：
- `startContainer()` → `getOrCreate()`
- `dockerStop()` / `dockerKill()` / `dockerRm()` / `stopContainerOrKill()` → `stop()`
- `recoverOrphan()` → `recoverOrphan()`
- `getApiBaseUrl()` / `getWorkerImage()` / `assertSafeMountPath()` → 内部辅助
- `startWorker()` → 空操作（Docker 容器的 worker 通过 entrypoint 启动）

- [ ] **Step 1: 写 DockerSandboxEngine 的失败测试**

```ts
// docker-sandbox-engine.spec.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFile } from "node:child_process";
import { DockerSandboxEngine } from "./docker-sandbox-engine";
import type { SandboxStartInput, SandboxPlacement } from "./sandbox-engine";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

const mockExecFile = vi.mocked(execFile);

function makePlacement(overrides?: Partial<SandboxPlacement>): SandboxPlacement {
  return {
    scope: "workspace",
    scopeId: "ws-1",
    workspaceId: "ws-1",
    workspaceHostPath: "/tmp/workspace",
    workspaceMountPath: "/workspace",
    resourceName: "agework-ws-ws-1",
    isolationScope: "workspace",
    ...overrides,
  };
}

function makeInput(overrides?: Partial<SandboxStartInput>): SandboxStartInput {
  return {
    placement: makePlacement(),
    image: "agework/worker:latest",
    apiBaseUrl: "http://host.docker.internal:3000/api/v1",
    accessKey: "test-key",
    env: {},
    metadata: {},
    ...overrides,
  };
}

describe("DockerSandboxEngine", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it("getOrCreate starts a container and returns SandboxRuntime", async () => {
    const engine = new DockerSandboxEngine();
    mockExecFile.mockImplementation(((...args: any[]) => {
      args[args.length - 1](null, { stdout: "container-abc\n", stderr: "" });
    }) as any);

    const result = await engine.getOrCreate(makeInput());

    expect(result.engineType).toBe("docker");
    expect(result.runtimeResourceId).toBe("container-abc");
    expect(result.workspaceMountPath).toBe("/workspace");

    const runCall = mockExecFile.mock.calls.find(
      (c) => (c[1] as string[])[0] === "run"
    );
    const runArgs = runCall![1] as string[];
    expect(runArgs).not.toContain("--rm");
    expect(runArgs).toContain("--name");
    expect(runArgs).toContain("agework-ws-ws-1");
  });

  it("getOrCreate includes env vars from input", async () => {
    const engine = new DockerSandboxEngine();
    mockExecFile.mockImplementation(((...args: any[]) => {
      args[args.length - 1](null, { stdout: "container-abc\n", stderr: "" });
    }) as any);

    await engine.getOrCreate(makeInput({
      env: {
        RUNTIME_TRANSPORT: "http",
        PLATFORM_API_BASE: "http://host.docker.internal:3000/api/v1",
        AGEWORK_RUNTIME_ACCESS_KEY: "test-key",
        AGEWORK_WORKSPACE_ID: "ws-1",
      },
    }));

    const runCall = mockExecFile.mock.calls.find(
      (c) => (c[1] as string[])[0] === "run"
    );
    const runArgs = runCall![1] as string[];
    expect(runArgs).toContain("RUNTIME_TRANSPORT=http");
    expect(runArgs).toContain("AGEWORK_WORKSPACE_ID=ws-1");
  });

  it("getOrCreate throws on empty container ID", async () => {
    const engine = new DockerSandboxEngine();
    mockExecFile.mockImplementation(((...args: any[]) => {
      args[args.length - 1](null, { stdout: "\n", stderr: "" });
    }) as any);

    await expect(engine.getOrCreate(makeInput())).rejects.toThrow(
      "docker run returned empty container ID"
    );
  });

  it("stop calls docker stop then docker rm", async () => {
    const engine = new DockerSandboxEngine();
    mockExecFile.mockImplementation(((...args: any[]) => {
      args[args.length - 1](null, { stdout: "", stderr: "" });
    }) as any);

    await engine.stop("container-abc");

    expect(mockExecFile).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["stop", "container-abc"]),
      expect.any(Function)
    );
    expect(mockExecFile).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["rm", "container-abc"]),
      expect.any(Function)
    );
  });

  it("stop falls back to docker kill when stop fails", async () => {
    const engine = new DockerSandboxEngine();
    mockExecFile.mockImplementation(((...args: any[]) => {
      const cmdArgs = args[1] as string[];
      const callback = args[args.length - 1];
      if (cmdArgs[0] === "stop") {
        callback(new Error("stop failed"));
      } else {
        callback(null, { stdout: "", stderr: "" });
      }
    }) as any);

    await engine.stop("container-abc");

    expect(mockExecFile).toHaveBeenCalledWith(
      "docker",
      ["kill", "container-abc"],
      expect.any(Function)
    );
  });

  it("recoverOrphan stops the container by id", async () => {
    const engine = new DockerSandboxEngine();
    mockExecFile.mockImplementation(((...args: any[]) => {
      args[args.length - 1](null, { stdout: "", stderr: "" });
    }) as any);

    await engine.recoverOrphan("container-abc");

    expect(mockExecFile).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["stop", "container-abc"]),
      expect.any(Function)
    );
  });

  it("recoverOrphan force kills when stop fails", async () => {
    const engine = new DockerSandboxEngine();
    mockExecFile.mockImplementation(((...args: any[]) => {
      const cmdArgs = args[1] as string[];
      const callback = args[args.length - 1];
      if (cmdArgs[0] === "stop") {
        callback(new Error("stop failed"));
      } else {
        callback(null, { stdout: "", stderr: "" });
      }
    }) as any);

    await engine.recoverOrphan("container-abc");

    expect(mockExecFile).toHaveBeenCalledWith(
      "docker",
      ["kill", "container-abc"],
      expect.any(Function)
    );
  });

  it("startWorker is a no-op for Docker", async () => {
    const engine = new DockerSandboxEngine();
    // 不应抛错
    await engine.startWorker(
      { engineType: "docker", runtimeResourceId: "container-abc", workspaceMountPath: "/workspace" },
      makeInput()
    );
  });

  it("getOrCreate throws on non-absolute mount path", async () => {
    const engine = new DockerSandboxEngine();
    const input = makeInput({
      placement: makePlacement({ workspaceHostPath: "relative/path" }),
    });

    await expect(engine.getOrCreate(input)).rejects.toThrow("absolute");
  });

  it("getOrCreate mounts workspace volume when hostPath is provided", async () => {
    const engine = new DockerSandboxEngine();
    mockExecFile.mockImplementation(((...args: any[]) => {
      args[args.length - 1](null, { stdout: "container-abc\n", stderr: "" });
    }) as any);

    await engine.getOrCreate(makeInput({
      placement: makePlacement({
        workspaceHostPath: "/tmp/workspace",
        workspaceMountPath: "/workspace",
      }),
    }));

    const runCall = mockExecFile.mock.calls.find(
      (c) => (c[1] as string[])[0] === "run"
    );
    const runArgs = runCall![1] as string[];
    expect(runArgs).toContain("-v");
    const vIdx = runArgs.indexOf("-v");
    expect(runArgs[vIdx + 1]).toBe("/tmp/workspace:/workspace");
  });

  it("getOrCreate does not mount volume when hostPath is empty", async () => {
    const engine = new DockerSandboxEngine();
    mockExecFile.mockImplementation(((...args: any[]) => {
      args[args.length - 1](null, { stdout: "container-abc\n", stderr: "" });
    }) as any);

    await engine.getOrCreate(makeInput({
      placement: makePlacement({ workspaceHostPath: "" }),
    }));

    const runCall = mockExecFile.mock.calls.find(
      (c) => (c[1] as string[])[0] === "run"
    );
    const runArgs = runCall![1] as string[];
    expect(runArgs).not.toContain("-v");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter api test docker-sandbox-engine`
Expected: FAIL — module not found

- [ ] **Step 3: 实现 DockerSandboxEngine**

```ts
// docker-sandbox-engine.ts
import { Logger } from "@nestjs/common";
import { execFile } from "node:child_process";
import { isAbsolute, normalize } from "node:path";
import { promisify } from "node:util";
import type { SandboxEngine, SandboxEngineType, SandboxStartInput, SandboxRuntime } from "./sandbox-engine";
import { swallow } from "../../common/swallow";

const execFileAsync = promisify(execFile);

const DOCKER_STOP_TIMEOUT_S = 10;
const DOCKER_RUN_TIMEOUT_MS = 120_000;

export class DockerSandboxEngine implements SandboxEngine {
  readonly type: SandboxEngineType = "docker";
  private readonly logger = new Logger(DockerSandboxEngine.name);

  async getOrCreate(input: SandboxStartInput): Promise<SandboxRuntime> {
    const { placement, image, apiBaseUrl, accessKey, env } = input;
    const { scopeId, workspaceHostPath, workspaceMountPath, resourceName } = placement;

    const args = [
      "run",
      "-d",
      "--init",
      "--name",
      resourceName,
    ];

    // 传入的 env（由 SandboxRuntimeProvider 构造）
    for (const [key, value] of Object.entries(env)) {
      args.push("-e", `${key}=${value}`);
    }

    // Mount workspace if specified
    if (workspaceHostPath) {
      this.assertSafeMountPath(workspaceHostPath);
      args.push("-v", `${workspaceHostPath}:${workspaceMountPath}`);
    }

    args.push(image);

    const { stdout } = await execFileAsync("docker", args, {
      timeout: DOCKER_RUN_TIMEOUT_MS,
    });
    const containerId = stdout.trim();
    if (!containerId) {
      throw new Error("docker run returned empty container ID");
    }
    this.logger.log(
      `Container started: scopeKey=${scopeId} containerId=${containerId.slice(0, 12)}`
    );
    return {
      engineType: "docker",
      runtimeResourceId: containerId,
      workspaceMountPath,
    };
  }

  async startWorker(
    _runtime: SandboxRuntime,
    _input: SandboxStartInput
  ): Promise<void> {
    // Docker worker 通过容器 entrypoint / CMD 启动，无需额外操作
  }

  async stop(runtimeResourceId: string): Promise<void> {
    try {
      await this.dockerStop(runtimeResourceId);
    } catch (err) {
      this.logger.warn(
        `docker stop failed for ${runtimeResourceId.slice(0, 12)}: ${String(err)}, force killing`
      );
      await this.dockerKill(runtimeResourceId).catch(
        swallow(this.logger, `docker kill ${runtimeResourceId.slice(0, 12)}`)
      );
    }
    // docker rm 清理已停止的容器
    execFileAsync("docker", ["rm", runtimeResourceId]).catch(
      swallow(this.logger, `docker rm ${runtimeResourceId.slice(0, 12)}`)
    );
  }

  async recoverOrphan(runtimeResourceId: string): Promise<void> {
    try {
      await this.dockerStop(runtimeResourceId);
    } catch {
      await this.dockerKill(runtimeResourceId).catch(
        swallow(
          this.logger,
          `recover orphan: docker kill ${runtimeResourceId.slice(0, 12)}`
        )
      );
    }
  }

  private async dockerStop(containerId: string): Promise<void> {
    await execFileAsync("docker", [
      "stop",
      "-t",
      String(DOCKER_STOP_TIMEOUT_S),
      containerId,
    ]);
  }

  private async dockerKill(containerId: string): Promise<void> {
    await execFileAsync("docker", ["kill", containerId]);
  }

  private assertSafeMountPath(hostPath: string): void {
    if (!isAbsolute(hostPath)) {
      throw new Error(`Docker mount path must be absolute: ${hostPath}`);
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter api test docker-sandbox-engine`
Expected: 全部 PASS

---

## Task 4: 实现 OpenSandboxEngine

**Files:**
- Create: `apps/api/src/runtime/providers/opensandbox-sandbox-engine.ts`
- Create: `apps/api/src/runtime/providers/opensandbox-sandbox-engine.spec.ts`

从 `OpenSandboxRuntimeProvider` 的以下方法迁移：
- `getOrCreateSandbox()` → `getOrCreate()`
- `startWorkerInSandbox()` → `startWorker()`
- `shutdownContainerByScopeKey()` 中的 `client.deleteSandbox()` → `stop()`
- `recoverOrphan()` → `recoverOrphan()`

注意：OpenSandbox engine 需要 `OpenSandboxClientLike` 和 `RuntimeBindingService` 作为依赖。

- [ ] **Step 1: 写 OpenSandboxEngine 的失败测试**

```ts
// opensandbox-sandbox-engine.spec.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenSandboxEngine } from "./opensandbox-sandbox-engine";
import type { SandboxStartInput, SandboxPlacement } from "./sandbox-engine";
import type { OpenSandboxClientLike, OpenSandboxSandboxLike } from "./opensandbox-client";

function makeSandboxMock(id: string): OpenSandboxSandboxLike {
  return {
    id,
    runCommand: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    renew: vi.fn().mockResolvedValue(undefined),
    isHealthy: vi.fn().mockResolvedValue(true),
    getEndpointUrl: vi.fn().mockResolvedValue("http://localhost:44772"),
  };
}

function makePlacement(overrides?: Partial<SandboxPlacement>): SandboxPlacement {
  return {
    scope: "workspace",
    scopeId: "ws-1",
    workspaceId: "ws-1",
    workspaceHostPath: "/tmp/workspace",
    workspaceMountPath: "/workspace",
    resourceName: "agework-ws-ws-1",
    isolationScope: "workspace",
    ...overrides,
  };
}

function makeInput(overrides?: Partial<SandboxStartInput>): SandboxStartInput {
  return {
    placement: makePlacement(),
    image: "agework/worker:latest",
    apiBaseUrl: "http://localhost:3000/api/v1",
    accessKey: "test-key",
    env: {},
    metadata: {},
    ...overrides,
  };
}

function makeClient(): OpenSandboxClientLike {
  let nextId = 0;
  return {
    createSandbox: vi.fn().mockImplementation(async () => {
      return makeSandboxMock(`sandbox-${++nextId}`);
    }),
    getSandbox: vi.fn().mockResolvedValue(null),
    deleteSandbox: vi.fn().mockResolvedValue(undefined),
  };
}

describe("OpenSandboxEngine", () => {
  it("getOrCreate creates a sandbox and returns SandboxRuntime", async () => {
    const client = makeClient();
    const engine = new OpenSandboxEngine(client);

    const result = await engine.getOrCreate(makeInput());

    expect(result.engineType).toBe("opensandbox");
    expect(result.runtimeResourceId).toMatch(/^sandbox-/);
    expect(client.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        image: "agework/worker:latest",
        workspaceMountPath: "/workspace",
      })
    );
  });

  it("getOrCreate passes env and metadata to createSandbox", async () => {
    const client = makeClient();
    const engine = new OpenSandboxEngine(client);

    await engine.getOrCreate(makeInput({
      env: {
        RUNTIME_TRANSPORT: "http",
        AGEWORK_WORKSPACE_ID: "ws-1",
      },
      metadata: {
        "agework.io/workspace-id": "ws-1",
      },
    }));

    expect(client.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          RUNTIME_TRANSPORT: "http",
          AGEWORK_WORKSPACE_ID: "ws-1",
        }),
        metadata: expect.objectContaining({
          "agework.io/workspace-id": "ws-1",
        }),
      })
    );
  });

  it("getOrCreate includes workspace volume when hostPath is set", async () => {
    const client = makeClient();
    const engine = new OpenSandboxEngine(client);

    await engine.getOrCreate(makeInput({
      placement: makePlacement({
        workspaceHostPath: "/tmp/workspace",
        workspaceMountPath: "/workspace",
      }),
    }));

    expect(client.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceHostPath: "/tmp/workspace",
        workspaceMountPath: "/workspace",
      })
    );
  });

  it("startWorker runs the worker command in the sandbox", async () => {
    const client = makeClient();
    const engine = new OpenSandboxEngine(client);

    const runtime = await engine.getOrCreate(makeInput());
    await engine.startWorker(runtime, makeInput({
      env: {
        RUNTIME_TRANSPORT: "http",
        AGEWORK_RUNTIME_MODE: "persistent",
        AGEWORK_WORKSPACE_ID: "ws-1",
        PLATFORM_API_BASE: "http://localhost:3000/api/v1",
        AGEWORK_RUNTIME_ACCESS_KEY: "test-key",
        AGEWORK_RUNTIME_ISOLATION_SCOPE: "workspace",
        AGEWORK_RUNTIME_BINDING_ID: "binding-42",
      },
    }));

    const sandboxMock = await (client.createSandbox as ReturnType<typeof vi.fn>).mock.results[0]!.value;
    expect(sandboxMock.runCommand).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        envs: expect.objectContaining({
          AGEWORK_RUNTIME_BINDING_ID: "binding-42",
          AGEWORK_RUNTIME_ISOLATION_SCOPE: "workspace",
        }),
        background: true,
      })
    );
  });

  it("stop deletes the sandbox via client", async () => {
    const client = makeClient();
    const engine = new OpenSandboxEngine(client);

    await engine.stop("sandbox-abc");

    expect(client.deleteSandbox).toHaveBeenCalledWith("sandbox-abc");
  });

  it("recoverOrphan kills the sandbox if it exists", async () => {
    const client = makeClient();
    const sandbox = makeSandboxMock("sandbox-orphan");
    (client.getSandbox as ReturnType<typeof vi.fn>).mockResolvedValue(sandbox);
    const engine = new OpenSandboxEngine(client);

    await engine.recoverOrphan("sandbox-orphan");

    expect(sandbox.kill).toHaveBeenCalled();
  });

  it("recoverOrphan is a no-op if sandbox does not exist", async () => {
    const client = makeClient();
    (client.getSandbox as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const engine = new OpenSandboxEngine(client);

    // 不应抛错
    await engine.recoverOrphan("sandbox-nonexistent");
  });

  it("isHealthy returns true when sandbox is healthy", async () => {
    const client = makeClient();
    const sandbox = makeSandboxMock("sandbox-1");
    (client.getSandbox as ReturnType<typeof vi.fn>).mockResolvedValue(sandbox);
    const engine = new OpenSandboxEngine(client);

    const healthy = await engine.isHealthy!("sandbox-1");
    expect(healthy).toBe(true);
  });

  it("isHealthy returns false when sandbox not found", async () => {
    const client = makeClient();
    (client.getSandbox as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const engine = new OpenSandboxEngine(client);

    const healthy = await engine.isHealthy!("sandbox-gone");
    expect(healthy).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter api test opensandbox-sandbox-engine`
Expected: FAIL — module not found

- [ ] **Step 3: 实现 OpenSandboxEngine**

```ts
// opensandbox-sandbox-engine.ts
import { Logger } from "@nestjs/common";
import { isAbsolute, normalize } from "node:path";
import type { SandboxEngine, SandboxEngineType, SandboxStartInput, SandboxRuntime } from "./sandbox-engine";
import type { OpenSandboxClientLike } from "./opensandbox-client";
import { swallow } from "../../common/swallow";

export class OpenSandboxEngine implements SandboxEngine {
  readonly type: SandboxEngineType = "opensandbox";
  private readonly logger = new Logger(OpenSandboxEngine.name);

  constructor(private readonly client: OpenSandboxClientLike) {}

  async getOrCreate(input: SandboxStartInput): Promise<SandboxRuntime> {
    const { placement, image, apiBaseUrl, accessKey, env, metadata } = input;
    const { workspaceHostPath, workspaceMountPath, scopeId, isolationScope } = placement;

    if (workspaceHostPath) {
      this.assertSafeMountPath(workspaceHostPath);
    }

    const sandbox = await this.client.createSandbox({
      image,
      env: {
        RUNTIME_TRANSPORT: "http",
        PLATFORM_API_BASE: apiBaseUrl,
        AGEWORK_RUNTIME_ACCESS_KEY: accessKey,
        AGEWORK_WORKSPACE_ID: scopeId,
        AGEWORK_RUNTIME_ISOLATION_SCOPE: isolationScope,
        ...env,
      },
      timeoutSeconds: null,
      workspaceHostPath: workspaceHostPath || undefined,
      workspaceMountPath,
      metadata: {
        "agework.io/workspace-id": scopeId,
        "agework.io/scope": `${isolationScope}-${scopeId}`,
        ...metadata,
      },
    });

    this.logger.log(
      `Sandbox created: scopeKey=${scopeId} sandboxId=${sandbox.id.slice(0, 12)}`
    );

    return {
      engineType: "opensandbox",
      runtimeResourceId: sandbox.id,
      workspaceMountPath,
    };
  }

  async startWorker(
    runtime: SandboxRuntime,
    input: SandboxStartInput
  ): Promise<void> {
    const { placement, apiBaseUrl, accessKey, env } = input;
    const { scopeId, isolationScope, workspaceMountPath } = placement;

    try {
      const sandbox = await this.client.getSandbox(runtime.runtimeResourceId);
      if (!sandbox) {
        this.logger.warn(
          `Cannot start worker: sandbox ${runtime.runtimeResourceId.slice(0, 12)} not found`
        );
        return;
      }

      const envs: Record<string, string> = {
        RUNTIME_TRANSPORT: "http",
        AGEWORK_RUNTIME_MODE: "persistent",
        AGEWORK_WORKSPACE_ID: scopeId,
        PLATFORM_API_BASE: apiBaseUrl,
        AGEWORK_API_BASE: apiBaseUrl,
        AGEWORK_RUNTIME_ACCESS_KEY: accessKey,
        AGEWORK_RUNTIME_ISOLATION_SCOPE: isolationScope,
        ...env,
      };

      await sandbox.runCommand("/app/node_modules/.bin/tsx /app/src/main.ts", {
        envs,
        background: true,
        workingDirectory: workspaceMountPath,
      });

      this.logger.log(
        `Started persistent worker in sandbox ${runtime.runtimeResourceId.slice(0, 12)}`
      );
    } catch (err) {
      this.logger.warn(
        `Failed to start worker in sandbox ${runtime.runtimeResourceId.slice(0, 12)}: ${String(err)}. ` +
          `Worker may start via image entrypoint instead.`
      );
    }
  }

  async stop(runtimeResourceId: string): Promise<void> {
    await this.client.deleteSandbox(runtimeResourceId);
  }

  async recoverOrphan(runtimeResourceId: string): Promise<void> {
    try {
      const sandbox = await this.client.getSandbox(runtimeResourceId);
      if (sandbox) {
        await sandbox.kill();
      }
    } catch {
      // sandbox 不存在时静默忽略
    }
  }

  async isHealthy(runtimeResourceId: string): Promise<boolean> {
    try {
      const sandbox = await this.client.getSandbox(runtimeResourceId);
      if (!sandbox) return false;
      return await sandbox.isHealthy();
    } catch {
      return false;
    }
  }

  private assertSafeMountPath(hostPath: string): void {
    if (!isAbsolute(hostPath)) {
      throw new Error(`OpenSandbox mount path must be absolute: ${hostPath}`);
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter api test opensandbox-sandbox-engine`
Expected: 全部 PASS

---

## Task 5: 实现 SandboxRuntimeProvider

**Files:**
- Create: `apps/api/src/runtime/providers/sandbox-runtime-provider.ts`
- Create: `apps/api/src/runtime/providers/sandbox-runtime-provider.spec.ts`

这是最核心的 task。`SandboxRuntimeProvider` 收敛了两个旧 provider 的全部编排逻辑。

**从两个旧 provider 提取的共有逻辑（逐行对照）：**

| 编排逻辑 | DockerRuntimeProvider | OpenSandboxRuntimeProvider | SandboxRuntimeProvider |
|---|---|---|---|
| scope 状态 map | `scopeContainers: Map<string, DockerScopeState>` | `scopeSandboxes: Map<string, OpenSandboxScopeState>` | `scopeStates: Map<string, SandboxScopeState>` |
| pending map | `pendingContainers` | `pendingSandboxes` | `pendingSandboxes` |
| cancelled runs | `cancelledStartingRuns` | `cancelledStartingRuns` | `cancelledStartingRuns` |
| heartbeat watchdog | `HeartbeatWatchdog` | `HeartbeatWatchdog` | `HeartbeatWatchdog` |
| idle watchdog | `IdleWatchdog` | `IdleWatchdog` | `IdleWatchdog` |
| control seqs | `controlSeqs` | `controlSeqs` | `controlSeqs` |
| workspace→scopeKey | `workspaceToScopeKey` | `workspaceToScopeKey` | `workspaceToScopeKey` |
| start() 编排 | access key / config register / pending 复用 / cancel 检查 | access key / config register / pending 复用 / cancel 检查 | 统一 |
| handleIdle | stop container + mark stopped + revoke | delete sandbox + mark stopped + revoke | 委托 engine.stop() + mark stopped + revoke |
| shutdownContainer | stop container + cleanup | delete sandbox + cleanup | 委托 engine.stop() + cleanup |

**关键差异点（由 engine 处理）：**
- Docker: `startContainer()` → `docker run -d --init --name ...`
- OpenSandbox: `getOrCreateSandbox()` → `client.createSandbox()` + `startWorkerInSandbox()` + DB binding 恢复
- Docker idle stop: `stopContainerOrKill()` + `dockerRm()`
- OpenSandbox idle stop: `client.deleteSandbox()`
- Docker recover: `docker stop/kill`
- OpenSandbox recover: `client.getSandbox()` + `sandbox.kill()`

**OpenSandbox 特有的 DB binding 恢复逻辑** (`getOrCreateSandbox` 中的 `findActiveByScope` + `getSandbox` + `markStopped` 验证) 需要在 `SandboxRuntimeProvider` 中处理。方案：在 `SandboxRuntimeProvider.start()` 的 "首次创建" 分支中，如果 engine 是 `OpenSandboxEngine`，先尝试 DB binding 恢复。但这样会让编排层重新耦合 engine 类型判断。

**更好的方案：** 让 `OpenSandboxEngine.getOrCreate()` 内部处理 DB binding 恢复逻辑。它需要 `RuntimeBindingService` 作为依赖。`DockerSandboxEngine.getOrCreate()` 不做 DB 恢复（Docker 靠内存状态判断容器是否存在，且 API 重启后容器 ID 失效）。

- [ ] **Step 1: 写 SandboxRuntimeProvider 的失败测试**

```ts
// sandbox-runtime-provider.spec.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SandboxRuntimeProvider } from "./sandbox-runtime-provider";
import type { SandboxEngine, SandboxRuntime } from "./sandbox-engine";
import type { RuntimePlacement, RuntimeIsolationScope } from "@agework/shared/protocol";

// ── Mock engine ──────────────────────────────────────────────────────

function makeMockEngine(type: "docker" | "opensandbox"): SandboxEngine {
  let nextId = 0;
  return {
    type,
    getOrCreate: vi.fn().mockImplementation(async () => ({
      engineType: type,
      runtimeResourceId: `${type}-resource-${++nextId}`,
      workspaceMountPath: "/workspace",
    })),
    startWorker: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    recoverOrphan: vi.fn().mockResolvedValue(undefined),
  };
}

// ── Shared mock deps ─────────────────────────────────────────────────

function makeProvider(engineOverride?: SandboxEngine) {
  const engine = engineOverride ?? makeMockEngine("docker");
  const eventProcessor = {
    forceErrorStatus: vi.fn().mockResolvedValue(undefined),
    forceCancelledStatus: vi.fn().mockResolvedValue(undefined),
    isTerminalOrFinalizing: vi.fn().mockReturnValue(false),
  };
  const configStore = { register: vi.fn(), unregister: vi.fn() };
  const access = {
    issueWorkspaceKey: vi.fn().mockReturnValue("ws-key"),
    issueRuntimeBindingKey: vi.fn().mockReturnValue("binding-key"),
    registerRun: vi.fn(),
    revokeWorkspace: vi.fn(),
    revokeAccess: vi.fn(),
  };
  const controlQueue = {
    pushForWorkspace: vi.fn(),
    cleanupWorkspace: vi.fn(),
    cleanup: vi.fn(),
  };
  const config = {
    getWorkerImage: vi.fn().mockReturnValue("agework/worker:latest"),
    getIdleTimeoutSeconds: vi.fn().mockReturnValue(1800),
    getSandboxEngine: vi.fn().mockReturnValue("docker"),
  };
  const runtimeBindingService = {
    markStopped: vi.fn().mockResolvedValue(undefined),
    upsertRunning: vi.fn().mockResolvedValue({ id: "binding-1" }),
    findActiveByScope: vi.fn().mockResolvedValue(null),
  };

  const provider = new SandboxRuntimeProvider(
    eventProcessor as never,
    configStore as never,
    access as never,
    controlQueue as never,
    config as never,
    runtimeBindingService as never,
    [engine]
  );

  return {
    provider, engine, access, controlQueue, configStore, eventProcessor,
    config, runtimeBindingService,
  };
}

const baseRun = {
  runId: "run-1",
  conversationId: "conversation-1",
  workspaceId: "ws-1",
  runtimePath: "/workspace",
  agentType: "claude",
  env: {},
  input: {},
  adapter: { kind: "claude" as const, isEnvironmentConfig: false },
};

function makePlacement(overrides?: Partial<RuntimePlacement> & { sandboxEngineType?: string }): RuntimePlacement & { sandboxEngineType?: string } {
  return {
    runtimeType: "sandbox",
    isolationScope: "workspace" as RuntimeIsolationScope,
    scopeId: "ws-1",
    userId: "user-1",
    workspaceId: "ws-1",
    hostPath: "/tmp/workspace",
    runtimePath: "/workspace",
    mountTarget: "/workspace",
    resourceName: "agework-ws-ws-1",
    sandboxEngineType: "docker",
    ...overrides,
  };
}

// ── Workspace-scoped tests ───────────────────────────────────────────

describe("SandboxRuntimeProvider — workspace scope", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("starts a sandbox for the first run and returns handle with runtimeType=sandbox", async () => {
    const { provider } = makeProvider();
    const handle = provider.start(baseRun as never, makePlacement() as never);
    await vi.runOnlyPendingTimersAsync();

    expect(handle.runtimeType).toBe("sandbox");
    expect(handle.runId).toBe("run-1");
    expect(handle.conversationId).toBe("conversation-1");
  });

  it("delegates to engine.getOrCreate for the first run", async () => {
    const { provider, engine } = makeProvider();
    provider.start(baseRun as never, makePlacement() as never);
    await vi.runOnlyPendingTimersAsync();

    expect(engine.getOrCreate).toHaveBeenCalledTimes(1);
    expect(engine.getOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        placement: expect.objectContaining({ scopeId: "ws-1" }),
      })
    );
  });

  it("delegates to engine.startWorker after getOrCreate", async () => {
    const { provider, engine } = makeProvider();
    provider.start(baseRun as never, makePlacement() as never);
    await vi.runOnlyPendingTimersAsync();

    expect(engine.startWorker).toHaveBeenCalledTimes(1);
  });

  it("registers RunConfig and pushes user_message control", async () => {
    const { provider, configStore, controlQueue } = makeProvider();
    provider.start(baseRun as never, makePlacement() as never);
    await vi.runOnlyPendingTimersAsync();

    expect(configStore.register).toHaveBeenCalledWith("run-1", expect.anything());
    expect(controlQueue.pushForWorkspace).toHaveBeenCalledWith(
      "ws-1",
      expect.objectContaining({
        runId: "run-1",
        payload: expect.objectContaining({
          type: "user_message",
          runId: "run-1",
        }),
      })
    );
  });

  it("reuses the existing sandbox for a second run (no second getOrCreate)", async () => {
    const { provider, engine, controlQueue } = makeProvider();
    provider.start(baseRun as never, makePlacement() as never);
    await vi.runOnlyPendingTimersAsync();

    provider.start({
      ...baseRun, runId: "run-2", conversationId: "conversation-2",
    } as never, makePlacement() as never);
    await vi.runOnlyPendingTimersAsync();

    expect(engine.getOrCreate).toHaveBeenCalledTimes(1);
    expect(controlQueue.pushForWorkspace).toHaveBeenCalledTimes(2);
  });

  it("reports error when engine.getOrCreate fails", async () => {
    const engine = makeMockEngine("docker");
    (engine.getOrCreate as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("engine unavailable")
    );
    const { provider, eventProcessor } = makeProvider(engine);

    provider.start(baseRun as never, makePlacement() as never);
    await vi.runOnlyPendingTimersAsync();

    expect(eventProcessor.forceErrorStatus).toHaveBeenCalledWith(
      "run-1",
      expect.stringContaining("engine unavailable")
    );
  });

  it("cancel does not stop the sandbox", async () => {
    const { provider, engine } = makeProvider();
    const handle = provider.start(baseRun as never, makePlacement() as never);
    await vi.runOnlyPendingTimersAsync();

    provider.cancel(handle);
    expect(engine.stop).not.toHaveBeenCalled();
  });

  it("cancel sends a cancel control via control queue", async () => {
    const { provider, controlQueue } = makeProvider();
    const handle = provider.start(baseRun as never, makePlacement() as never);
    await vi.runOnlyPendingTimersAsync();

    provider.cancel(handle);
    expect(controlQueue.pushForWorkspace).toHaveBeenCalledWith(
      "ws-1",
      expect.objectContaining({
        payload: expect.objectContaining({
          type: "cancel",
          runId: "run-1",
          conversationId: "conversation-1",
        }),
      })
    );
  });

  it("cancel during sandbox startup publishes cancelled status immediately", async () => {
    const engine = makeMockEngine("docker");
    let resolveGetOrCreate: (value: SandboxRuntime) => void;
    (engine.getOrCreate as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<SandboxRuntime>((resolve) => { resolveGetOrCreate = resolve; })
    );
    const { provider, eventProcessor } = makeProvider(engine);

    const handle = provider.start(baseRun as never, makePlacement() as never);
    provider.cancel(handle);

    resolveGetOrCreate!({
      engineType: "docker",
      runtimeResourceId: "resource-1",
      workspaceMountPath: "/workspace",
    });
    await vi.runOnlyPendingTimersAsync();
    await Promise.resolve();

    expect(eventProcessor.forceCancelledStatus).toHaveBeenCalledWith("run-1");
  });

  it("cleanup revokes per-run access without stopping sandbox", async () => {
    const { provider, access, engine } = makeProvider();
    provider.start(baseRun as never, makePlacement() as never);
    await vi.runOnlyPendingTimersAsync();

    provider.cleanup("run-1");
    expect(access.revokeAccess).toHaveBeenCalledWith("run-1");
    expect(engine.stop).not.toHaveBeenCalled();
  });

  it("shutdownContainer stops sandbox via engine and revokes workspace key", async () => {
    const { provider, engine, access } = makeProvider();
    provider.start(baseRun as never, makePlacement() as never);
    await vi.runOnlyPendingTimersAsync();

    provider.shutdownContainer("ws-1");
    expect(engine.stop).toHaveBeenCalled();
    expect(access.revokeWorkspace).toHaveBeenCalledWith("ws-1");
  });

  it("heartbeat feeds the heartbeat watchdog", async () => {
    const { provider } = makeProvider();
    provider.start(baseRun as never, makePlacement() as never);
    await vi.runOnlyPendingTimersAsync();

    // 心跳不应抛错
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(5_000);
      provider.heartbeat("run-1");
    }
  });

  it("stops sandbox after 60s without heartbeat", async () => {
    const { provider, engine } = makeProvider();
    provider.start(baseRun as never, makePlacement() as never);
    await vi.runOnlyPendingTimersAsync();

    await vi.advanceTimersByTimeAsync(65_000);
    expect(engine.stop).toHaveBeenCalled();
  });

  it("getHandle returns handle with runtimeType=sandbox", async () => {
    const { provider } = makeProvider();
    provider.start(baseRun as never, makePlacement() as never);
    await vi.runOnlyPendingTimersAsync();

    const handle = provider.getHandle("run-1");
    expect(handle).toBeDefined();
    expect(handle!.runtimeType).toBe("sandbox");
  });

  it("upserts RuntimeBinding after sandbox creation", async () => {
    const { provider, runtimeBindingService } = makeProvider();
    provider.start(baseRun as never, makePlacement() as never);
    await vi.runOnlyPendingTimersAsync();

    expect(runtimeBindingService.upsertRunning).toHaveBeenCalledWith(
      expect.objectContaining({ runtimeType: "sandbox" }),
      expect.any(String)
    );
  });
});

// ── User-scoped tests ────────────────────────────────────────────────

describe("SandboxRuntimeProvider — user scope", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const userPlacement = makePlacement({
    isolationScope: "user",
    scopeId: "user-1",
    userId: "user-1",
    hostPath: "/tmp/workspace",
    runtimePath: "/workspaces",
    mountTarget: "/workspaces",
    resourceName: "agework-user-user-1",
  });

  it("same user, different workspaces → reuses the same sandbox", async () => {
    const { provider, engine, controlQueue } = makeProvider();

    provider.start(
      { ...baseRun, runId: "run-1", workspaceId: "ws-1" } as never,
      userPlacement as never
    );
    await vi.runOnlyPendingTimersAsync();

    provider.start(
      { ...baseRun, runId: "run-2", conversationId: "conv-2", workspaceId: "ws-2" } as never,
      { ...userPlacement, workspaceId: "ws-2" } as never
    );
    await vi.runOnlyPendingTimersAsync();

    expect(engine.getOrCreate).toHaveBeenCalledTimes(1);
    expect(controlQueue.pushForWorkspace).toHaveBeenCalledTimes(2);
  });

  it("different users → no reuse, separate sandboxes", async () => {
    const { provider, engine } = makeProvider();

    provider.start(
      { ...baseRun, runId: "run-1", workspaceId: "ws-1" } as never,
      userPlacement as never
    );
    await vi.runOnlyPendingTimersAsync();

    provider.start(
      { ...baseRun, runId: "run-2", conversationId: "conv-2", workspaceId: "ws-2" } as never,
      { ...userPlacement, scopeId: "user-2", userId: "user-2", workspaceId: "ws-2", resourceName: "agework-user-user-2" } as never
    );
    await vi.runOnlyPendingTimersAsync();

    expect(engine.getOrCreate).toHaveBeenCalledTimes(2);
  });

  it("heartbeatScope feeds the heartbeat watchdog for user scope", async () => {
    const { provider } = makeProvider();

    provider.start(
      { ...baseRun, runId: "run-1", workspaceId: "ws-1" } as never,
      userPlacement as never
    );
    await vi.runOnlyPendingTimersAsync();

    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(25_000);
      provider.heartbeatScope("user-1");
    }
  });

  it("shutdownContainer for user scope tears down the shared user sandbox", async () => {
    const { provider, engine, runtimeBindingService } = makeProvider();

    provider.start(
      { ...baseRun, runId: "run-1", workspaceId: "ws-1" } as never,
      userPlacement as never
    );
    await vi.runOnlyPendingTimersAsync();
    provider.shutdownContainer("user-1");

    expect(engine.stop).toHaveBeenCalled();
    expect(runtimeBindingService.markStopped).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeType: "sandbox",
        isolationScope: "user",
        scopeId: "user-1",
      })
    );
  });
});

// ── Idle stop tests ──────────────────────────────────────────────────

describe("SandboxRuntimeProvider — idle stop", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("starts idle timer when all runs finish (cleanup)", async () => {
    const { provider, engine, config } = makeProvider();
    config.getIdleTimeoutSeconds.mockReturnValue(10);

    provider.start(baseRun as never, makePlacement() as never);
    await vi.runOnlyPendingTimersAsync();

    provider.cleanup("run-1");
    await vi.advanceTimersByTimeAsync(10_500);

    expect(engine.stop).toHaveBeenCalled();
  });

  it("cancels idle timer when a new run starts before timeout", async () => {
    const { provider, engine, config } = makeProvider();
    config.getIdleTimeoutSeconds.mockReturnValue(10);

    provider.start(baseRun as never, makePlacement() as never);
    await vi.runOnlyPendingTimersAsync();

    provider.cleanup("run-1");
    vi.advanceTimersByTime(5_000);

    provider.start({
      ...baseRun, runId: "run-2", conversationId: "conv-2",
    } as never, makePlacement() as never);
    await vi.runOnlyPendingTimersAsync();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(engine.stop).not.toHaveBeenCalled();
  });

  it("after idle timeout, marks binding stopped and resets runtimeResourceId", async () => {
    const { provider, config, runtimeBindingService, access } = makeProvider();
    config.getIdleTimeoutSeconds.mockReturnValue(5);

    provider.start(baseRun as never, makePlacement() as never);
    await vi.runOnlyPendingTimersAsync();

    provider.cleanup("run-1");
    await vi.advanceTimersByTimeAsync(5_500);

    expect(runtimeBindingService.markStopped).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeType: "sandbox",
        isolationScope: "workspace",
        scopeId: "ws-1",
      })
    );
    expect(access.revokeWorkspace).toHaveBeenCalledWith("ws-1");
    expect(provider.getStateByWorkspaceId("ws-1")).toBeUndefined();
  });

  it("next run after idle stop recreates the sandbox", async () => {
    const { provider, engine, config } = makeProvider();
    config.getIdleTimeoutSeconds.mockReturnValue(5);

    provider.start(baseRun as never, makePlacement() as never);
    await vi.runOnlyPendingTimersAsync();

    provider.cleanup("run-1");
    await vi.advanceTimersByTimeAsync(5_500);

    const getOrCreateCallsBefore = (engine.getOrCreate as ReturnType<typeof vi.fn>).mock.calls.length;

    provider.start({
      ...baseRun, runId: "run-2", conversationId: "conv-2",
    } as never, makePlacement() as never);
    await vi.runOnlyPendingTimersAsync();

    const getOrCreateCallsAfter = (engine.getOrCreate as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(getOrCreateCallsAfter).toBe(getOrCreateCallsBefore + 1);
  });

  it("does not start idle timer if activeRuns still has entries", async () => {
    const { provider, engine, config } = makeProvider();
    config.getIdleTimeoutSeconds.mockReturnValue(5);

    provider.start(baseRun as never, makePlacement() as never);
    await vi.runOnlyPendingTimersAsync();

    provider.start({
      ...baseRun, runId: "run-2", conversationId: "conv-2",
    } as never, makePlacement() as never);
    await vi.runOnlyPendingTimersAsync();

    provider.cleanup("run-1");
    await vi.advanceTimersByTimeAsync(6_000);

    expect(engine.stop).not.toHaveBeenCalled();
  });
});

// ── recoverOrphan tests ──────────────────────────────────────────────

describe("SandboxRuntimeProvider.recoverOrphan", () => {
  it("delegates to engine.recoverOrphan", async () => {
    const { provider, engine } = makeProvider();
    await provider.recoverOrphan("resource-abc");
    expect(engine.recoverOrphan).toHaveBeenCalledWith("resource-abc");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter api test sandbox-runtime-provider`
Expected: FAIL — module not found

- [ ] **Step 3: 实现 SandboxRuntimeProvider**

```ts
// sandbox-runtime-provider.ts
import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type {
  RuntimeProvider,
  RuntimeHandle,
  RunConfig,
  RuntimePlacement,
  RuntimeIsolationScope,
  ControlPayload,
} from "@agework/shared/protocol";
import { RuntimeEventProcessor } from "../core/runtime-event-processor";
import { RuntimeConfigStore } from "../internal/runtime-config-store";
import { RuntimeInternalAccessService } from "../internal/runtime-internal-access.service";
import { RuntimeControlQueue } from "../internal/runtime-control-queue";
import { ConfigService } from "../../config/config.service";
import { RuntimeBindingService } from "../core/runtime-binding.service";
import { swallow } from "../../common/swallow";
import {
  HeartbeatWatchdog,
  IdleWatchdog,
  nextControlEnvelope,
  publishWorkerErrorStatus,
  resolveDockerApiBase,
} from "./runtime-provider-utils";
import type { SandboxEngine, SandboxEngineType, SandboxStartInput, SandboxPlacement, SandboxRuntime } from "./sandbox-engine";

type SandboxScopeState = {
  runtimeResourceId: string;
  accessKey: string;
  activeRuns: Map<string, string>; // runId → conversationId
  isolationScope: RuntimeIsolationScope;
  engineType: SandboxEngineType;
};

@Injectable()
export class SandboxRuntimeProvider implements RuntimeProvider {
  readonly type = "sandbox" as const;
  private readonly logger = new Logger(SandboxRuntimeProvider.name);

  private readonly scopeStates = new Map<string, SandboxScopeState>();
  private readonly pendingSandboxes = new Map<string, Promise<SandboxRuntime>>();
  private readonly cancelledStartingRuns = new Set<string>();
  private readonly heartbeats = new HeartbeatWatchdog();
  private readonly idleWatchdog = new IdleWatchdog();
  private readonly controlSeqs = new Map<string, number>();
  private readonly workspaceToScopeKey = new Map<string, string>();

  private readonly engines: Map<SandboxEngineType, SandboxEngine>;

  constructor(
    private readonly runEventProcessor: RuntimeEventProcessor,
    private readonly runConfigStore: RuntimeConfigStore,
    private readonly runtimeAccess: RuntimeInternalAccessService,
    private readonly controlQueue: RuntimeControlQueue,
    private readonly configService: ConfigService,
    private readonly runtimeBindingService: RuntimeBindingService,
    engines: SandboxEngine[]
  ) {
    this.engines = new Map(engines.map((e) => [e.type, e]));
  }

  start(
    runConfig: RunConfig,
    placement: RuntimePlacement & { sandboxEngineType?: SandboxEngineType },
    onRuntimeResourceIdReady?: (runtimeResourceId: string) => void
  ): RuntimeHandle {
    const { runId, workspaceId } = runConfig;
    const { isolationScope, scopeId, hostPath, mountTarget, resourceName } = placement;
    const scopeKey = scopeId;
    const engineType = placement.sandboxEngineType ?? this.configService.getSandboxEngine();
    const engine = this.resolveEngine(engineType);
    const apiBase = resolveDockerApiBase();
    const image = this.configService.getWorkerImage();

    this.runConfigStore.register(runId, runConfig);

    const handle: RuntimeHandle = {
      runId,
      runtimeType: "sandbox",
      runtimeResourceId: "",
      conversationId: runConfig.conversationId,
    };

    this.workspaceToScopeKey.set(workspaceId, scopeKey);

    let scopeState = this.scopeStates.get(scopeKey);
    if (!scopeState) {
      const accessKey = this.runtimeAccess.issueWorkspaceKey(scopeKey);
      scopeState = {
        runtimeResourceId: "",
        accessKey,
        activeRuns: new Map(),
        isolationScope,
        engineType,
      };
      this.scopeStates.set(scopeKey, scopeState);
    } else if (!scopeState.runtimeResourceId && !this.pendingSandboxes.has(scopeKey)) {
      scopeState.accessKey = this.runtimeAccess.issueWorkspaceKey(scopeKey);
    }

    this.runtimeAccess.registerRun(runId, scopeState.accessKey);
    scopeState.activeRuns.set(runId, runConfig.conversationId);
    this.idleWatchdog.cancel(scopeKey);

    if (!this.controlSeqs.has(scopeKey)) {
      this.controlSeqs.set(scopeKey, 0);
    }

    this.pushScopeControl(scopeKey, runId, {
      type: "user_message",
      commandId: randomUUID(),
      runId,
      input: runConfig.input,
    });

    const existingPending = this.pendingSandboxes.get(scopeKey);
    if (scopeState.runtimeResourceId) {
      handle.runtimeResourceId = scopeState.runtimeResourceId;
    } else if (existingPending) {
      void existingPending
        .then((runtime) => {
          if (this.cancelledStartingRuns.delete(runId)) {
            this.scopeStates.get(scopeKey)?.activeRuns.delete(runId);
            this.forceCancelled(runId);
            return;
          }
          handle.runtimeResourceId = runtime.runtimeResourceId;
          onRuntimeResourceIdReady?.(runtime.runtimeResourceId);
        })
        .catch((err) => {
          publishWorkerErrorStatus(
            this.runEventProcessor,
            runId,
            `sandbox create failed: ${String(err)}`
          );
        });
    } else {
      const sandboxPlacement: SandboxPlacement = {
        scope: isolationScope,
        scopeId,
        workspaceId,
        workspaceHostPath: hostPath,
        workspaceMountPath: mountTarget,
        resourceName,
        isolationScope,
      };
      const engineInput: SandboxStartInput = {
        placement: sandboxPlacement,
        image,
        apiBaseUrl: apiBase,
        accessKey: scopeState.accessKey,
        env: {
          RUNTIME_TRANSPORT: "http",
          PLATFORM_API_BASE: apiBase,
          AGEWORK_RUNTIME_ACCESS_KEY: scopeState.accessKey,
          AGEWORK_WORKSPACE_ID: scopeKey,
        },
        metadata: {
          "agework.io/workspace-id": scopeKey,
          "agework.io/scope": `${isolationScope}-${scopeKey}`,
        },
      };

      const runtimePromise = this.createSandbox(scopeKey, engine, engineInput, placement, runId);
      this.pendingSandboxes.set(scopeKey, runtimePromise);

      void runtimePromise
        .then((runtime) => {
          this.pendingSandboxes.delete(scopeKey);
          const state = this.scopeStates.get(scopeKey);
          if (!state) return;

          state.runtimeResourceId = runtime.runtimeResourceId;
          this.logger.log(
            `Sandbox created: scopeKey=${scopeKey} engine=${runtime.engineType} resourceId=${runtime.runtimeResourceId.slice(0, 12)}`
          );

          this.runtimeBindingService
            .upsertRunning(placement, runtime.runtimeResourceId)
            .then((binding) => {
              this.runtimeAccess.issueRuntimeBindingKey(binding.id, scopeKey);
            })
            .catch(swallow(this.logger, `upsert sandbox binding for scope ${scopeKey}`));

          for (const cancelledRunId of this.cancelledStartingRuns) {
            if (state.activeRuns.has(cancelledRunId)) {
              state.activeRuns.delete(cancelledRunId);
              this.forceCancelled(cancelledRunId);
              this.cancelledStartingRuns.delete(cancelledRunId);
            }
          }

          if (this.cancelledStartingRuns.delete(runId)) {
            state.activeRuns.delete(runId);
            this.forceCancelled(runId);
          } else {
            handle.runtimeResourceId = runtime.runtimeResourceId;
            onRuntimeResourceIdReady?.(runtime.runtimeResourceId);
          }

          this.heartbeats.start(scopeKey, () => {
            this.logger.error(
              `Heartbeat timeout for scopeKey=${scopeKey}, stopping sandbox`
            );
            engine.stop(runtime.runtimeResourceId).catch(
              swallow(this.logger, `stop sandbox ${runtime.runtimeResourceId.slice(0, 12)}`)
            );
            const activeRuns = this.scopeStates.get(scopeKey)?.activeRuns;
            const targetRunIds = activeRuns?.size
              ? [...activeRuns.keys()]
              : [runId];
            this.shutdownContainerByScopeKey(scopeKey);
            for (const rid of targetRunIds) {
              publishWorkerErrorStatus(
                this.runEventProcessor,
                rid,
                "worker heartbeat timeout"
              );
            }
          });
        })
        .catch((err) => {
          this.pendingSandboxes.delete(scopeKey);
          this.logger.error(
            `Failed to create sandbox for scopeKey=${scopeKey}: ${String(err)}`
          );
          publishWorkerErrorStatus(
            this.runEventProcessor,
            runId,
            `sandbox create failed: ${String(err)}`
          );
          this.scopeStates.delete(scopeKey);
          this.controlSeqs.delete(scopeKey);
          this.controlQueue.cleanupWorkspace(scopeKey);
        });
    }

    return handle;
  }

  sendControl(handle: RuntimeHandle, control: ControlPayload): void {
    const scopeKey = this.findScopeKeyByRun(handle.runId);
    if (!scopeKey) return;
    this.pushScopeControl(scopeKey, handle.runId, control);
  }

  cancel(handle: RuntimeHandle): void {
    const scopeKey = this.findScopeKeyByRun(handle.runId);
    const scopeState = scopeKey ? this.scopeStates.get(scopeKey) : undefined;
    if (!scopeState?.runtimeResourceId) {
      this.cancelledStartingRuns.add(handle.runId);
      return;
    }
    this.sendControl(handle, {
      type: "cancel",
      commandId: randomUUID(),
      runId: handle.runId,
      conversationId: handle.conversationId,
    });
  }

  getHandle(runId: string): RuntimeHandle | undefined {
    const scopeKey = this.findScopeKeyByRun(runId);
    if (!scopeKey) return undefined;
    const state = this.scopeStates.get(scopeKey);
    if (!state) return undefined;
    return {
      runId,
      runtimeType: "sandbox",
      runtimeResourceId: state.runtimeResourceId,
      conversationId: state.activeRuns.get(runId) ?? "",
    };
  }

  heartbeat(runId: string): void {
    const scopeKey = this.findScopeKeyByRun(runId);
    if (!scopeKey) return;
    this.heartbeats.beat(scopeKey);
  }

  getStateByWorkspaceId(workspaceId: string): { runtimeResourceId: string } | undefined {
    const scopeKey = this.workspaceToScopeKey.get(workspaceId);
    if (!scopeKey) return undefined;
    const state = this.scopeStates.get(scopeKey);
    if (!state || !state.runtimeResourceId) return undefined;
    return { runtimeResourceId: state.runtimeResourceId };
  }

  heartbeatWorkspace(workspaceId: string): void {
    const scopeKey = this.workspaceToScopeKey.get(workspaceId);
    if (!scopeKey) return;
    this.heartbeats.beat(scopeKey);
  }

  heartbeatScope(scopeKey: string): void {
    this.heartbeats.beat(scopeKey);
  }

  shutdownContainer(scopeId: string): void {
    this.shutdownContainerByScopeKey(scopeId);
  }

  async recoverOrphan(runtimeResourceId: string): Promise<void> {
    // 尝试所有 engine（因为不知道 resource 属于哪个 engine）
    for (const engine of this.engines.values()) {
      await engine.recoverOrphan(runtimeResourceId).catch(
        swallow(this.logger, `recover orphan via ${engine.type} engine`)
      );
    }
  }

  cleanup(runId: string): void {
    const scopeKey = this.findScopeKeyByRun(runId);
    if (scopeKey) {
      this.scopeStates.get(scopeKey)?.activeRuns.delete(runId);
      const state = this.scopeStates.get(scopeKey);
      if (state && state.activeRuns.size === 0 && state.runtimeResourceId) {
        const idleTimeoutMs = this.configService.getIdleTimeoutSeconds() * 1000;
        this.idleWatchdog.start(scopeKey, idleTimeoutMs, () =>
          this.handleIdle(scopeKey)
        );
      }
    }
    this.runConfigStore.unregister(runId);
    this.controlQueue.cleanup(runId);
    this.runtimeAccess.revokeAccess(runId);
  }

  // ── Private helpers ──────────────────────────────────────────────────

  private async createSandbox(
    scopeKey: string,
    engine: SandboxEngine,
    input: SandboxStartInput,
    placement: RuntimePlacement,
    _runId: string
  ): Promise<SandboxRuntime> {
    const runtime = await engine.getOrCreate(input);
    await engine.startWorker(runtime, input);
    return runtime;
  }

  private shutdownContainerByScopeKey(scopeKey: string): void {
    const state = this.scopeStates.get(scopeKey);
    this.heartbeats.stop(scopeKey);
    this.idleWatchdog.cancel(scopeKey);
    if (state?.runtimeResourceId) {
      const engine = this.engines.get(state.engineType);
      engine?.stop(state.runtimeResourceId).catch(
        swallow(this.logger, `stop sandbox for scope ${scopeKey}`)
      );
    }
    if (state) {
      const syntheticPlacement: RuntimePlacement = {
        runtimeType: "sandbox",
        isolationScope: state.isolationScope,
        scopeId: scopeKey,
        userId: "",
        workspaceId: "",
        hostPath: "",
        runtimePath: "",
        mountTarget: "",
        resourceName: "",
      };
      this.runtimeBindingService
        .markStopped(syntheticPlacement)
        .catch(
          swallow(this.logger, `mark sandbox binding stopped for scope ${scopeKey}`)
        );
    }
    this.runtimeAccess.revokeWorkspace(scopeKey);
    this.controlQueue.cleanupWorkspace(scopeKey);
    this.controlSeqs.delete(scopeKey);
    this.scopeStates.delete(scopeKey);
    this.pendingSandboxes.delete(scopeKey);
    for (const [wsId, key] of this.workspaceToScopeKey) {
      if (key === scopeKey) this.workspaceToScopeKey.delete(wsId);
    }
  }

  private handleIdle(scopeKey: string): void {
    const state = this.scopeStates.get(scopeKey);
    if (!state || !state.runtimeResourceId) return;
    if (state.activeRuns.size > 0) return;

    this.logger.log(
      `Idle timeout for scopeKey=${scopeKey}, stopping sandbox ${state.runtimeResourceId.slice(0, 12)}`
    );

    const engine = this.engines.get(state.engineType);
    engine?.stop(state.runtimeResourceId).catch(
      swallow(this.logger, `stop idle sandbox for scope ${scopeKey}`)
    );

    this.heartbeats.stop(scopeKey);
    state.runtimeResourceId = "";
    this.runtimeAccess.revokeWorkspace(scopeKey);

    const syntheticPlacement: RuntimePlacement = {
      runtimeType: "sandbox",
      isolationScope: state.isolationScope,
      scopeId: scopeKey,
      userId: "",
      workspaceId: "",
      hostPath: "",
      runtimePath: "",
      mountTarget: "",
      resourceName: "",
    };
    this.runtimeBindingService
      .markStopped(syntheticPlacement)
      .catch(
        swallow(this.logger, `mark sandbox binding stopped for idle scope ${scopeKey}`)
      );
  }

  private resolveEngine(engineType: SandboxEngineType): SandboxEngine {
    const engine = this.engines.get(engineType);
    if (!engine) {
      throw new Error(`Unknown sandbox engine: ${engineType}`);
    }
    return engine;
  }

  private findScopeKeyByRun(runId: string): string | undefined {
    for (const [scopeKey, state] of this.scopeStates) {
      if (state.activeRuns.has(runId)) return scopeKey;
    }
    return undefined;
  }

  private pushScopeControl(
    scopeKey: string,
    runId: string,
    control: ControlPayload
  ): void {
    const envelope = nextControlEnvelope(
      this.controlSeqs,
      scopeKey,
      runId,
      control
    );
    this.controlQueue.pushForWorkspace(scopeKey, envelope);
  }

  private forceCancelled(runId: string): void {
    if (this.runEventProcessor.isTerminalOrFinalizing(runId)) return;
    this.runEventProcessor
      .forceCancelledStatus(runId)
      .catch(swallow(this.logger, `force cancelled status for run ${runId}`));
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter api test sandbox-runtime-provider`
Expected: 全部 PASS

---

## Task 6: ConfigService 新增 getSandboxEngine()

**Files:**
- Modify: `apps/api/src/config/config.service.ts`

- [ ] **Step 1: 在 ConfigService 中新增 `getSandboxEngine()` 方法**

在 `getDefaultRuntimeProviderType()` 方法之后添加：

```ts
/**
 * 新建 sandbox workspace 时的默认引擎。
 * A 阶段：当 RUNTIME_PROVIDER 为 docker/opensandbox 时，映射为对应 engine；
 * 也支持直接设置 SANDBOX_ENGINE=docker|opensandbox。
 */
getSandboxEngine(): "docker" | "opensandbox" {
  const explicit = process.env.SANDBOX_ENGINE;
  if (explicit === "docker" || explicit === "opensandbox") return explicit;
  // 向后兼容：从 RUNTIME_PROVIDER 映射
  const provider = this.getDefaultRuntimeProviderType();
  if (provider === "docker") return "docker";
  if (provider === "opensandbox") return "opensandbox";
  return "docker"; // 默认
}
```

- [ ] **Step 2: 运行类型检查**

Run: `pnpm --filter api typecheck`
Expected: 通过

---

## Task 7: 修改 RuntimePlacement — 携带 sandboxEngineType

**Files:**
- Modify: `packages/shared/src/protocol/transport.ts`
- Modify: `apps/api/src/runtime/core/runtime-placement.service.ts`
- Modify: `apps/api/src/runtime/core/runtime-placement.service.spec.ts`

- [ ] **Step 1: 在 RuntimePlacement 类型中新增 `sandboxEngineType` 可选字段**

在 `packages/shared/src/protocol/transport.ts` 的 `RuntimePlacement` 类型中新增：

```ts
export type RuntimePlacement = {
  runtimeType: string;
  isolationScope: RuntimeIsolationScope;
  scopeId: string;
  userId: string;
  workspaceId: string;
  hostPath: string;
  runtimePath: string;
  /** 容器/沙箱内 hostPath 的挂载目标路径（如 `/workspace` 或 `/workspaces`）。 */
  mountTarget: string;
  /** 容器/沙箱资源名（如 `agework-ws-{workspaceId}` 或 `agework-user-{userId}`）。 */
  resourceName: string;
  /** sandbox engine 类型，仅 runtimeType="sandbox" 时有值。 */
  sandboxEngineType?: "docker" | "opensandbox";
};
```

- [ ] **Step 2: 修改 RuntimePlacementService — docker/opensandbox 映射为 "sandbox"**

```ts
// runtime-placement.service.ts — 完整替换
import { Injectable } from "@nestjs/common";
import { isAbsolute, relative, sep } from "node:path";
import type { RuntimePlacement } from "@agework/shared/protocol";
import { ConfigService } from "../../config/config.service";
import { sanitizeForContainerName } from "../providers/runtime-provider-utils";

@Injectable()
export class RuntimePlacementService {
  constructor(private readonly configService: ConfigService) {}

  resolveForRun(input: {
    userId: string;
    workspaceId: string;
    workspaceRootPath: string;
    userWorkspaceRootPath: string;
  }): RuntimePlacement {
    const { userId, workspaceId, workspaceRootPath, userWorkspaceRootPath } = input;

    if (!isAbsolute(workspaceRootPath) || !isAbsolute(userWorkspaceRootPath)) {
      throw new Error(
        `workspaceRootPath and userWorkspaceRootPath must be absolute paths: workspaceRootPath=${workspaceRootPath}, userWorkspaceRootPath=${userWorkspaceRootPath}`
      );
    }

    const relativePath = relative(userWorkspaceRootPath, workspaceRootPath);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new Error(
        `workspaceRootPath must be inside userWorkspaceRootPath: workspaceRootPath=${workspaceRootPath}, userWorkspaceRootPath=${userWorkspaceRootPath}`
      );
    }

    const rawRuntimeType = this.configService.getDefaultRuntimeProviderType();
    const isolationScope = this.configService.getRuntimeIsolationScope();
    const scopeId = isolationScope === "user" ? userId : workspaceId;

    // docker / opensandbox 统一映射为 "sandbox"，engine 类型放入 sandboxEngineType
    const isSandbox = rawRuntimeType === "docker" || rawRuntimeType === "opensandbox";
    const runtimeType = isSandbox ? "sandbox" : rawRuntimeType;
    const sandboxEngineType = isSandbox
      ? (rawRuntimeType as "docker" | "opensandbox")
      : undefined;

    const mountTarget =
      isolationScope === "user"
        ? "/workspaces"
        : rawRuntimeType === "opensandbox"
          ? this.configService.getOpenSandboxConfig().workspaceMountPath
          : "/workspace";

    const resourceName =
      isolationScope === "user"
        ? `agework-user-${sanitizeForContainerName(scopeId)}`
        : `agework-ws-${sanitizeForContainerName(scopeId)}`;

    if (runtimeType === "local") {
      return {
        runtimeType,
        isolationScope,
        scopeId,
        userId,
        workspaceId,
        hostPath: workspaceRootPath,
        runtimePath: workspaceRootPath,
        mountTarget,
        resourceName,
      };
    }

    if (isolationScope === "user") {
      const relativeSegments = relativePath.split(sep).filter(Boolean);
      const runtimePath = ["/workspaces", ...relativeSegments].join("/");
      return {
        runtimeType,
        isolationScope,
        scopeId,
        userId,
        workspaceId,
        hostPath: userWorkspaceRootPath,
        runtimePath,
        mountTarget,
        resourceName,
        sandboxEngineType,
      };
    }

    return {
      runtimeType,
      isolationScope,
      scopeId,
      userId,
      workspaceId,
      hostPath: workspaceRootPath,
      runtimePath: mountTarget,
      mountTarget,
      resourceName,
      sandboxEngineType,
    };
  }
}
```

- [ ] **Step 3: 更新 placement spec — 预期 runtimeType 变为 "sandbox"**

```ts
// runtime-placement.service.spec.ts — 关键变更
// 1. mockConfigService.getDefaultRuntimeProviderType 返回 "docker" 时，
//    预期 placement.runtimeType 应为 "sandbox"，placement.sandboxEngineType 应为 "docker"
// 2. mockConfigService.getDefaultRuntimeProviderType 返回 "opensandbox" 时，
//    预期 placement.runtimeType 应为 "sandbox"，placement.sandboxEngineType 应为 "opensandbox"
// 3. mockConfigService.getDefaultRuntimeProviderType 返回 "local" 时不变
```

具体地，修改 `runtime-placement.service.spec.ts` 中的断言：

- `describe("non-local runtime, user isolation scope")` 中的 `expect(placement.runtimeType).toBe("docker")` → `expect(placement.runtimeType).toBe("sandbox")`
- 新增 `expect(placement.sandboxEngineType).toBe("docker")`
- `describe("non-local runtime, workspace isolation scope")` 同理
- `describe("local runtime")` 不变（`runtimeType` 仍为 `"local"`，`sandboxEngineType` 为 `undefined`）

- [ ] **Step 4: 运行 placement 测试确认通过**

Run: `pnpm --filter api test runtime-placement`
Expected: 全部 PASS

---

## Task 8: 更新 RuntimeProviderRegistry spec

**Files:**
- Modify: `apps/api/src/runtime/providers/runtime-provider-registry.spec.ts`

- [ ] **Step 1: 更新 registry spec — 从 local/docker/opensandbox 改为 local/sandbox**

```ts
// runtime-provider-registry.spec.ts — 完整替换
import { describe, it, expect, beforeEach } from "vitest";
import { RuntimeProviderRegistry } from "./runtime-provider-registry";
import type { SandboxRuntimeProvider } from "./sandbox-runtime-provider";
import type { LocalRuntimeProvider } from "./local-runtime-provider";

describe("RuntimeProviderRegistry", () => {
  let registry: RuntimeProviderRegistry;
  let mockLocalProvider: LocalRuntimeProvider;
  let mockSandboxProvider: SandboxRuntimeProvider;

  beforeEach(() => {
    mockLocalProvider = { type: "local" as const } as LocalRuntimeProvider;
    mockSandboxProvider = { type: "sandbox" as const } as SandboxRuntimeProvider;
    registry = new RuntimeProviderRegistry([
      mockLocalProvider,
      mockSandboxProvider,
    ]);
  });

  it("should resolve local provider", () => {
    const provider = registry.resolve("local");
    expect(provider.type).toBe("local");
    expect(provider).toBe(mockLocalProvider);
  });

  it("should resolve sandbox provider", () => {
    const provider = registry.resolve("sandbox");
    expect(provider.type).toBe("sandbox");
    expect(provider).toBe(mockSandboxProvider);
  });

  it("should throw for unknown provider type", () => {
    expect(() => registry.resolve("docker")).toThrow(
      "Unknown runtime provider: docker"
    );
  });
});
```

- [ ] **Step 2: 运行测试确认失败（因为 SandboxRuntimeProvider 还没注册到 module）**

Run: `pnpm --filter api test runtime-provider-registry`
Expected: PASS（registry spec 自身不依赖 module 装配）

---

## Task 9: 更新 RuntimeModule DI 装配

**Files:**
- Modify: `apps/api/src/runtime/runtime.module.ts`

- [ ] **Step 1: 重写 module 的 providers 配置**

关键变更：
1. 移除 `DockerRuntimeProvider` 和 `OpenSandboxRuntimeProvider`
2. 新增 `DockerSandboxEngine`、`OpenSandboxEngine`、`SandboxRuntimeProvider`
3. `RUNTIME_PROVIDERS` token 的 inject 列表改为 `[LocalRuntimeProvider, SandboxRuntimeProvider]`
4. 新增 `SANDBOX_ENGINES` token 聚合 engines

```ts
// runtime.module.ts — 关键变更部分
import { DockerSandboxEngine } from "./providers/docker-sandbox-engine";
import { OpenSandboxEngine } from "./providers/opensandbox-sandbox-engine";
import { SandboxRuntimeProvider } from "./providers/sandbox-runtime-provider";
import { SANDBOX_ENGINES } from "./providers/sandbox-engine.token";
import type { SandboxEngine } from "./providers/sandbox-engine";
// 移除: DockerRuntimeProvider, OpenSandboxRuntimeProvider

@Module({
  // ...
  providers: [
    // core (不变)
    RunRecordService,
    RuntimeBindingService,
    RuntimeActiveStore,
    RuntimeEventProcessor,
    RunRecoveryService,
    RuntimePlacementService,
    RuntimeLifecycleService,
    // providers
    RuntimeConfigStore,
    LocalRuntimeProvider,
    DockerSandboxEngine,
    {
      provide: OPENSANDBOX_CLIENT,
      useFactory: (configService: ConfigService) =>
        new OpenSandboxClient(configService),
      inject: [ConfigService],
    },
    OpenSandboxEngine,
    {
      provide: SANDBOX_ENGINES,
      useFactory: (...engines: SandboxEngine[]) => engines,
      inject: [DockerSandboxEngine, OpenSandboxEngine],
    },
    SandboxRuntimeProvider,
    {
      provide: RUNTIME_PROVIDERS,
      useFactory: (...providers: RuntimeProvider[]) => providers,
      inject: [LocalRuntimeProvider, SandboxRuntimeProvider],
    },
    RuntimeProviderRegistry,
    // internal (不变)
    RuntimeInternalAccessService,
    RuntimeInternalAuthGuard,
    RuntimeControlQueue,
    // runner (不变)
    RuntimeRunner,
  ],
  exports: [RunRecordService, RuntimeBindingService, RuntimeRunner, RuntimeProviderRegistry, RuntimePlacementService, RuntimeLifecycleService],
})
export class RuntimeModule implements OnModuleInit {
  constructor(private readonly runRecovery: RunRecoveryService) {}

  async onModuleInit() {
    await this.runRecovery.recoverOrphanRuns();
  }
}
```

- [ ] **Step 2: 运行类型检查**

Run: `pnpm --filter api typecheck`
Expected: 通过

---

## Task 10: 更新调用方 — getStateByWorkspaceId 返回值

**Files:**
- Modify: `apps/api/src/runtime/internal/runtime-workspace.controller.ts`
- Modify: `apps/api/src/runtime/internal/runtime-runtime.controller.ts`

搜索所有使用 `getStateByWorkspaceId` 或 `containerId` 字段的调用方，将 `containerId` 改为 `runtimeResourceId`。

- [ ] **Step 1: 搜索并更新调用方**

Run: `grep -rn "containerId\|getStateByWorkspaceId" apps/api/src/runtime/internal/`

将返回的 `containerId` 引用改为 `runtimeResourceId`，`getStateByWorkspaceId` 返回值类型已自动变为 `{ runtimeResourceId: string }`。

- [ ] **Step 2: 运行类型检查**

Run: `pnpm --filter api typecheck`
Expected: 通过

---

## Task 11: 删除旧 provider 文件

**Files:**
- Delete: `apps/api/src/runtime/providers/docker-runtime-provider.ts`
- Delete: `apps/api/src/runtime/providers/docker-runtime-provider.spec.ts`
- Delete: `apps/api/src/runtime/providers/opensandbox-runtime-provider.ts`
- Delete: `apps/api/src/runtime/providers/opensandbox-runtime-provider.spec.ts`

- [ ] **Step 1: 确认所有旧 provider 的 import 已移除**

Run: `grep -rn "docker-runtime-provider\|opensandbox-runtime-provider" apps/api/src/`
Expected: 无结果（module.ts 和其他文件已改用新路径）

- [ ] **Step 2: 删除旧文件**

```bash
rm apps/api/src/runtime/providers/docker-runtime-provider.ts
rm apps/api/src/runtime/providers/docker-runtime-provider.spec.ts
rm apps/api/src/runtime/providers/opensandbox-runtime-provider.ts
rm apps/api/src/runtime/providers/opensandbox-runtime-provider.spec.ts
```

- [ ] **Step 3: 运行全部 API 测试确认通过**

Run: `pnpm --filter api test`
Expected: 全部 PASS

- [ ] **Step 4: 运行类型检查**

Run: `pnpm --filter api typecheck`
Expected: 通过

---

## Task 12: 端到端验证

- [ ] **Step 1: 运行完整测试套件**

```bash
pnpm --filter api typecheck
pnpm --filter api test
```

Expected: 全部通过

- [ ] **Step 2: 手动冒烟测试（可选）**

启动后端 `pnpm dev:api`，配置 `RUNTIME_PROVIDER=docker` 或 `RUNTIME_PROVIDER=opensandbox`：
- 创建一个 run → 确认 `runtimeType="sandbox"` 出现在日志
- 确认 sandbox 正常启动、worker 正常连接
- 确认心跳、空闲超时、取消、cleanup 正常工作

---

## Self-Review

### 1. Spec Coverage

对照设计文档 `docs/superpowers/specs/2026-06-13-sandbox-engine-and-workspace-runtime-mode-design.md` Phase A：

| 设计要求 | 对应 Task |
|---|---|
| 新增 `sandbox-engine.ts`（接口 + 类型） | Task 1 |
| 新增 `docker-sandbox-engine.ts` | Task 3 |
| 新增 `opensandbox-sandbox-engine.ts` | Task 4 |
| 新增 `sandbox-runtime-provider.ts`（type = "sandbox"） | Task 5 |
| `runtime-provider-registry.ts` 注册 local + sandbox | Task 8 + Task 9 |
| `runtime.module.ts` 装配新 provider 与 engines | Task 9 |
| `runtime-placement.service.ts` 映射 docker/opensandbox → sandbox | Task 7 |
| 测试迁移 | Task 3/4/5/8 |
| 旧 provider 删除 | Task 11 |
| 验收：docker/opensandbox 字样只出现在 engine 层 | ✅ SandboxRuntimeProvider 中无 docker/opensandbox 硬编码 |
| 验收：local 行为不变 | ✅ LocalRuntimeProvider 未修改 |
| 验收：sandbox 行为覆盖原有两个 provider | ✅ 测试用例覆盖了所有关键路径 |

### 2. Placeholder Scan

无 TBD / TODO / "implement later" / "add appropriate error handling" 等占位符。所有步骤包含完整代码。

### 3. Type Consistency

- `SandboxEngineType = "docker" | "opensandbox"` — 定义在 Task 1，全链路一致
- `SandboxPlacement` / `SandboxStartInput` / `SandboxRuntime` — 定义在 Task 1，Task 3/4/5 使用一致
- `RuntimePlacement.sandboxEngineType` — 新增在 Task 7，Task 5 读取
- `ConfigService.getSandboxEngine()` — 新增在 Task 6，返回 `"docker" | "opensandbox"`
- `getStateByWorkspaceId` 返回 `{ runtimeResourceId: string }` — Task 5 定义，Task 10 更新调用方
- 旧 `{ containerId: string }` 在 Task 10 全部替换
