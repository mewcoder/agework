# Docker 容器 Stop/Resume 复用 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Docker 引擎下，容器空闲/心跳超时停止时改为 `docker stop`（不 `docker rm`），下次同一 `resourceKey` 的 run 通过 `docker start` 复用同一容器，保留 `/home/agent/.claude` 中的 Claude session 数据；容器命名改为引擎自动分配 + `--label` 标注归属，孤儿容器发现改为基于 DB `RuntimeResource` 记录。

**Architecture:**
- `SandboxEngine` 新增可选 `resume()`，`DockerSandboxEngine` 实现为 `docker start`；`stop()` 不再 `docker rm`。
- `SandboxScopeState` 新增内存字段 `lastStoppedRuntimeResourceId`，由 `releaseScopeRuntime` 写入，由 `createSandbox` 读取并尝试 resume，失败/不存在则 fallback 到 `getOrCreate`（不再传 `--name`，改用 `--label`）。
- 心跳超时 / idle 超时路径不再 `revokeWorkspace`（access key 仍 baked-in 容器内，resume 时复用）；workspace/用户删除路径保持撤销 key。
- `run-recovery.service.ts` 的孤儿容器发现从 `docker ps --filter name=...` 改为查询 `RuntimeResource(status="running")`。
- `RuntimePlacement.resourceName` / `SandboxPlacement.resourceName` 字段及其计算逻辑、`sanitizeForContainerName` 工具函数全部删除（死代码）。

**Tech Stack:** NestJS 11, Prisma (sqlite), Vitest, Docker CLI via `execFile`.

---

### Task 1: `SandboxEngine` 接口 — 移除 `resourceName`，新增 `resume()`

**Files:**
- Modify: `apps/api/src/runtime/providers/sandbox-engine/index.ts`

- [ ] **Step 1: 移除 `SandboxPlacement.resourceName`，更新 `stop()` 文档注释，新增可选 `resume()`**

将文件中的：

```ts
export type SandboxPlacement = {
  runtimeIsolationScope: import("@agework/shared/protocol").RuntimeIsolationScope;
  resourceKey: string;
  workspaceId: string;
  workspaceHostPath: string;
  workspaceMountPath: string;
  resourceName: string;
};
```

替换为：

```ts
export type SandboxPlacement = {
  runtimeIsolationScope: import("@agework/shared/protocol").RuntimeIsolationScope;
  resourceKey: string;
  workspaceId: string;
  workspaceHostPath: string;
  workspaceMountPath: string;
};
```

将：

```ts
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
   * 检查沙箱是否健康。可选，用于 DB resource 恢复时验证。
   */
  isHealthy?(runtimeResourceId: string): Promise<boolean>;
}
```

替换为：

```ts
  /**
   * 停止沙箱运行环境（不销毁）。
   * Docker: docker stop（保留容器对象与可写层数据，可通过 resume() 恢复）。
   * OpenSandbox: client.deleteSandbox（暂不支持暂停，效果等同销毁）。
   */
  stop(runtimeResourceId: string): Promise<void>;

  /**
   * 恢复一个此前被 stop() 的沙箱运行环境（可选，仅 Docker 实现）。
   * Docker: docker start <id>，复用原容器及其可写层数据。
   */
  resume?(runtimeResourceId: string, input: SandboxStartInput): Promise<SandboxRuntime>;

  /**
   * 服务重启后，根据持久化的 runtimeResourceId 终止孤儿资源。幂等。
   */
  recoverOrphan(runtimeResourceId: string): Promise<void>;

  /**
   * 检查沙箱是否健康。可选，用于 DB resource 恢复时验证。
   */
  isHealthy?(runtimeResourceId: string): Promise<boolean>;
}
```

- [ ] **Step 2: 运行类型检查确认尚未修复的引用（预期失败）**

Run: `pnpm --filter @agework/api typecheck`
Expected: FAIL — 多处报错 `resourceName` 不存在于 `SandboxPlacement` / `RuntimePlacement`（这些会在后续 Task 中逐一修复）。这一步只是确认编译器能定位所有受影响位置，不需要现在修复完。

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/runtime/providers/sandbox-engine/index.ts
git commit -m "refactor(runtime): drop SandboxPlacement.resourceName, add optional SandboxEngine.resume"
```

---

### Task 2: `packages/shared/src/protocol/transport.ts` — 移除 `RuntimePlacement.resourceName`

**Files:**
- Modify: `packages/shared/src/protocol/transport.ts:108-132`

- [ ] **Step 1: 更新 `RuntimePlacement` 类型与注释**

将：

```ts
/**
 * 一次 run 的 runtime 放置信息：使用哪种 provider、隔离粒度，
 * 以及 host/容器侧的 workspace 路径。
 *
 * `mountTarget`/`resourceName` 是隔离粒度的派生值，由放置服务一次性算好。
 */
export type RuntimePlacement = {
  runtimeType: string;
  runtimeIsolationScope: RuntimeIsolationScope;
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

替换为：

```ts
/**
 * 一次 run 的 runtime 放置信息：使用哪种 provider、隔离粒度，
 * 以及 host/容器侧的 workspace 路径。
 *
 * `mountTarget` 是隔离粒度的派生值，由放置服务一次性算好。
 */
export type RuntimePlacement = {
  runtimeType: string;
  runtimeIsolationScope: RuntimeIsolationScope;
  userId: string;
  workspaceId: string;
  hostPath: string;
  runtimePath: string;
  /** 容器/沙箱内 hostPath 的挂载目标路径（如 `/workspace` 或 `/workspaces`）。 */
  mountTarget: string;
  /** sandbox engine 类型，仅 runtimeType="sandbox" 时有值。 */
  sandboxEngineType?: "docker" | "opensandbox";
};
```

- [ ] **Step 2: Commit**

```bash
git add packages/shared/src/protocol/transport.ts
git commit -m "refactor(protocol): remove RuntimePlacement.resourceName"
```

---

### Task 3: `RuntimePlacementService` — 移除 `resourceName` 计算

**Files:**
- Modify: `apps/api/src/runtime/core/runtime-placement.service.ts`
- Test: `apps/api/src/runtime/core/runtime-placement.service.spec.ts`

- [ ] **Step 1: 更新失败的断言（先改 spec，明确目标行为）**

在 `runtime-placement.service.spec.ts` 中：

1. 移除第 5 行 import 后不需要改动（该文件没有引用 `sanitizeForContainerName`）。
2. 移除以下三处对 `resourceName` 的断言：

```ts
      expect(placement.resourceName).toBe("agework-user-user-1");
```
（第 36 行，删除整行）

```ts
      expect(placement.resourceName).toBe("agework-ws-ws-1");
```
（第 78 行，删除整行）

3. 删除整个测试用例（第 81-96 行，该测试仅验证 `resourceName` 差异，已无意义）：

```ts
    it("resolves different resource names for different workspaces", () => {
      const placementA = service.resolveForRun({
        userId: "user-1",
        workspaceId: "ws-a",
        workspaceRootPath: "/data/users/user-1/ws-a",
        userWorkspaceRootPath: "/data/users/user-1",
      });
      const placementB = service.resolveForRun({
        userId: "user-1",
        workspaceId: "ws-b",
        workspaceRootPath: "/data/users/user-1/ws-b",
        userWorkspaceRootPath: "/data/users/user-1",
      });

      expect(placementA.resourceName).not.toBe(placementB.resourceName);
    });
```

- [ ] **Step 2: 运行测试确认编译失败（resourceName 仍在实现中）**

Run: `pnpm test:api -- runtime/core/runtime-placement.service.spec.ts`
Expected: PASS（spec 中已无 `resourceName` 断言，但实现仍会返回多余字段——TS 结构类型允许多余属性存在于返回值，所以这一步预期仍能 PASS。这一步主要确认 spec 修改没有引入语法错误）

- [ ] **Step 3: 移除实现中的 `resourceName` 计算与 import**

在 `runtime-placement.service.ts` 中，移除第 5 行 import：

```ts
import { sanitizeForContainerName } from "../providers/runtime-provider-utils";
```

移除以下计算（第 57-61 行）：

```ts
    // 容器/沙箱资源名：user 隔离下按 userId 共享，workspace 隔离下按 workspaceId 独立。
    const resourceName =
      runtimeIsolationScope === "user"
        ? `agework-user-${sanitizeForContainerName(resourceKey)}`
        : `agework-ws-${sanitizeForContainerName(resourceKey)}`;

```

移除三处返回对象中的 `resourceName,`（第 72、87、100 行附近，分别在 `local`、`user` 隔离、`workspace` 隔离三个返回分支中）。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test:api -- runtime/core/runtime-placement.service.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/runtime/core/runtime-placement.service.ts apps/api/src/runtime/core/runtime-placement.service.spec.ts
git commit -m "refactor(runtime): remove resourceName computation from RuntimePlacementService"
```

---

### Task 4: 移除死代码 `sanitizeForContainerName`

**Files:**
- Modify: `apps/api/src/runtime/providers/runtime-provider-utils.ts:109-112`

- [ ] **Step 1: 确认无其他引用**

Run: `grep -rn "sanitizeForContainerName" apps/api/src`
Expected: 无输出（Task 3 已移除唯一引用）

- [ ] **Step 2: 删除函数**

删除：

```ts
/** 清理 id 中可能导致 Docker 容器名非法的字符，仅保留 `[a-zA-Z0-9_.-]`。 */
export function sanitizeForContainerName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/runtime/providers/runtime-provider-utils.ts
git commit -m "refactor(runtime): remove unused sanitizeForContainerName helper"
```

---

### Task 5: `DockerSandboxEngine` — 移除 `--name`/`docker rm`，新增 `--label` 与 `resume()`

**Files:**
- Modify: `apps/api/src/runtime/providers/sandbox-engine/docker-sandbox-engine.ts`
- Test: `apps/api/src/runtime/providers/sandbox-engine/docker-sandbox-engine.spec.ts`

- [ ] **Step 1: 更新 spec 的 `makePlacement` 辅助函数，移除 `resourceName`**

```ts
function makePlacement(overrides?: Partial<SandboxPlacement>): SandboxPlacement {
  return {
    runtimeIsolationScope: "workspace",
    resourceKey: "ws-1",
    workspaceId: "ws-1",
    workspaceHostPath: "/tmp/workspace",
    workspaceMountPath: "/workspace",
    ...overrides,
  };
}
```

- [ ] **Step 2: 重写 "getOrCreate starts a container" 测试 — 不再断言 `--name`，改为断言无 `--name`**

将：

```ts
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
```

替换为：

```ts
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
    expect(runArgs).not.toContain("--name");
  });

  it("getOrCreate adds --label args from metadata", async () => {
    const engine = new DockerSandboxEngine();
    mockExecFile.mockImplementation(((...args: any[]) => {
      args[args.length - 1](null, { stdout: "container-abc\n", stderr: "" });
    }) as any);

    await engine.getOrCreate(makeInput({
      metadata: {
        "agework.io/runtime-resource-key": "ws-1",
        "agework.io/runtime-isolation-scope": "workspace",
      },
    }));

    const runCall = mockExecFile.mock.calls.find(
      (c) => (c[1] as string[])[0] === "run"
    );
    const runArgs = runCall![1] as string[];
    expect(runArgs).toContain("--label");
    expect(runArgs).toContain("agework.io/runtime-resource-key=ws-1");
    expect(runArgs).toContain("agework.io/runtime-isolation-scope=workspace");
  });
```

- [ ] **Step 3: 运行测试确认失败（实现尚未修改）**

Run: `pnpm test:api -- runtime/providers/sandbox-engine/docker-sandbox-engine.spec.ts -t "getOrCreate"`
Expected: FAIL — `getOrCreate starts a container...` 报 `runArgs` 仍包含 `--name`；`getOrCreate adds --label args from metadata` 报缺少 `--label`。

- [ ] **Step 4: 重写 `getOrCreate()` 实现**

将：

```ts
  async getOrCreate(input: SandboxStartInput): Promise<SandboxRuntime> {
    const { placement, image, env } = input;
    const { workspaceHostPath, workspaceMountPath, resourceName, resourceKey } = placement;

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
```

替换为：

```ts
  async getOrCreate(input: SandboxStartInput): Promise<SandboxRuntime> {
    const { placement, image, env, metadata } = input;
    const { workspaceHostPath, workspaceMountPath, resourceKey } = placement;

    const args = [
      "run",
      "-d",
      "--init",
    ];

    // 归属信息以 label 标注（Docker 自动分配容器名，避免命名冲突）
    for (const [key, value] of Object.entries(metadata)) {
      args.push("--label", `${key}=${value}`);
    }

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
```

(`resourceKey` 仍在下方第 51 行 `this.logger.log` 中使用，保留其解构。)

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm test:api -- runtime/providers/sandbox-engine/docker-sandbox-engine.spec.ts -t "getOrCreate"`
Expected: PASS

- [ ] **Step 6: 重写 "stop calls docker stop then docker rm" 测试 — 改为断言不调用 rm**

将：

```ts
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
```

替换为：

```ts
  it("stop calls docker stop and does not remove the container", async () => {
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
    expect(mockExecFile).not.toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["rm", "container-abc"]),
      expect.any(Function)
    );
  });
```

- [ ] **Step 7: 新增 "resume" 测试**

在 `startWorker is a no-op for Docker` 测试之后新增：

```ts
  it("resume calls docker start and returns the runtime", async () => {
    const engine = new DockerSandboxEngine();
    mockExecFile.mockImplementation(((...args: any[]) => {
      args[args.length - 1](null, { stdout: "", stderr: "" });
    }) as any);

    const result = await engine.resume!("container-abc", makeInput());

    expect(mockExecFile).toHaveBeenCalledWith(
      "docker",
      ["start", "container-abc"],
      expect.any(Function)
    );
    expect(result).toEqual({
      engineType: "docker",
      runtimeResourceId: "container-abc",
      workspaceMountPath: "/workspace",
    });
  });
```

- [ ] **Step 8: 运行测试确认 stop/resume 测试失败（实现尚未修改）**

Run: `pnpm test:api -- runtime/providers/sandbox-engine/docker-sandbox-engine.spec.ts`
Expected: FAIL — "stop calls docker stop and does not remove the container" 报 `rm` 被调用；"resume calls docker start..." 报 `engine.resume` 不是函数。

- [ ] **Step 9: 实现 `stop()` 去掉 `docker rm`，新增 `resume()`**

将：

```ts
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
```

替换为：

```ts
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
  }

  async resume(
    runtimeResourceId: string,
    input: SandboxStartInput
  ): Promise<SandboxRuntime> {
    await execFileAsync("docker", ["start", runtimeResourceId]);
    return {
      engineType: "docker",
      runtimeResourceId,
      workspaceMountPath: input.placement.workspaceMountPath,
    };
  }
```

- [ ] **Step 10: 运行全部 docker-sandbox-engine 测试确认通过**

Run: `pnpm test:api -- runtime/providers/sandbox-engine/docker-sandbox-engine.spec.ts`
Expected: PASS（全部用例）

- [ ] **Step 11: Commit**

```bash
git add apps/api/src/runtime/providers/sandbox-engine/docker-sandbox-engine.ts apps/api/src/runtime/providers/sandbox-engine/docker-sandbox-engine.spec.ts
git commit -m "feat(runtime): docker stop no longer removes container; add resume() and label-based ownership"
```

---

### Task 6: `OpenSandboxSandboxEngine` spec — 移除 `resourceName` mock 字段

**Files:**
- Modify: `apps/api/src/runtime/providers/sandbox-engine/opensandbox-sandbox-engine.spec.ts:25`

- [ ] **Step 1: 删除该行**

删除：

```ts
    resourceName: "agework-ws-ws-1",
```

- [ ] **Step 2: 运行测试确认通过**

Run: `pnpm test:api -- runtime/providers/sandbox-engine/opensandbox-sandbox-engine.spec.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/runtime/providers/sandbox-engine/opensandbox-sandbox-engine.spec.ts
git commit -m "test(runtime): remove resourceName from opensandbox engine mock placement"
```

---

### Task 7: `SandboxRuntimeProvider` — `start()`/`SandboxScopeState` 移除 `resourceName`，准备 resume 字段

**Files:**
- Modify: `apps/api/src/runtime/providers/sandbox-runtime-provider.ts`
- Test: `apps/api/src/runtime/providers/sandbox-runtime-provider.spec.ts`

- [ ] **Step 1: spec — 更新 mock engine 与 `makePlacement`**

在 `makeMockEngine` 中新增 `resume` mock（默认成功，返回同一 `runtimeResourceId`）：

```ts
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
    resume: vi.fn().mockImplementation(async (runtimeResourceId: string) => ({
      engineType: type,
      runtimeResourceId,
      workspaceMountPath: "/workspace",
    })),
    recoverOrphan: vi.fn().mockResolvedValue(undefined),
  };
}
```

在 `makePlacement`（第 87-100 行）中删除：

```ts
    resourceName: "agework-ws-ws-1",
```

在 `userPlacement`（第 329-336 行）中删除：

```ts
    resourceName: "agework-user-user-1",
```

在"different users → no reuse"测试（第 368 行）中删除：

```ts
{ ...userPlacement, userId: "user-2", workspaceId: "ws-2", resourceName: "agework-user-user-2" } as never
```

改为：

```ts
{ ...userPlacement, userId: "user-2", workspaceId: "ws-2" } as never
```

- [ ] **Step 2: 运行全套测试，确认仍通过（本步骤是纯 mock 调整，不改实现）**

Run: `pnpm test:api -- runtime/providers/sandbox-runtime-provider.spec.ts`
Expected: PASS（`resourceName` 在实现里仍被读取但值为 `undefined`，由于是字符串拼接到日志/对象里，不影响断言；实现仍引用 `placement.resourceName` 字段，TS 层面会在 Step 4 处理）

- [ ] **Step 3: 运行类型检查，确认 `placement.resourceName` 报错**

Run: `pnpm --filter @agework/api typecheck`
Expected: FAIL — `sandbox-runtime-provider.ts` 中 `resourceName` 不存在于 `RuntimePlacement` 类型（Task 2 已移除该字段）。

- [ ] **Step 4: 实现 — 移除 `start()` 中所有 `resourceName` 引用**

第 69 行，将：

```ts
    const { runtimeIsolationScope, hostPath, mountTarget, resourceName } = placement;
```

替换为：

```ts
    const { runtimeIsolationScope, hostPath, mountTarget } = placement;
```

第 75-85 行的日志对象，将：

```ts
    this.logger.log(
      `sandbox run starting ${safeLogJson({
        runId,
        conversationId: runConfig.conversationId,
        workspaceId,
        resourceKey,
        runtimeIsolationScope,
        engineType,
        resourceName,
      })}`
    );
```

替换为：

```ts
    this.logger.log(
      `sandbox run starting ${safeLogJson({
        runId,
        conversationId: runConfig.conversationId,
        workspaceId,
        resourceKey,
        runtimeIsolationScope,
        engineType,
      })}`
    );
```

第 166-173 行的 `sandboxPlacement`，将：

```ts
      const sandboxPlacement: SandboxPlacement = {
        runtimeIsolationScope,
        resourceKey,
        workspaceId,
        workspaceHostPath: hostPath,
        workspaceMountPath: mountTarget,
        resourceName,
      };
```

替换为：

```ts
      const sandboxPlacement: SandboxPlacement = {
        runtimeIsolationScope,
        resourceKey,
        workspaceId,
        workspaceHostPath: hostPath,
        workspaceMountPath: mountTarget,
      };
```

- [ ] **Step 5: 运行测试与类型检查确认通过**

Run: `pnpm test:api -- runtime/providers/sandbox-runtime-provider.spec.ts && pnpm --filter @agework/api typecheck`
Expected: PASS（测试与类型检查均通过；类型检查可能仍因其他文件的 `resourceName` 残留报错——若有，记录下来，将在 Task 9 处理 `agent-run-config-builder.spec.ts` / `runtime-runner.spec.ts` / `workspace-runtime.service.spec.ts`）

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/runtime/providers/sandbox-runtime-provider.ts apps/api/src/runtime/providers/sandbox-runtime-provider.spec.ts
git commit -m "refactor(runtime): remove resourceName from SandboxRuntimeProvider.start()"
```

---

### Task 8: `SandboxRuntimeProvider` — resume-first `createSandbox` + `releaseScopeRuntime` 不撤销 access key

这是本计划的核心行为变更。拆成四个子步骤：先写 spec（失败），再改实现，再跑通。

**Files:**
- Modify: `apps/api/src/runtime/providers/sandbox-runtime-provider.ts`
- Test: `apps/api/src/runtime/providers/sandbox-runtime-provider.spec.ts`

- [ ] **Step 1: spec — 心跳超时不再撤销 access key**

将第 270-283 行的测试：

```ts
  it("marks run as error after 60s without heartbeat, without stopping the sandbox", async () => {
    const { provider, engine, eventProcessor, access } = makeProvider();
    provider.start(baseRun as never, makePlacement() as never);
    await vi.runOnlyPendingTimersAsync();

    await vi.advanceTimersByTimeAsync(65_000);

    expect(eventProcessor.forceErrorStatus).toHaveBeenCalledWith(
      "run-1",
      "worker heartbeat timeout"
    );
    expect(access.revokeWorkspace).toHaveBeenCalledWith("ws-1");
    expect(engine.stop).not.toHaveBeenCalled();
  });
```

替换为：

```ts
  it("marks run as error after 60s without heartbeat, without stopping the sandbox or revoking the workspace key", async () => {
    const { provider, engine, eventProcessor, access } = makeProvider();
    provider.start(baseRun as never, makePlacement() as never);
    await vi.runOnlyPendingTimersAsync();

    await vi.advanceTimersByTimeAsync(65_000);

    expect(eventProcessor.forceErrorStatus).toHaveBeenCalledWith(
      "run-1",
      "worker heartbeat timeout"
    );
    expect(access.revokeWorkspace).not.toHaveBeenCalled();
    expect(engine.stop).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: spec — 心跳超时后下一次 run 走 resume，不是重新 getOrCreate**

将第 285-298 行的测试：

```ts
  it("recreates the sandbox on the next run after a heartbeat timeout", async () => {
    const { provider, engine } = makeProvider();
    provider.start(baseRun as never, makePlacement() as never);
    await vi.runOnlyPendingTimersAsync();

    await vi.advanceTimersByTimeAsync(65_000);

    provider.start({
      ...baseRun, runId: "run-2", conversationId: "conv-2",
    } as never, makePlacement() as never);
    await vi.runOnlyPendingTimersAsync();

    expect(engine.getOrCreate).toHaveBeenCalledTimes(2);
  });
```

替换为：

```ts
  it("resumes the previous container on the next run after a heartbeat timeout", async () => {
    const { provider, engine } = makeProvider();
    provider.start(baseRun as never, makePlacement() as never);
    await vi.runOnlyPendingTimersAsync();
    const firstResourceId = (engine.getOrCreate as ReturnType<typeof vi.fn>).mock
      .results[0].value;

    await vi.advanceTimersByTimeAsync(65_000);

    provider.start({
      ...baseRun, runId: "run-2", conversationId: "conv-2",
    } as never, makePlacement() as never);
    await vi.runOnlyPendingTimersAsync();

    const { runtimeResourceId } = await firstResourceId;
    expect(engine.resume).toHaveBeenCalledWith(
      runtimeResourceId,
      expect.anything()
    );
    expect(engine.getOrCreate).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 3: spec — idle 超时不再撤销 access key**

将第 447-463 行的测试：

```ts
  it("after idle timeout, marks resource stopped and resets runtimeResourceId", async () => {
    const { provider, config, workspaceRuntimeService, access } = makeProvider();
    config.getIdleTimeoutSeconds.mockReturnValue(5);

    provider.start(baseRun as never, makePlacement() as never);
    await vi.runOnlyPendingTimersAsync();

    provider.cleanup("run-1");
    await vi.advanceTimersByTimeAsync(5_500);

    expect(workspaceRuntimeService.markStoppedByResourceKey).toHaveBeenCalledWith(
      "sandbox",
      "workspace",
      "ws-1"
    );
    expect(access.revokeWorkspace).toHaveBeenCalledWith("ws-1");
  });
```

替换为：

```ts
  it("after idle timeout, marks resource stopped without revoking the workspace key", async () => {
    const { provider, config, workspaceRuntimeService, access } = makeProvider();
    config.getIdleTimeoutSeconds.mockReturnValue(5);

    provider.start(baseRun as never, makePlacement() as never);
    await vi.runOnlyPendingTimersAsync();

    provider.cleanup("run-1");
    await vi.advanceTimersByTimeAsync(5_500);

    expect(workspaceRuntimeService.markStoppedByResourceKey).toHaveBeenCalledWith(
      "sandbox",
      "workspace",
      "ws-1"
    );
    expect(access.revokeWorkspace).not.toHaveBeenCalled();
  });
```

- [ ] **Step 4: spec — idle 停止后下一次 run 走 resume，并新增 resume 失败 fallback 测试**

将第 465-484 行的测试：

```ts
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
```

替换为：

```ts
  it("next run after idle stop resumes the previous container", async () => {
    const { provider, engine, config } = makeProvider();
    config.getIdleTimeoutSeconds.mockReturnValue(5);

    provider.start(baseRun as never, makePlacement() as never);
    await vi.runOnlyPendingTimersAsync();
    const { runtimeResourceId } = await (engine.getOrCreate as ReturnType<typeof vi.fn>)
      .mock.results[0].value;

    provider.cleanup("run-1");
    await vi.advanceTimersByTimeAsync(5_500);

    provider.start({
      ...baseRun, runId: "run-2", conversationId: "conv-2",
    } as never, makePlacement() as never);
    await vi.runOnlyPendingTimersAsync();

    expect(engine.resume).toHaveBeenCalledWith(runtimeResourceId, expect.anything());
    expect(engine.getOrCreate).toHaveBeenCalledTimes(1);
  });

  it("falls back to getOrCreate when resume fails after idle stop", async () => {
    const { provider, engine, config } = makeProvider();
    config.getIdleTimeoutSeconds.mockReturnValue(5);

    provider.start(baseRun as never, makePlacement() as never);
    await vi.runOnlyPendingTimersAsync();

    provider.cleanup("run-1");
    await vi.advanceTimersByTimeAsync(5_500);

    (engine.resume as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("container gone")
    );

    provider.start({
      ...baseRun, runId: "run-2", conversationId: "conv-2",
    } as never, makePlacement() as never);
    await vi.runOnlyPendingTimersAsync();

    expect(engine.resume).toHaveBeenCalledTimes(1);
    expect(engine.getOrCreate).toHaveBeenCalledTimes(2);
  });
```

- [ ] **Step 5: 运行测试，确认上述四个用例失败（实现尚未修改）**

Run: `pnpm test:api -- runtime/providers/sandbox-runtime-provider.spec.ts`
Expected: FAIL — 4 个新/改测试失败：`access.revokeWorkspace` 仍被调用；`engine.resume` 未被调用；`getOrCreate` 调用次数不符。

- [ ] **Step 6: 实现 — `SandboxScopeState` 新增 `lastStoppedRuntimeResourceId`**

第 29-35 行，将：

```ts
type SandboxScopeState = {
  runtimeResourceId: string;
  accessKey: string;
  activeRuns: Map<string, string>; // runId → conversationId
  runtimeIsolationScope: RuntimeIsolationScope;
  engineType: SandboxEngineType;
};
```

替换为：

```ts
type SandboxScopeState = {
  runtimeResourceId: string;
  /** 上次 idle/心跳超时释放时的容器 ID，供下次 start() resume；resume 成功或全新创建后清空。 */
  lastStoppedRuntimeResourceId?: string;
  accessKey: string;
  activeRuns: Map<string, string>; // runId → conversationId
  runtimeIsolationScope: RuntimeIsolationScope;
  engineType: SandboxEngineType;
};
```

- [ ] **Step 7: 实现 — `start()` 中 access key 重发条件加上 `lastStoppedRuntimeResourceId` 判断**

第 96-109 行，将：

```ts
    let scopeState = this.scopeStates.get(resourceKey);
    if (!scopeState) {
      const accessKey = this.runtimeAccess.issueWorkspaceKey(resourceKey);
      scopeState = {
        runtimeResourceId: "",
        accessKey,
        activeRuns: new Map(),
        runtimeIsolationScope,
        engineType,
      };
      this.scopeStates.set(resourceKey, scopeState);
    } else if (!scopeState.runtimeResourceId && !this.pendingSandboxes.has(resourceKey)) {
      scopeState.accessKey = this.runtimeAccess.issueWorkspaceKey(resourceKey);
    }
```

替换为：

```ts
    let scopeState = this.scopeStates.get(resourceKey);
    if (!scopeState) {
      const accessKey = this.runtimeAccess.issueWorkspaceKey(resourceKey);
      scopeState = {
        runtimeResourceId: "",
        accessKey,
        activeRuns: new Map(),
        runtimeIsolationScope,
        engineType,
      };
      this.scopeStates.set(resourceKey, scopeState);
    } else if (
      !scopeState.runtimeResourceId &&
      !scopeState.lastStoppedRuntimeResourceId &&
      !this.pendingSandboxes.has(resourceKey)
    ) {
      // 上次容器是全新创建失败/未曾创建过，签发新 key；
      // 若 lastStoppedRuntimeResourceId 存在，说明将走 resume，
      // 沿用旧 key（容器内 baked-in 的就是这个）。
      scopeState.accessKey = this.runtimeAccess.issueWorkspaceKey(resourceKey);
    }
```

- [ ] **Step 8: 实现 — `start()` 调用 `createSandbox` 时传入并清空 `lastStoppedRuntimeResourceId`**

第 191 行，将：

```ts
      const runtimePromise = this.createSandbox(engine, engineInput);
```

替换为：

```ts
      const resumeRuntimeResourceId = scopeState.lastStoppedRuntimeResourceId;
      scopeState.lastStoppedRuntimeResourceId = undefined;

      const runtimePromise = this.createSandbox(engine, engineInput, resumeRuntimeResourceId);
```

- [ ] **Step 9: 实现 — `createSandbox()` resume-first**

第 377-384 行，将：

```ts
  private async createSandbox(
    engine: SandboxEngine,
    input: SandboxStartInput
  ): Promise<SandboxRuntime> {
    const runtime = await engine.getOrCreate(input);
    await engine.startWorker(runtime, input);
    return runtime;
  }
```

替换为：

```ts
  private async createSandbox(
    engine: SandboxEngine,
    input: SandboxStartInput,
    resumeRuntimeResourceId?: string
  ): Promise<SandboxRuntime> {
    if (resumeRuntimeResourceId && engine.resume) {
      try {
        const runtime = await engine.resume(resumeRuntimeResourceId, input);
        await engine.startWorker(runtime, input);
        return runtime;
      } catch (err) {
        this.logger.warn(
          `resume failed, falling back to getOrCreate ${safeLogJson({
            resumeRuntimeResourceId,
            ...errorLogFields(err),
          })}`
        );
      }
    }

    const runtime = await engine.getOrCreate(input);
    await engine.startWorker(runtime, input);
    return runtime;
  }
```

- [ ] **Step 10: 实现 — `releaseScopeRuntime()` 不撤销 access key，转存 `lastStoppedRuntimeResourceId`**

第 438-462 行，将：

```ts
  /**
   * 放弃对某个 runtime resource 当前容器/沙箱的引用：停止心跳与空闲计时、清空
   * activeRuns 与 runtimeResourceId、撤销 access key，并将 RuntimeResource 标记为 stopped。
   * 不负责真正停止/删除容器——是否需要 engine.stop() 由调用方决定。
   */
  private releaseScopeRuntime(resourceKey: string, state: SandboxScopeState): void {
    this.heartbeats.stop(resourceKey);
    this.idleWatchdog.cancel(resourceKey);
    state.activeRuns.clear();
    state.runtimeResourceId = "";
    this.runtimeAccess.revokeWorkspace(resourceKey);

    this.workspaceRuntimeService
      .markStoppedByResourceKey(
        "sandbox",
        state.runtimeIsolationScope,
        resourceKey
      )
      .catch(
        swallow(
          this.logger,
          `mark runtime resource stopped for key ${resourceKey}`
        )
      );
  }
```

替换为：

```ts
  /**
   * 放弃对某个 runtime resource 当前容器/沙箱的引用：停止心跳与空闲计时、清空
   * activeRuns 与 runtimeResourceId、将旧 runtimeResourceId 转存到
   * lastStoppedRuntimeResourceId 供下次 resume，并将 RuntimeResource 标记为 stopped。
   * 不撤销 access key——容器里 baked-in 的 key 仍有效，resume 后的 worker 需要用它。
   * 不负责真正停止/删除容器——是否需要 engine.stop() 由调用方决定。
   */
  private releaseScopeRuntime(resourceKey: string, state: SandboxScopeState): void {
    this.heartbeats.stop(resourceKey);
    this.idleWatchdog.cancel(resourceKey);
    state.activeRuns.clear();
    state.lastStoppedRuntimeResourceId = state.runtimeResourceId;
    state.runtimeResourceId = "";

    this.workspaceRuntimeService
      .markStoppedByResourceKey(
        "sandbox",
        state.runtimeIsolationScope,
        resourceKey
      )
      .catch(
        swallow(
          this.logger,
          `mark runtime resource stopped for key ${resourceKey}`
        )
      );
  }
```

- [ ] **Step 11: 运行全部测试，确认通过**

Run: `pnpm test:api -- runtime/providers/sandbox-runtime-provider.spec.ts`
Expected: PASS（全部用例，包含 Task 7 与本 Task 的改动）

- [ ] **Step 12: 类型检查**

Run: `pnpm --filter @agework/api typecheck`
Expected: PASS（若仍有 `resourceName` 残留报错，确认报错文件属于 Task 9 范围）

- [ ] **Step 13: Commit**

```bash
git add apps/api/src/runtime/providers/sandbox-runtime-provider.ts apps/api/src/runtime/providers/sandbox-runtime-provider.spec.ts
git commit -m "feat(runtime): resume stopped containers in-process instead of revoking access keys"
```

---

### Task 9: 剩余 `resourceName` mock 字段清理

**Files:**
- Modify: `apps/api/src/runtime/core/workspace-runtime.service.spec.ts:17,123`
- Modify: `apps/api/src/agent/agent-run-config-builder.spec.ts:38,60,85`
- Modify: `apps/api/src/runtime/core/runtime-runner.spec.ts:18`

- [ ] **Step 1: 删除 `workspace-runtime.service.spec.ts` 中两处 `resourceName`**

第 17 行删除：

```ts
    resourceName: "agework-user-u1",
```

第 123 行删除：

```ts
        resourceName: "agework-ws-w1",
```

- [ ] **Step 2: 删除 `agent-run-config-builder.spec.ts` 中三处 `resourceName`**

第 38、60、85 行均删除：

```ts
        resourceName: "agework-ws-ws-1",
```

- [ ] **Step 3: 删除 `runtime-runner.spec.ts` 中一处 `resourceName`**

第 18 行删除：

```ts
    resourceName: "agework-ws-ws-1",
```

- [ ] **Step 4: 运行受影响的测试与全量类型检查**

Run: `pnpm test:api -- runtime/core/workspace-runtime.service.spec.ts runtime/core/runtime-runner.spec.ts agent/agent-run-config-builder.spec.ts && pnpm --filter @agework/api typecheck`
Expected: PASS（类型检查全绿，标志着 `resourceName` 已从全部代码与测试中清除）

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/runtime/core/workspace-runtime.service.spec.ts apps/api/src/agent/agent-run-config-builder.spec.ts apps/api/src/runtime/core/runtime-runner.spec.ts
git commit -m "test(runtime): remove leftover resourceName fields from mock placements"
```

---

### Task 10: `run-recovery.service.ts` — 孤儿容器发现改为基于 DB

**Files:**
- Modify: `apps/api/src/runtime/core/run-recovery.service.ts`
- Test: `apps/api/src/runtime/core/run-recovery.service.spec.ts`

- [ ] **Step 1: spec — 更新 `makePrisma()` helper，新增 `findMany`/`updateMany`**

将：

```ts
function makePrisma() {
  return {
    runtimeResource: {
      findUnique: vi.fn().mockResolvedValue(null),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };
}
```

替换为：

```ts
function makePrisma() {
  return {
    runtimeResource: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };
}
```

- [ ] **Step 2: spec — 重写 `recoverOrphanContainers` describe 块**

将第 101-139 行的整个 describe 块：

```ts
describe("RunRecoveryService.recoverOrphanContainers", () => {
  it("stops orphaned agework-ws-* and agework-user-* containers on recovery", async () => {
    const dockerRecoverOrphan = vi.fn().mockResolvedValue(undefined);
    const mockRunRecordService: Partial<RunRecordService> = {
      findAllActive: vi.fn().mockResolvedValue([]),
    };
    const mockConversationService: Partial<ConversationService> = {};
    const mockProviderRegistry: Partial<RuntimeProviderRegistry> = {
      resolve: vi.fn().mockReturnValue({ recoverOrphan: dockerRecoverOrphan }),
    };

    const service = new RunRecoveryService(
      mockRunRecordService as RunRecordService,
      mockConversationService as ConversationService,
      mockProviderRegistry as RuntimeProviderRegistry,
      makePrisma() as never
    );
    // Return different containers depending on which prefix is queried
    service["execDocker"] = vi.fn().mockImplementation((_cmd: string, args: string[]) => {
      const filterArg = args.find((a) => a.startsWith("name="));
      const prefix = filterArg ? filterArg.replace("name=", "") : "";
      if (prefix === "agework-ws-") {
        return Promise.resolve({ stdout: "agework-ws-ws1\nagework-ws-ws2\n", stderr: "" });
      }
      if (prefix === "agework-user-") {
        return Promise.resolve({ stdout: "agework-user-u1\n", stderr: "" });
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    });

    await service.recoverOrphanRuns();

    expect(mockProviderRegistry.resolve).toHaveBeenCalledWith("docker");
    expect(dockerRecoverOrphan).toHaveBeenCalledWith("agework-ws-ws1");
    expect(dockerRecoverOrphan).toHaveBeenCalledWith("agework-ws-ws2");
    expect(dockerRecoverOrphan).toHaveBeenCalledWith("agework-user-u1");
    expect(dockerRecoverOrphan).toHaveBeenCalledTimes(3);
  });
});
```

替换为：

```ts
describe("RunRecoveryService.recoverOrphanContainers", () => {
  it("recovers running RuntimeResource rows via provider.recoverOrphan and marks them stopped", async () => {
    const dockerRecoverOrphan = vi.fn().mockResolvedValue(undefined);
    const mockRunRecordService: Partial<RunRecordService> = {
      findAllActive: vi.fn().mockResolvedValue([]),
    };
    const mockConversationService: Partial<ConversationService> = {};
    const mockProviderRegistry: Partial<RuntimeProviderRegistry> = {
      resolve: vi.fn().mockReturnValue({ recoverOrphan: dockerRecoverOrphan }),
    };

    const prisma = makePrisma();
    prisma.runtimeResource.findMany.mockResolvedValue([
      {
        id: "rr-1",
        runtimeType: "sandbox",
        runtimeIsolationScope: "workspace",
        runtimeResourceId: "container-ws1",
        status: "running",
      },
      {
        id: "rr-2",
        runtimeType: "sandbox",
        runtimeIsolationScope: "user",
        runtimeResourceId: "container-user1",
        status: "running",
      },
    ]);

    const service = new RunRecoveryService(
      mockRunRecordService as RunRecordService,
      mockConversationService as ConversationService,
      mockProviderRegistry as RuntimeProviderRegistry,
      prisma as never
    );

    await service.recoverOrphanRuns();

    expect(prisma.runtimeResource.findMany).toHaveBeenCalledWith({
      where: { status: "running" },
    });
    expect(mockProviderRegistry.resolve).toHaveBeenCalledWith("sandbox");
    // user-scope 共享资源不主动 recoverOrphan，避免误杀其他 workspace 仍在用的共享容器
    expect(dockerRecoverOrphan).toHaveBeenCalledWith("container-ws1");
    expect(dockerRecoverOrphan).not.toHaveBeenCalledWith("container-user1");
    expect(dockerRecoverOrphan).toHaveBeenCalledTimes(1);

    expect(prisma.runtimeResource.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["rr-1", "rr-2"] } },
      data: { status: "stopped" },
    });
  });

  it("does nothing when there are no running RuntimeResource rows", async () => {
    const mockRunRecordService: Partial<RunRecordService> = {
      findAllActive: vi.fn().mockResolvedValue([]),
    };
    const mockConversationService: Partial<ConversationService> = {};
    const mockProviderRegistry: Partial<RuntimeProviderRegistry> = {
      resolve: vi.fn(),
    };

    const prisma = makePrisma();

    const service = new RunRecoveryService(
      mockRunRecordService as RunRecordService,
      mockConversationService as ConversationService,
      mockProviderRegistry as RuntimeProviderRegistry,
      prisma as never
    );

    await service.recoverOrphanRuns();

    expect(prisma.runtimeResource.findMany).toHaveBeenCalledWith({
      where: { status: "running" },
    });
    expect(mockProviderRegistry.resolve).not.toHaveBeenCalled();
    expect(prisma.runtimeResource.updateMany).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: spec — 移除前两个测试中现已无意义的 `execDocker` mock 注入**

在 "recovers orphan runs via the matching provider's recoverOrphan, based on runtimeType" 测试中删除：

```ts
    // Stub execDocker so recoverOrphanContainers does not call real docker
    service["execDocker"] = vi
      .fn()
      .mockResolvedValue({ stdout: "", stderr: "" });
```

在 "skips provider recovery when a run has no persisted runtimeResourceId" 测试中删除：

```ts
    service["execDocker"] = vi
      .fn()
      .mockResolvedValue({ stdout: "", stderr: "" });
```

这两个测试使用默认的 `makePrisma()`（`findMany` 返回 `[]`），`recoverOrphanContainers` 不会再调用 `execDocker`，故无需 stub。

- [ ] **Step 4: 运行测试确认失败（实现尚未修改）**

Run: `pnpm test:api -- runtime/core/run-recovery.service.spec.ts`
Expected: FAIL — `recoverOrphanContainers` 新测试报 `prisma.runtimeResource.findMany` 未被调用（当前实现走 `docker ps` 路径）。

- [ ] **Step 5: 实现 — 重写 `recoverOrphanContainers()`，复用 `shouldRecoverOrphanRuntime` 判断逻辑**

将第 114-159 行：

```ts
  private async recoverOrphanContainers(): Promise<void> {
    try {
      const containerNames: string[] = [];

      // Look for both workspace-scope and user-scope orphan containers
      for (const prefix of ["agework-ws-", "agework-user-"] as const) {
        try {
          const { stdout } = await this.execDocker("docker", [
            "ps",
            "-a",
            "--filter",
            `name=${prefix}`,
            "--format",
            "{{.Names}}",
          ], { timeout: 5000 });
          const names = stdout
            .split("\n")
            .map((name) => name.trim())
            .filter((name) => name.length > 0);
          containerNames.push(...names);
        } catch {
          // docker ps for this prefix failed — skip and try the next
        }
      }

      if (containerNames.length === 0) {
        this.logger.log("No orphan containers found.");
        return;
      }

      this.logger.warn(
        `Found ${containerNames.length} orphan container(s) — stopping them`
      );

      const dockerProvider = this.runtimeProviderRegistry.resolve("docker");
      for (const name of containerNames) {
        await dockerProvider
          .recoverOrphan(name)
          .catch(swallow(this.logger, `recover orphan container ${name}`));
      }
    } catch (err) {
      this.logger.warn(
        `Failed to recover orphan containers: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
```

替换为：

```ts
  /**
   * 服务重启前仍标记为 running 的 RuntimeResource，重启后内存态（scopeStates 等）已丢失，
   * 视为孤儿：调用对应 provider.recoverOrphan（stop+kill，不 rm，数据保留在磁盘上），
   * 然后统一标记为 stopped。"user" 隔离级别的共享资源跳过，避免误杀其他 workspace 仍在用的容器。
   */
  private async recoverOrphanContainers(): Promise<void> {
    try {
      const runningResources = await this.prisma.runtimeResource.findMany({
        where: { status: "running" },
      });

      if (runningResources.length === 0) {
        this.logger.log("No orphan containers found.");
        return;
      }

      this.logger.warn(
        `Found ${runningResources.length} orphan runtime resource(s) — stopping them`
      );

      for (const resource of runningResources) {
        if (resource.runtimeIsolationScope === "user") {
          this.logger.log(
            `Skipping recoverOrphan for user-scope runtime resource ${resource.runtimeResourceId}`
          );
          continue;
        }
        const provider = this.runtimeProviderRegistry.resolve(resource.runtimeType);
        await provider
          .recoverOrphan(resource.runtimeResourceId)
          .catch(
            swallow(
              this.logger,
              `recover orphan runtime resource ${resource.runtimeResourceId}`
            )
          );
      }

      await this.prisma.runtimeResource.updateMany({
        where: { id: { in: runningResources.map((r) => r.id) } },
        data: { status: "stopped" },
      });
    } catch (err) {
      this.logger.warn(
        `Failed to recover orphan containers: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
```

- [ ] **Step 6: 移除现已无用的 `execDocker`/`execFileAsync` 相关导入与字段**

确认 `execDocker` 字段不再被使用：

Run: `grep -n "execDocker\|execFileAsync\|execFile\|promisify" apps/api/src/runtime/core/run-recovery.service.ts`

预期只剩 import 与字段声明本身未被使用。删除以下内容：

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
```

```ts
const execFileAsync = promisify(execFile);
```

```ts
  /** Exposed for testing — allows overriding docker CLI execution. */
  protected execDocker = execFileAsync;
```

- [ ] **Step 7: 运行测试确认通过**

Run: `pnpm test:api -- runtime/core/run-recovery.service.spec.ts`
Expected: PASS（全部用例）

- [ ] **Step 8: 类型检查**

Run: `pnpm --filter @agework/api typecheck`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/runtime/core/run-recovery.service.ts apps/api/src/runtime/core/run-recovery.service.spec.ts
git commit -m "refactor(runtime): discover orphan containers via RuntimeResource(status=running) instead of docker ps name filters"
```

---

### Task 11: 全量验证

**Files:** 无新增改动，仅运行命令验证。

- [ ] **Step 1: 全量类型检查**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 2: 全量后端测试**

Run: `pnpm test:api`
Expected: PASS（全部测试套件）

- [ ] **Step 3: Lint**

Run: `pnpm lint`
Expected: PASS

不需要 commit（本 Task 仅验证；若发现问题，回到相应 Task 修复并补充 commit）。

---

## Self-Review 备注

- **Spec 覆盖**：
  - `engine.stop()` 统一为 stop-only → Task 5（Docker 实现）+ Task 8（释放路径不撤销 key）。
  - `SandboxEngine.resume()` 新增 → Task 1（接口）、Task 5（Docker 实现）、Task 8（provider 接入）。
  - 容器命名方案 A（去 `--name`，加 `--label`，删 `resourceName`） → Task 1/2/3/4/5/6/7/9。
  - resume 仅同进程内（`lastStoppedRuntimeResourceId`） → Task 8。
  - `run-recovery.service.ts` 基于 DB 重写 → Task 10。
  - workspace/用户删除路径保留 `revokeWorkspace` → 未改动（`shutdownRuntimeResourceByKey` 未在本计划中修改，Task 8 仅改 `releaseScopeRuntime`，两者已是不同方法，互不影响）。
- **Phase 1b（跨进程 resume、access key 持久化到 `RuntimeResource.metadata`）不在本计划范围内**，已在设计文档中标注为后续候选。
- **Phase 2（Eager Provisioning / `Workspace.runtimeIsolationScope` 字段）不在本计划范围内**，依赖本计划的 resume 能力落地后再设计。
