# Local Owner 长期复用 + Worker-Host IPC 接管(Phase 3)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `local` 放置机制从"一次 run 一个进程、`run` 模块直接持有 IPC channel"改造成"按 owner 长期复用一个 keep-alive 进程、`worker-host` 接管 channel 收发",跟 `sandbox` 走同一套 `worker-host` 编排/WorkerRegistry 记录路径。这是设计文档 `docs/superpowers/specs/2026-06-30-agent-run-new-architecture-design.md` 2.4 节明确要求的行为修正("local 也按 owner 长期复用,不是一次 run 一个新进程"),不是可选的美化。

**Architecture:**

现状核实(Phase 2 结束时):`apps/worker` 的 keep-alive 模式(`runKeepAliveWorker()`)已经存在,并且已经是"一个长期进程 + 每次 run 内部 fork 一个一次性 IPC 子进程执行"的模式——但目前只在 sandbox 容器内跑,顶层 keep-alive 进程本身永远用 `HttpTransport`(HTTP 长轮询)跟 `worker-host` 通信,硬编码在 `worker.ts` 里。`RunnerManager`/`WorkerCommands` 这两个类已经是完全 transport-agnostic 的(只依赖 `RunnerManagerClient`/`CommandClient` 接口,不知道背后是 HTTP 还是别的),这意味着**把 local 变成 keep-alive-over-IPC,不需要改这两个类一行代码**——只需要新建一个实现同样接口、背后走 `process.send`/`process.on('message')` 的 transport 类,并让 `worker.ts` 在 `AGEWORK_WORKER_CHANNEL=ipc` 时选它而不是 `HttpTransport`。

`apps/api` 一侧的改法完全平行于 Phase 2 已经跑通的 sandbox 编排模式:新建 `worker-host/local/LocalInstanceExecutor`(owner→channel 的长期映射、acquire/release/shutdown/recoverOrphan、WorkerRegistry 读写),`WorkerHostService` 新增 `acquireLocalInstanceForRun`/`releaseLocalInstanceForRun`/`recoverOrphanLocalInstance`/`shutdownLocalInstanceByOwnerId` 门面方法。**命令下发/事件接收对 `run` 模块调用方保持同一套方法名不变**(`workerHost.openSession()`/`workerHost.sendCommand()`)——`WorkerHostService` 内部按 ownerId 是否绑定着一个 IPC channel 分流:有 channel 就直接 `channel.send()`,没有就走原来的 HTTP 长轮询队列(`WorkerCommandDispatcher`)。这样 `run` 模块完全不需要知道 transport 是什么,`SandboxRunExecutor` 一行都不用改;`LocalRunExecutor` 则要重写成跟 `SandboxRunExecutor`同构的形状(不再自己拿着 channel 收发,而是像 sandbox 一样把 acquire/release/command 都转给 `worker-host`)。

**本轮明确排除、留白的范围(记录在案,不是遗漏)**:
- **local 不做 idle watchdog**。sandbox 的 idle 超时回收是因为容器有真实资源开销;fork 出的本地进程更轻量,而且用户已确认的 Phase 3 范围只提到"按 owner 长期复用、写 WorkerRegistry、worker-host 接管 channel",没有提"local 也要 idle 超时"。这次 local 实例只在两种情况下被回收:进程自己 crash/exit(`channel.on("exit")` 触发)、owner(workspace/user)被删除触发级联清理。要不要给 local 加 idle 超时,留给以后按需决定,不在这轮设计。
- **`AGEWORK_WORKER_KEEP_ALIVE`/`AGEWORK_WORKER_CHANNEL` 组合的鉴权**——本轮不做(呼应 Phase 1/2 一直沿用的"仍待讨论"第 1 条:自注册鉴权推迟)。
- 不改 `apps/worker` 里 `RunnerManager`/`WorkerCommands`/`main.ts` 的任何逻辑,只新增一个 transport 实现 + 一行 transport 选择逻辑。

## Global Constraints

- 后端命名规则见 `.claude/rules/backend-naming.md`,模块边界规则见 `.claude/rules/backend-architecture.md`——repository/internal provider 不导出,跨模块只调对方导出的根 Service,禁止 `forwardRef`,禁止循环依赖。**特别提醒**:Phase 2 的 Task 7 曾经因为"内部 provider 反过来注入根 Service"造成过一次真实的循环依赖(`WorkerHostService` ↔ `SandboxInstanceExecutor`),最终修复方案是内部 provider 只注入同模块的兄弟 provider(`WorkerRegistryRepository`/`WorkerCommandDispatcher`),不注入根 `WorkerHostService`。这一轮新建的 `LocalInstanceExecutor` **从设计上直接采用修复后的模式**:只注入 `RuntimeService`(下层)、`WorkerRegistryRepository`(同模块兄弟)、`WorkerUpstreamRegistry`(同模块兄弟),不注入 `WorkerHostService` 本身。
- `RuntimeInstance.transport` 字段(Prisma schema)已经在 Phase 1 加好,不需要新 migration——这次只是第一次真正在写入时显式设置它的值(sandbox 的 "http" 和 local 的 "ipc")。
- 每个 task 结束时代码库必须能通过 `pnpm --filter worker typecheck`(如果存在,否则确认 `apps/worker` 目录整体类型检查干净)、`pnpm --filter api typecheck`、`pnpm --filter api test`、`pnpm --filter api lint`,以及 `apps/worker` 自己的测试(`pnpm --filter worker test`,如果存在测试脚本)。
- 行为保持:sandbox 的现有行为完全不受影响(idle watchdog、owner 复用、admin 查询都不变)。local 的行为**会真正改变**(从一次性进程变成长期复用),这是本轮明确要做的,不是要避免的副作用。

---

### Task 1: `apps/worker` 新建 `IpcKeepAliveTransport`

**Files:**
- Create: `apps/worker/src/transport/ipc-keep-alive.ts`
- Create: `apps/worker/src/transport/ipc-keep-alive.spec.ts`

**Interfaces:**
- Produces: `IpcKeepAliveTransport` 类,同时实现 `commands.ts` 的 `CommandClient`(`pollCommands(waitMs)`/`emit(runId, msg)`)和 `runner-manager.ts` 的 `RunnerManagerClient`(`fetchRunConfig(runId)`/`emit(runId, msg)`/`cleanup(runId)`)。
- Consumes:`node:process` 的 `process.send`/`process.on("message")`(Node IPC,要求父进程用 `stdio: [..., "ipc"]` fork 出本进程,跟今天 local 的 one-shot 模式完全一样,只是这次是 keep-alive 进程本身用这条 channel,而不是它内部再 fork 出的一次性 runner)。`@agework/shared/protocol/rpc` 的编解码函数(`isRunConfigRpcNotification`/`rpcNotificationToRunConfigMessage`/`isWorkerCommandRpcRequest`/`rpcRequestToCommandMessage`/`commandResultMessageToRpcResponse`/`upstreamMessageToRpcNotification`,跟 `apps/worker/src/transport/ipc.ts` 用的是同一套)。

- [ ] **Step 1: 写失败的测试**

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { RunConfig, UpstreamMessage } from "@agework/shared/protocol";
import {
  commandMessageToRpcRequest,
  runConfigMessageToRpcNotification,
} from "@agework/shared/protocol/rpc";
import { IpcKeepAliveTransport } from "./ipc-keep-alive";

const processMock = vi.hoisted(() => ({
  send: vi.fn((_msg: unknown, cb?: (err: Error | null) => void) => {
    cb?.(null);
    return true;
  }),
  handlers: new Map<string, ((msg: unknown) => void)[]>(),
}));

function emitMessage(msg: unknown): void {
  for (const handler of processMock.handlers.get("message") ?? []) {
    handler(msg);
  }
}

describe("IpcKeepAliveTransport", () => {
  beforeEach(() => {
    processMock.send.mockClear();
    processMock.handlers.clear();
    vi.spyOn(process, "send").mockImplementation(
      processMock.send as unknown as typeof process.send
    );
    vi.spyOn(process, "on").mockImplementation(
      ((event: string, handler: (msg: unknown) => void) => {
        const list = processMock.handlers.get(event) ?? [];
        list.push(handler);
        processMock.handlers.set(event, list);
        return process;
      }) as typeof process.on
    );
  });

  describe("pollCommands", () => {
    it("resolves immediately with buffered commands received before polling", async () => {
      const transport = new IpcKeepAliveTransport();
      const message = commandMessageToRpcRequest({
        runId: "run-1",
        seq: 1,
        type: "user_message",
        payload: { type: "user_message", commandId: "cmd-1", runId: "run-1" },
        ts: "2026-01-01T00:00:00.000Z",
      });
      emitMessage(message);

      const commands = await transport.pollCommands(1000);

      expect(commands).toHaveLength(1);
      expect(commands[0].payload.commandId).toBe("cmd-1");
    });

    it("waits for a command to arrive within waitMs", async () => {
      const transport = new IpcKeepAliveTransport();
      const pending = transport.pollCommands(5000);

      const message = commandMessageToRpcRequest({
        runId: "run-1",
        seq: 1,
        type: "cancel",
        payload: { type: "cancel", commandId: "cmd-2", runId: "run-1" },
        ts: "2026-01-01T00:00:00.000Z",
      });
      emitMessage(message);

      const commands = await pending;
      expect(commands).toHaveLength(1);
      expect(commands[0].payload.commandId).toBe("cmd-2");
    });

    it("resolves with an empty array when waitMs elapses with nothing received", async () => {
      vi.useFakeTimers();
      const transport = new IpcKeepAliveTransport();
      const pending = transport.pollCommands(50);
      await vi.advanceTimersByTimeAsync(60);
      await expect(pending).resolves.toEqual([]);
      vi.useRealTimers();
    });

    it("resolves immediately with an empty array when waitMs is 0 and nothing is buffered", async () => {
      const transport = new IpcKeepAliveTransport();
      await expect(transport.pollCommands(0)).resolves.toEqual([]);
    });
  });

  describe("fetchRunConfig", () => {
    it("resolves once the matching run.config notification arrives, keyed by runId", async () => {
      const transport = new IpcKeepAliveTransport();
      const pending = transport.fetchRunConfig("run-7");

      const config = { runId: "run-7", conversationId: "c-7" } as RunConfig;
      emitMessage(
        runConfigMessageToRpcNotification({
          runId: "run-7",
          seq: 0,
          type: "run.config",
          payload: config,
          ts: "2026-01-01T00:00:00.000Z",
        })
      );

      await expect(pending).resolves.toEqual(config);
    });

    it("ignores a run.config notification for a different runId", async () => {
      const transport = new IpcKeepAliveTransport();
      const pending = transport.fetchRunConfig("run-8");

      emitMessage(
        runConfigMessageToRpcNotification({
          runId: "run-9",
          seq: 0,
          type: "run.config",
          payload: { runId: "run-9" } as RunConfig,
          ts: "2026-01-01T00:00:00.000Z",
        })
      );
      emitMessage(
        runConfigMessageToRpcNotification({
          runId: "run-8",
          seq: 0,
          type: "run.config",
          payload: { runId: "run-8" } as RunConfig,
          ts: "2026-01-01T00:00:00.000Z",
        })
      );

      await expect(pending).resolves.toEqual({ runId: "run-8" });
    });
  });

  describe("emit", () => {
    it("sends command.result payloads through process.send", async () => {
      const transport = new IpcKeepAliveTransport();
      const msg: UpstreamMessage = {
        runId: "run-1",
        seq: 1,
        type: "command.result",
        payload: { commandId: "cmd-1", commandType: "cancel", status: "ok" },
        ts: "",
      };

      await transport.emit("run-1", msg);

      expect(processMock.send).toHaveBeenCalledTimes(1);
    });

    it("sends other upstream messages as notifications through process.send", async () => {
      const transport = new IpcKeepAliveTransport();
      const msg: UpstreamMessage = {
        runId: "run-1",
        seq: 1,
        type: "run.status",
        payload: { status: "running" },
        ts: "",
      };

      await transport.emit("run-1", msg);

      expect(processMock.send).toHaveBeenCalledTimes(1);
    });

    it("rejects when process.send reports an error", async () => {
      processMock.send.mockImplementationOnce(
        (_msg: unknown, cb?: (err: Error | null) => void) => {
          cb?.(new Error("channel closed"));
          return false;
        }
      );
      const transport = new IpcKeepAliveTransport();

      await expect(
        transport.emit("run-1", {
          runId: "run-1",
          seq: 1,
          type: "run.status",
          payload: { status: "error" },
          ts: "",
        })
      ).rejects.toThrow("channel closed");
    });
  });

  describe("cleanup", () => {
    it("discards any pending fetchRunConfig wait for that runId without resolving or rejecting other runs", async () => {
      const transport = new IpcKeepAliveTransport();
      const pendingOther = transport.fetchRunConfig("run-keep");
      void transport.fetchRunConfig("run-drop");

      transport.cleanup("run-drop");

      emitMessage(
        runConfigMessageToRpcNotification({
          runId: "run-keep",
          seq: 0,
          type: "run.config",
          payload: { runId: "run-keep" } as RunConfig,
          ts: "2026-01-01T00:00:00.000Z",
        })
      );
      await expect(pendingOther).resolves.toEqual({ runId: "run-keep" });
    });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter worker test -- ipc-keep-alive.spec.ts`
Expected: FAIL(`Cannot find module './ipc-keep-alive'`)

- [ ] **Step 3: 创建 `ipc-keep-alive.ts`**

```ts
import type {
  CommandPayload,
  RunChannelMessage,
  RunConfig,
  UpstreamMessage,
  CommandResultPayload,
} from "@agework/shared/protocol";
import {
  commandResultMessageToRpcResponse,
  isRunConfigRpcNotification,
  isWorkerCommandRpcRequest,
  rpcNotificationToRunConfigMessage,
  rpcRequestToCommandMessage,
  upstreamMessageToRpcNotification,
} from "@agework/shared/protocol/rpc";
import type { CommandClient } from "../commands.js";
import type { RunnerManagerClient } from "../runner-manager.js";
import { errorDetails, workerLog } from "../logging/worker-log.js";

type PendingPoll = {
  resolve: (commands: RunChannelMessage<CommandPayload>[]) => void;
  timer?: ReturnType<typeof setTimeout>;
};

type PendingConfigFetch = {
  resolve: (config: RunConfig) => void;
};

/**
 * Keep-alive worker 的 IPC 版通信客户端。跟 HttpTransport 实现完全相同的
 * CommandClient/RunnerManagerClient 接口,背后走 process.send/process.on("message")
 * 而不是 HTTP 长轮询——RunnerManager/WorkerCommands 因此不需要认识这个类的存在。
 *
 * 命令用一个内存队列缓冲(process 推送式到达,pollCommands 拉取式消费,两者速率不
 * 匹配时靠这个队列做适配层);run config 按 runId 单独等待,因为同一个 keep-alive
 * 进程生命周期内会依次服务多个 run,每个 run 各自 fetch 一次。
 */
export class IpcKeepAliveTransport implements CommandClient, RunnerManagerClient {
  private readonly commandBuffer: RunChannelMessage<CommandPayload>[] = [];
  private readonly pollWaiters = new Set<PendingPoll>();
  private readonly configWaiters = new Map<string, PendingConfigFetch>();

  constructor() {
    if (!process.send) {
      throw new Error(
        "IpcKeepAliveTransport requires process to be forked with IPC"
      );
    }
    process.on("message", (msg: unknown) => this.handleMessage(msg));
  }

  pollCommands(
    waitMs = 0
  ): Promise<RunChannelMessage<CommandPayload>[]> {
    if (this.commandBuffer.length > 0) {
      return Promise.resolve(this.drainCommandBuffer());
    }
    if (waitMs <= 0) {
      return Promise.resolve([]);
    }
    return new Promise((resolve) => {
      const waiter: PendingPoll = { resolve };
      waiter.timer = setTimeout(() => {
        this.pollWaiters.delete(waiter);
        resolve([]);
      }, waitMs);
      this.pollWaiters.add(waiter);
    });
  }

  fetchRunConfig(runId: string): Promise<RunConfig> {
    return new Promise((resolve) => {
      this.configWaiters.set(runId, { resolve });
    });
  }

  async emit(runId: string, msg: UpstreamMessage): Promise<void> {
    const wireMessage =
      msg.type === "command.result"
        ? commandResultMessageToRpcResponse(
            msg as RunChannelMessage<CommandResultPayload>
          )
        : upstreamMessageToRpcNotification(msg);
    return new Promise<void>((resolve, reject) => {
      process.send!(wireMessage, (err: Error | null) => {
        if (err) {
          workerLog(
            "ipc keep-alive emit failed",
            { runId, type: msg.type, ...errorDetails(err) },
            "error"
          );
          reject(err);
        } else resolve();
      });
    });
  }

  cleanup(runId: string): void {
    this.configWaiters.delete(runId);
  }

  private handleMessage(msg: unknown): void {
    if (isRunConfigRpcNotification(msg)) {
      const message = rpcNotificationToRunConfigMessage(msg);
      const waiter = this.configWaiters.get(message.runId);
      if (waiter) {
        this.configWaiters.delete(message.runId);
        waiter.resolve(message.payload);
      }
      return;
    }
    if (isWorkerCommandRpcRequest(msg)) {
      const command = rpcRequestToCommandMessage(msg);
      this.commandBuffer.push(command);
      this.resolvePollWaiters();
    }
  }

  private drainCommandBuffer(): RunChannelMessage<CommandPayload>[] {
    const drained = this.commandBuffer.splice(0, this.commandBuffer.length);
    return drained;
  }

  private resolvePollWaiters(): void {
    if (this.commandBuffer.length === 0) return;
    for (const waiter of [...this.pollWaiters]) {
      this.pollWaiters.delete(waiter);
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(this.drainCommandBuffer());
      if (this.commandBuffer.length === 0) break;
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter worker test -- ipc-keep-alive.spec.ts`
Expected: PASS(11 个用例全过)

- [ ] **Step 5: 跑 typecheck**

Run: `pnpm --filter worker typecheck`(没有这个脚本就用 `pnpm --filter worker exec tsc --noEmit`)
Expected: 通过

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/transport/ipc-keep-alive.ts apps/worker/src/transport/ipc-keep-alive.spec.ts
git commit -m "feat(worker): add IpcKeepAliveTransport for owner-persistent local workers"
```

---

### Task 2: `worker.ts` 按 `AGEWORK_WORKER_CHANNEL` 选择 transport

**Files:**
- Modify: `apps/worker/src/worker.ts`
- Modify: `apps/worker/src/worker.spec.ts`(如果不存在就跳过这个文件,只在已有测试文件里补充用例;先用 `find apps/worker/src -name "worker.spec.ts"` 确认)

**Interfaces:**
- Consumes: `IpcKeepAliveTransport`(Task 1 产出)、已有的 `HttpTransport`。
- Produces: `runKeepAliveWorker()` 按环境变量分流,其余逻辑不变。

- [ ] **Step 1: 改 `worker.ts` 的 `runKeepAliveWorker()`**

顶部新增 import:

```ts
import { IpcKeepAliveTransport } from "./transport/ipc-keep-alive.js";
```

`runKeepAliveWorker()` 函数开头,从:

```ts
async function runKeepAliveWorker() {
  const client = new HttpTransport();
```

改成:

```ts
async function runKeepAliveWorker() {
  const client = resolveKeepAliveClient();
```

在文件末尾(`function emitStatus` 之前或任意合适位置)新增:

```ts
function resolveKeepAliveClient(): HttpTransport | IpcKeepAliveTransport {
  const channel = process.env.AGEWORK_WORKER_CHANNEL;
  if (channel === "ipc") {
    return new IpcKeepAliveTransport();
  }
  return new HttpTransport();
}
```

`RunnerManager`/`WorkerCommands` 的构造调用不需要改——它们已经只依赖接口,`HttpTransport`/`IpcKeepAliveTransport` 两者都满足。

- [ ] **Step 2: 确认现有 keep-alive 相关测试(如果存在)仍然通过**

Run: `find apps/worker/src -iname "*worker*.spec.ts" -not -path "*worker-log*"`,对找到的文件跑:
Run: `pnpm --filter worker test -- <找到的文件名>`
Expected: PASS(如果这类文件里对 `runKeepAliveWorker` 有直接单测,确认没有因为返回类型变化而破坏;如果没有直接测试这个函数,这一步不需要新增测试——`resolveKeepAliveClient` 的分流逻辑已经被 Task 1 的 `IpcKeepAliveTransport` 自身测试 + Task 4/5 的集成场景间接覆盖,这里不强行为一个 4 行的分流函数单开测试文件)

- [ ] **Step 3: 跑 typecheck**

Run: `pnpm --filter worker typecheck`(或 `pnpm --filter worker exec tsc --noEmit`)
Expected: 通过

- [ ] **Step 4: Commit**

```bash
git add apps/worker/src/worker.ts
git commit -m "feat(worker): select IpcKeepAliveTransport when AGEWORK_WORKER_CHANNEL=ipc"
```

---

### Task 3: `WorkerRegistryRepository.upsertRunning` 泛化(接受通用 placement 原语 + 显式 `transport`)

**Files:**
- Modify: `apps/api/src/worker-host/registry/worker-registry.repository.ts`
- Modify: `apps/api/src/worker-host/registry/worker-registry.repository.spec.ts`
- Modify: `apps/api/src/worker-host/registry/worker-registry-metadata.ts`
- Modify: `apps/api/src/worker-host/registry/worker-registry-metadata.spec.ts`
- Modify: `apps/api/src/worker-host/worker-host.service.ts`
- Modify: `apps/api/src/worker-host/worker-host.service.spec.ts`
- Modify: `apps/api/src/worker-host/sandbox/sandbox-instance.executor.ts`
- Modify: `apps/api/src/worker-host/sandbox/sandbox-instance.executor.spec.ts`

**Interfaces:**
- Produces: `WorkerRegistryRepository.upsertRunning(input: UpsertRunningInput, runtimeInstanceId, transport, metadata?)`,其中 `UpsertRunningInput = { runtimeType: string; isolationScope: string; workspaceId: string; ownerId: string }`(通用原语,不再要求 `SandboxRuntimePlacement` 整个对象)。`runningInstanceMetadata()` 同步改签名(不再读 `placement.sandbox.isolationScope`/`placement.runtimeType`,直接接受同样的通用字段)。`WorkerHostService.upsertRunningRuntime` 同步改签名并新增 `transport` 参数。
- Consumes(改造后):`SandboxInstanceExecutor.recordWorkspaceRuntime` 改传通用原语 + `"http"`。

- [ ] **Step 1: 改 `worker-registry-metadata.ts` 的 `runningInstanceMetadata`**

把入参从:

```ts
export function runningInstanceMetadata(input: {
  placement: RuntimePlacement;
  ownerId: string;
  runtimeInstanceId: string;
  existing?: unknown;
  metadata?: object;
  now?: Date;
}): RuntimeInstanceDiagnosticMetadata {
  const now = (input.now ?? new Date()).toISOString();
  return {
    ...(isMetadataRecord(input.existing) ? input.existing : {}),
    ...(input.metadata ?? {}),
    ownerId: input.ownerId,
    workspaceId: input.placement.workspaceId,
    statusReason: "running",
    lastSeenAt: now,
    lastStartedAt: now,
    runtimeInstanceId: input.runtimeInstanceId,
  };
}
```

改成:

```ts
export function runningInstanceMetadata(input: {
  workspaceId: string;
  ownerId: string;
  runtimeInstanceId: string;
  existing?: unknown;
  metadata?: object;
  now?: Date;
}): RuntimeInstanceDiagnosticMetadata {
  const now = (input.now ?? new Date()).toISOString();
  return {
    ...(isMetadataRecord(input.existing) ? input.existing : {}),
    ...(input.metadata ?? {}),
    ownerId: input.ownerId,
    workspaceId: input.workspaceId,
    statusReason: "running",
    lastSeenAt: now,
    lastStartedAt: now,
    runtimeInstanceId: input.runtimeInstanceId,
  };
}
```

顶部 `import type { RuntimePlacement } from "@agework/shared/protocol";`(如果只被这一处使用)删掉这一行。

- [ ] **Step 2: 改 `worker-registry-metadata.spec.ts` 里 `runningInstanceMetadata` 的两个用例**

把两处调用里的:

```ts
      placement: {
        runtimeType: "sandbox",
        workspaceId: "ws-1",
        userId: "user-1",
        hostPath: "/host",
        runtimePath: "/container",
        sandbox: { isolationScope: "workspace", mountTarget: "/container", sandboxEngineType: "docker" },
      } as any,
```

改成:

```ts
      workspaceId: "ws-1",
```

其余断言不变(`result.workspaceId`/`result.ownerId` 等断言逻辑不受影响)。

- [ ] **Step 3: 跑 metadata 测试确认通过**

Run: `pnpm --filter api test -- worker-registry-metadata.spec.ts`
Expected: PASS

- [ ] **Step 4: 改 `worker-registry.repository.ts` 的 `upsertRunning`**

新增一个导出类型(放在文件顶部,`ownerWhere` 函数之前):

```ts
export type UpsertRunningInput = {
  runtimeType: string;
  isolationScope: string;
  workspaceId: string;
  ownerId: string;
};
```

`upsertRunning` 方法,从:

```ts
  async upsertRunning(
    placement: SandboxRuntimePlacement,
    ownerId: string,
    runtimeInstanceId: string,
    metadata?: object
  ) {
    const where = ownerWhere(
      placement.runtimeType,
      placement.sandbox.isolationScope,
      ownerId
    );
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.runtimeInstance.findFirst({ where });
      const data = {
        runtimeInstanceId,
        status: "running",
        expiresAt: null,
        metadata: runtimeInstanceMetadataJson(
          runningInstanceMetadata({
            placement,
            ownerId,
            runtimeInstanceId,
            existing: existing?.metadata,
            metadata,
          })
        ),
      };
      const resource = existing
        ? await tx.runtimeInstance.update({
            where: { id: existing.id },
            data,
          })
        : await tx.runtimeInstance.create({
            data: {
              id: generateId(),
              ...where,
              ...data,
            },
          });
      const workspaceRuntimeInstance = await tx.workspaceRuntimeInstance.upsert(
        {
          where: { workspaceId: placement.workspaceId },
          create: {
            id: generateId(),
            workspaceId: placement.workspaceId,
            resourceId: resource.id,
          },
          update: {
            resourceId: resource.id,
          },
        }
      );
      return { resource, workspaceRuntimeInstance };
    });
  }
```

改成:

```ts
  async upsertRunning(
    input: UpsertRunningInput,
    runtimeInstanceId: string,
    transport: string,
    metadata?: object
  ) {
    const where = ownerWhere(
      input.runtimeType,
      input.isolationScope,
      input.ownerId
    );
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.runtimeInstance.findFirst({ where });
      const data = {
        runtimeInstanceId,
        transport,
        status: "running",
        expiresAt: null,
        metadata: runtimeInstanceMetadataJson(
          runningInstanceMetadata({
            workspaceId: input.workspaceId,
            ownerId: input.ownerId,
            runtimeInstanceId,
            existing: existing?.metadata,
            metadata,
          })
        ),
      };
      const resource = existing
        ? await tx.runtimeInstance.update({
            where: { id: existing.id },
            data,
          })
        : await tx.runtimeInstance.create({
            data: {
              id: generateId(),
              ...where,
              ...data,
            },
          });
      const workspaceRuntimeInstance = await tx.workspaceRuntimeInstance.upsert(
        {
          where: { workspaceId: input.workspaceId },
          create: {
            id: generateId(),
            workspaceId: input.workspaceId,
            resourceId: resource.id,
          },
          update: {
            resourceId: resource.id,
          },
        }
      );
      return { resource, workspaceRuntimeInstance };
    });
  }
```

顶部 `import type { SandboxRuntimePlacement } from "@agework/shared/protocol";` 这一行,如果本文件其余部分不再用到就删掉(用 `grep -n SandboxRuntimePlacement` 确认)。

- [ ] **Step 5: 改 `worker-registry.repository.spec.ts` 里 `upsertRunning` 的两个用例**

`describe("upsertRunning", ...)` 块里的 `placement` fixture,从:

```ts
    const placement = {
      runtimeType: "sandbox",
      workspaceId: "ws-1",
      userId: "user-1",
      hostPath: "/host",
      runtimePath: "/container",
      sandbox: {
        isolationScope: "workspace",
        mountTarget: "/container",
        sandboxEngineType: "docker",
      },
    } as any;
```

改成:

```ts
    const upsertInput = {
      runtimeType: "sandbox",
      isolationScope: "workspace",
      workspaceId: "ws-1",
      ownerId: "ws-1",
    };
```

两处调用:

```ts
      const result = await repository.upsertRunning(
        placement,
        "ws-1",
        "inst-1"
      );
```

改成:

```ts
      const result = await repository.upsertRunning(
        upsertInput,
        "inst-1",
        "http"
      );
```

同理另一处 `await repository.upsertRunning(placement, "ws-1", "inst-2");` 改成 `await repository.upsertRunning(upsertInput, "inst-2", "http");`。断言里的 `expect.objectContaining({ data: expect.objectContaining({ runtimeType: "sandbox", ... }) })` 补一条 `transport: "http"`:

```ts
      expect(prisma.runtimeInstance.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            runtimeType: "sandbox",
            isolationScope: "workspace",
            ownerId: "ws-1",
            runtimeInstanceId: "inst-1",
            transport: "http",
            status: "running",
          }),
        })
      );
```

- [ ] **Step 6: 跑 repository 测试确认通过**

Run: `pnpm --filter api test -- worker-registry.repository.spec.ts`
Expected: PASS

- [ ] **Step 7: 改 `worker-host.service.ts` 的 `upsertRunningRuntime`**

从:

```ts
  /** 记录一个 runtime 实例进入 running 状态,不存在则创建、存在则更新。 */
  upsertRunningRuntime(
    placement: SandboxRuntimePlacement,
    ownerId: string,
    runtimeInstanceId: string,
    metadata?: object
  ) {
    return this.registry.upsertRunning(
      placement,
      ownerId,
      runtimeInstanceId,
      metadata
    );
  }
```

Wait — 这个方法在 Phase 2 的最后一次清理里已经被删除(它被判定为 dead code,只剩 `SandboxInstanceExecutor` 一个消费方,而 `SandboxInstanceExecutor` 早已改成直接注入 `WorkerRegistryRepository`)。**这一步实际不需要改 `worker-host.service.ts`**——`upsertRunningRuntime` 已经不存在了。跳过这个 Step,直接进入 Step 8。

- [ ] **Step 8: 改 `sandbox-instance.executor.ts` 的 `recordWorkspaceRuntime`**

从:

```ts
  private recordWorkspaceRuntime(
    placement: SandboxRuntimePlacement,
    ownerId: string,
    runtimeInstanceId: string
  ): Promise<void> {
    return this.registry
      .upsertRunning(placement, ownerId, runtimeInstanceId)
      .then(() => undefined)
      .catch(swallow(this.logger, `upsert workspace runtime for owner ${ownerId}`));
  }
```

(注:方法体里调 `this.registry.upsertRunning`,不是 `this.workerHost.upsertRunningRuntime`——这是 Task 7 循环依赖修复后的现状,`SandboxInstanceExecutor` 直接持有 `WorkerRegistryRepository`。)

改成:

```ts
  private recordWorkspaceRuntime(
    placement: SandboxRuntimePlacement,
    ownerId: string,
    runtimeInstanceId: string
  ): Promise<void> {
    return this.registry
      .upsertRunning(
        {
          runtimeType: placement.runtimeType,
          isolationScope: placement.sandbox.isolationScope,
          workspaceId: placement.workspaceId,
          ownerId,
        },
        runtimeInstanceId,
        "http"
      )
      .then(() => undefined)
      .catch(swallow(this.logger, `upsert workspace runtime for owner ${ownerId}`));
  }
```

- [ ] **Step 9: 改 `sandbox-instance.executor.spec.ts` 里对 `registry.upsertRunning`(命名可能是 `upsertRunning` 或经由 mock 对象的 `upsertRunningRuntime` 字段,以实际文件当前内容为准——用 `grep -n "upsertRunning" apps/api/src/worker-host/sandbox/sandbox-instance.executor.spec.ts` 确认)的断言**

调用参数从 `(expect.objectContaining({ ownerId: "ws-1" }), "ws-1", "docker-resource-1")` 这种"整个 placement 对象"形状,改成断言通用原语对象 + `"http"`:

```ts
    expect(workerHost.upsertRunning).toHaveBeenCalledWith(
      {
        runtimeType: "sandbox",
        isolationScope: "workspace",
        workspaceId: "ws-1",
        ownerId: "ws-1",
      },
      "docker-resource-1",
      "http"
    );
```

(如果 spec 里 mock 对象字段名是 `upsertRunningRuntime` 而不是 `upsertRunning`,先按 Step 8 实际改成的方法名对齐 mock 字段名和断言方法名——保持 mock 对象结构与被测类真实注入的 `WorkerRegistryRepository`/`RuntimeService`/`ConfigService` 三个依赖一致。)

- [ ] **Step 10: 跑测试确认通过**

Run: `pnpm --filter api test -- worker-host/sandbox`
Expected: PASS

- [ ] **Step 11: 跑 typecheck + 全量测试**

Run: `pnpm --filter api typecheck && pnpm --filter api test`
Expected: 全部通过

- [ ] **Step 12: Commit**

```bash
git add apps/api/src/worker-host/registry apps/api/src/worker-host/sandbox
git commit -m "refactor(api): generalize WorkerRegistryRepository.upsertRunning to accept transport + generic placement"
```

---

### Task 4: 新建 `worker-host/local/LocalInstanceExecutor`(owner 长期复用 + WorkerRegistry 读写,暂不接线)

**Files:**
- Create: `apps/api/src/worker-host/local/local-instance.executor.ts`
- Create: `apps/api/src/worker-host/local/local-instance.executor.spec.ts`

**Interfaces:**
- Produces: `LocalInstanceExecutor`(构造函数注入 `RuntimeService`、`WorkerRegistryRepository`、`WorkerUpstreamRegistry`——**不注入 `WorkerHostService`**,理由见本文档开头的循环依赖提醒),暴露 `acquireInstanceForRun(input)`、`releaseInstanceForRun(runId)`(no-op,local 本轮不做 idle 回收,仅为跟 `SandboxRunExecutor` 调用形状对齐)、`sendCommand(ownerId, command)`、`openSession(ownerId, runConfig)`、`getChannel(ownerId)`(供 `WorkerHostService` 判断某 owner 是否走 IPC)、`shutdownRuntimeInstanceByOwnerId(ownerId)`、`recoverOrphan(runtimeInstanceId)`。
- Consumes:`RuntimeService.launchLocal`/`recoverOrphanLocal`(Phase 2 产出)、`WorkerRegistryRepository.upsertRunning`(Task 3 泛化后的签名)/`findActiveByWorkspace`/`markStoppedByOwner`、`WorkerUpstreamRegistry.sendEvent`。

- [ ] **Step 1: 写失败的测试**

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import { LocalInstanceExecutor } from "./local-instance.executor";

function makeChannel() {
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  return {
    pid: 4242,
    send: vi.fn(),
    kill: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),
    emit(event: string, ...args: unknown[]) {
      for (const handler of handlers.get(event) ?? []) handler(...args);
    },
  };
}

function makeRuntimeService(channel = makeChannel()) {
  return {
    launchLocal: vi.fn().mockReturnValue({
      runtimeInstanceId: "4242:token-1",
      channel,
    }),
    recoverOrphanLocal: vi.fn().mockResolvedValue(undefined),
  };
}

function makeRegistry() {
  return {
    findActiveByWorkspace: vi.fn().mockResolvedValue(null),
    upsertRunning: vi.fn().mockResolvedValue({
      resource: { id: "rr-1" },
      workspaceRuntimeInstance: { id: "wr-1" },
    }),
    markStoppedByOwner: vi.fn().mockResolvedValue(undefined),
  };
}

function makeUpstream() {
  return { sendEvent: vi.fn().mockResolvedValue(undefined) };
}

function makeExecutor(overrides: {
  runtimeService?: ReturnType<typeof makeRuntimeService>;
  registry?: ReturnType<typeof makeRegistry>;
  upstream?: ReturnType<typeof makeUpstream>;
} = {}) {
  const runtimeService = overrides.runtimeService ?? makeRuntimeService();
  const registry = overrides.registry ?? makeRegistry();
  const upstream = overrides.upstream ?? makeUpstream();
  const executor = new LocalInstanceExecutor(
    runtimeService as never,
    registry as never,
    upstream as never
  );
  return { executor, runtimeService, registry, upstream };
}

describe("LocalInstanceExecutor", () => {
  describe("acquireInstanceForRun", () => {
    it("launches a new keep-alive process, registers the channel, and writes WorkerRegistry when no active binding exists", async () => {
      const { executor, runtimeService, registry } = makeExecutor();

      const result = await executor.acquireInstanceForRun({
        runConfig: { runId: "run-1", workspaceId: "ws-1" } as never,
        runtimeTarget: { runtimeType: "local", ownerId: "ws-1", workspaceId: "ws-1" } as never,
      });

      expect(runtimeService.launchLocal).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "run-1",
          env: expect.objectContaining({
            AGEWORK_WORKER_KEEP_ALIVE: "true",
            AGEWORK_WORKER_CHANNEL: "ipc",
          }),
        })
      );
      expect(registry.upsertRunning).toHaveBeenCalledWith(
        {
          runtimeType: "local",
          isolationScope: "workspace",
          workspaceId: "ws-1",
          ownerId: "ws-1",
        },
        "4242:token-1",
        "ipc"
      );
      expect(result).toEqual({ outcome: "ready", runtimeInstanceId: "4242:token-1" });
    });

    it("reuses an existing live channel for the same owner without launching a new process", async () => {
      const { executor, runtimeService } = makeExecutor();
      await executor.acquireInstanceForRun({
        runConfig: { runId: "run-1", workspaceId: "ws-1" } as never,
        runtimeTarget: { runtimeType: "local", ownerId: "ws-1", workspaceId: "ws-1" } as never,
      });
      runtimeService.launchLocal.mockClear();

      const result = await executor.acquireInstanceForRun({
        runConfig: { runId: "run-2", workspaceId: "ws-1" } as never,
        runtimeTarget: { runtimeType: "local", ownerId: "ws-1", workspaceId: "ws-1" } as never,
      });

      expect(runtimeService.launchLocal).not.toHaveBeenCalled();
      expect(result).toEqual({ outcome: "ready", runtimeInstanceId: "4242:token-1" });
    });
  });

  describe("channel exit handling", () => {
    it("marks the owner stopped in WorkerRegistry and removes the in-memory binding when the process exits", async () => {
      const channel = makeChannel();
      const runtimeService = makeRuntimeService(channel);
      const { executor, registry } = makeExecutor({ runtimeService });
      await executor.acquireInstanceForRun({
        runConfig: { runId: "run-1", workspaceId: "ws-1" } as never,
        runtimeTarget: { runtimeType: "local", ownerId: "ws-1", workspaceId: "ws-1" } as never,
      });

      channel.emit("exit", 1);
      await Promise.resolve();

      expect(registry.markStoppedByOwner).toHaveBeenCalledWith(
        "local",
        "workspace",
        "ws-1"
      );
      expect(executor.getChannel("ws-1")).toBeUndefined();
    });
  });

  describe("sendCommand / openSession", () => {
    it("sends commands directly over the registered channel", async () => {
      const channel = makeChannel();
      const runtimeService = makeRuntimeService(channel);
      const { executor } = makeExecutor({ runtimeService });
      await executor.acquireInstanceForRun({
        runConfig: { runId: "run-1", workspaceId: "ws-1" } as never,
        runtimeTarget: { runtimeType: "local", ownerId: "ws-1", workspaceId: "ws-1" } as never,
      });
      channel.send.mockClear();

      executor.sendCommand("ws-1", { type: "cancel", commandId: "cmd-1", runId: "run-1" } as never);

      expect(channel.send).toHaveBeenCalledTimes(1);
    });

    it("sends the run config over the channel on openSession", async () => {
      const channel = makeChannel();
      const runtimeService = makeRuntimeService(channel);
      const { executor } = makeExecutor({ runtimeService });
      await executor.acquireInstanceForRun({
        runConfig: { runId: "run-1", workspaceId: "ws-1" } as never,
        runtimeTarget: { runtimeType: "local", ownerId: "ws-1", workspaceId: "ws-1" } as never,
      });
      channel.send.mockClear();

      executor.openSession("ws-1", { runId: "run-1", workspaceId: "ws-1" } as never);

      expect(channel.send).toHaveBeenCalledTimes(1);
    });
  });

  describe("shutdownRuntimeInstanceByOwnerId", () => {
    it("kills the channel, marks WorkerRegistry stopped, and clears the in-memory binding", async () => {
      const channel = makeChannel();
      const runtimeService = makeRuntimeService(channel);
      const { executor, registry } = makeExecutor({ runtimeService });
      await executor.acquireInstanceForRun({
        runConfig: { runId: "run-1", workspaceId: "ws-1" } as never,
        runtimeTarget: { runtimeType: "local", ownerId: "ws-1", workspaceId: "ws-1" } as never,
      });

      executor.shutdownRuntimeInstanceByOwnerId("ws-1");

      expect(channel.kill).toHaveBeenCalledWith("SIGTERM");
      expect(registry.markStoppedByOwner).toHaveBeenCalledWith(
        "local",
        "workspace",
        "ws-1"
      );
      expect(executor.getChannel("ws-1")).toBeUndefined();
    });

    it("is a no-op when the owner has no registered channel", () => {
      const { executor, registry } = makeExecutor();
      expect(() => executor.shutdownRuntimeInstanceByOwnerId("unknown")).not.toThrow();
      expect(registry.markStoppedByOwner).not.toHaveBeenCalled();
    });
  });

  describe("recoverOrphan", () => {
    it("delegates to RuntimeService.recoverOrphanLocal", async () => {
      const { executor, runtimeService } = makeExecutor();
      await executor.recoverOrphan("4242:token-1");
      expect(runtimeService.recoverOrphanLocal).toHaveBeenCalledWith("4242:token-1");
    });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter api test -- local-instance.executor.spec.ts`
Expected: FAIL(`Cannot find module './local-instance.executor'`)

- [ ] **Step 3: 创建 `local-instance.executor.ts`**

```ts
import { Injectable, Logger } from "@nestjs/common";
import type { ChildProcess } from "node:child_process";
import type {
  AcquireInstanceResult,
  CommandPayload,
  RunConfig,
  WorkerExecutionStartInput,
} from "@agework/shared/protocol";
import {
  commandMessageToRpcRequest,
  isWorkerCommandResultRpcResponse,
  isWorkerEventRpcNotification,
  rpcNotificationToUpstreamMessage,
  rpcResponseToCommandResultMessage,
  runConfigMessageToRpcNotification,
} from "@agework/shared/protocol/rpc";
import { RuntimeService } from "../../runtime/runtime.service";
import { WorkerRegistryRepository } from "../registry/worker-registry.repository";
import { WorkerUpstreamRegistry } from "../upstream/worker-upstream.registry";
import { swallow } from "../../common/swallow";
import { safeLogJson } from "../../common/logging";

type LocalOwnerState = {
  runtimeInstanceId: string;
  channel: ChildProcess;
  commandSeq: number;
};

/**
 * local 实例编排:owner 长期复用一个 keep-alive 进程,`worker-host` 直接持有并接管
 * IPC channel 收发——跟 sandbox 走同一套 WorkerRegistry 记录路径,但物理载体是
 * fork 出的进程而不是容器。本轮不做 idle 回收(见计划文档 Architecture 一节),
 * 只在进程 exit 或显式 owner 删除时释放。
 *
 * 只注入 RuntimeService(下层)、WorkerRegistryRepository/WorkerUpstreamRegistry
 * (同模块兄弟 provider),不注入 WorkerHostService 本身——避免重蹈 Phase 2 Task 7
 * 那次循环依赖的覆辙。
 */
@Injectable()
export class LocalInstanceExecutor {
  private readonly logger = new Logger(LocalInstanceExecutor.name);
  private readonly ownerStates = new Map<string, LocalOwnerState>();

  constructor(
    private readonly runtimeService: RuntimeService,
    private readonly registry: WorkerRegistryRepository,
    private readonly upstream: WorkerUpstreamRegistry
  ) {}

  getChannel(ownerId: string): ChildProcess | undefined {
    return this.ownerStates.get(ownerId)?.channel;
  }

  async acquireInstanceForRun(
    input: WorkerExecutionStartInput
  ): Promise<AcquireInstanceResult> {
    const ownerId = input.runtimeTarget.ownerId;
    const workspaceId = input.runConfig.workspaceId;
    const existing = this.ownerStates.get(ownerId);
    if (existing) {
      return { outcome: "ready", runtimeInstanceId: existing.runtimeInstanceId };
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

    const state: LocalOwnerState = { runtimeInstanceId, channel, commandSeq: 0 };
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

  /** local 本轮不做 idle 回收,保留方法只为跟 SandboxRunExecutor 的调用形状对齐。 */
  releaseInstanceForRun(_runId: string): void {
    // no-op
  }

  openSession(ownerId: string, runConfig: RunConfig): void {
    const state = this.ownerStates.get(ownerId);
    if (!state) return;
    state.channel.send(
      runConfigMessageToRpcNotification({
        runId: runConfig.runId,
        seq: 0,
        type: "run.config",
        payload: runConfig,
        ts: new Date().toISOString(),
      })
    );
  }

  sendCommand(ownerId: string, command: CommandPayload): void {
    const state = this.ownerStates.get(ownerId);
    if (!state) {
      this.logger.warn(
        `local send command dropped ${safeLogJson({ ownerId, commandType: command.type, reason: "no_active_state" })}`
      );
      return;
    }
    state.commandSeq += 1;
    state.channel.send(
      commandMessageToRpcRequest({
        runId: command.runId ?? "",
        seq: state.commandSeq,
        type: command.type,
        payload: command,
        ts: new Date().toISOString(),
      })
    );
  }

  shutdownRuntimeInstanceByOwnerId(ownerId: string): void {
    const state = this.ownerStates.get(ownerId);
    if (!state) return;
    try {
      if (!state.channel.killed) {
        state.channel.kill("SIGTERM");
      }
    } catch (err) {
      this.logger.warn(
        `terminate local keep-alive worker failed ${safeLogJson({ ownerId, ...swallowFields(err) })}`
      );
    }
    this.registry
      .markStoppedByOwner("local", "workspace", ownerId)
      .catch(swallow(this.logger, `mark local runtime stopped for owner ${ownerId}`));
    this.ownerStates.delete(ownerId);
  }

  recoverOrphan(runtimeInstanceId: string): Promise<void> {
    return this.runtimeService.recoverOrphanLocal(runtimeInstanceId);
  }

  private attachChannelListeners(ownerId: string, channel: ChildProcess): void {
    channel.on("message", (msg: unknown) => {
      const message = normalizeIpcMessage(msg);
      if (!message) return;
      this.upstream.sendEvent(message.runId, message).catch((err) => {
        this.logger.warn(
          `local worker message forward failed ${safeLogJson({ ownerId, ...swallowFields(err) })}`
        );
      });
    });

    channel.on("exit", (code) => {
      this.logger.warn(
        `local keep-alive worker exited ${safeLogJson({ ownerId, code })}`
      );
      this.registry
        .markStoppedByOwner("local", "workspace", ownerId)
        .catch(swallow(this.logger, `mark local runtime stopped for owner ${ownerId}`));
      this.ownerStates.delete(ownerId);
    });
  }
}

function normalizeIpcMessage(msg: unknown) {
  if (isWorkerEventRpcNotification(msg)) {
    return rpcNotificationToUpstreamMessage(msg);
  }
  if (isWorkerCommandResultRpcResponse(msg)) {
    return rpcResponseToCommandResultMessage(msg, { runId: "" });
  }
  return undefined;
}

function swallowFields(err: unknown): { error: string } {
  return { error: err instanceof Error ? err.message : String(err) };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter api test -- local-instance.executor.spec.ts`
Expected: PASS(9 个用例全过)

- [ ] **Step 5: 跑 typecheck**

Run: `pnpm --filter api typecheck`
Expected: 通过(新文件未接线,不影响其他文件)

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/worker-host/local
git commit -m "feat(api): add LocalInstanceExecutor for owner-persistent local workers (not wired yet)"
```

---

### Task 5: `WorkerHostService` 接入 `LocalInstanceExecutor`,`sendCommand`/`openSession` 按 transport 分流

**Files:**
- Modify: `apps/api/src/worker-host/worker-host.service.ts`
- Modify: `apps/api/src/worker-host/worker-host.service.spec.ts`
- Modify: `apps/api/src/worker-host/worker-host.module.ts`

**Interfaces:**
- Produces:`WorkerHostService` 新增 `acquireLocalInstanceForRun`/`releaseLocalInstanceForRun`/`recoverOrphanLocalInstance`/`shutdownLocalInstanceByOwnerId`。既有的 `sendCommand(ownerId, runId, command)`/`openSession(params)` 改为按 `localInstances.getChannel(ownerId)` 是否存在分流:存在则直接经 `LocalInstanceExecutor` 走 channel,不存在则走原有 `WorkerCommandDispatcher`(HTTP 长轮询队列)。`run` 模块的调用方(`SandboxRunExecutor`、Task 6 改造后的 `LocalRunExecutor`)完全不需要感知这条分流。

- [ ] **Step 1: 改 `worker-host.service.ts`**

顶部新增 import:

```ts
import { LocalInstanceExecutor } from "./local/local-instance.executor";
```

构造函数新增参数:

```ts
  constructor(
    private readonly endpointHandler: WorkerEndpointHandler,
    private readonly upstream: WorkerUpstreamRegistry,
    private readonly commandDispatcher: WorkerCommandDispatcher,
    private readonly registry: WorkerRegistryRepository,
    private readonly runtimeService: RuntimeService,
    private readonly sandboxInstances: SandboxInstanceExecutor,
    private readonly localInstances: LocalInstanceExecutor
  ) {}
```

`openSession`/`sendCommand`/`cleanupByOwnerId` 三个方法,从:

```ts
  openSession(params: {
    runId: string;
    ownerId: string;
    runConfig: RunConfig;
  }): void {
    this.commandDispatcher.openSession(params);
  }

  sendCommand(ownerId: string, runId: string, command: CommandPayload): void {
    this.commandDispatcher.sendCommand(ownerId, runId, command);
  }

  cleanupRun(runId: string): void {
    this.commandDispatcher.cleanupRun(runId);
  }

  cleanupByOwnerId(ownerId: string): void {
    this.commandDispatcher.cleanupByOwnerId(ownerId);
  }
```

改成:

```ts
  openSession(params: {
    runId: string;
    ownerId: string;
    runConfig: RunConfig;
  }): void {
    if (this.localInstances.getChannel(params.ownerId)) {
      this.localInstances.openSession(params.ownerId, params.runConfig);
      return;
    }
    this.commandDispatcher.openSession(params);
  }

  sendCommand(ownerId: string, runId: string, command: CommandPayload): void {
    if (this.localInstances.getChannel(ownerId)) {
      this.localInstances.sendCommand(ownerId, command);
      return;
    }
    this.commandDispatcher.sendCommand(ownerId, runId, command);
  }

  cleanupRun(runId: string): void {
    this.commandDispatcher.cleanupRun(runId);
  }

  cleanupByOwnerId(ownerId: string): void {
    this.commandDispatcher.cleanupByOwnerId(ownerId);
  }
```

(`cleanupRun`/`cleanupByOwnerId` 不需要分流——`WorkerCommandDispatcher.cleanupByOwnerId` 只清理 HTTP 队列侧的内存态,对没有 HTTP 队列条目的 IPC owner 是天然 no-op,不冲突;`cleanupRun` 只清理 `WorkerConfigStore`,IPC 路径本来就没往这个 store 写过东西,同样是无害 no-op。)

在文件里 `// ── sandbox 实例编排...` 那段注释块之后,新增对称的 local 段落:

```ts

  // ── local 实例编排(owner 长期复用,worker-host 直接持有并收发 IPC channel) ──

  /** 为一次 local run 取得(创建或复用)owner 的 keep-alive 实例。 */
  acquireLocalInstanceForRun(
    input: WorkerExecutionStartInput
  ): Promise<AcquireInstanceResult> {
    return this.localInstances.acquireInstanceForRun(input);
  }

  /** local 本轮不做 idle 回收,方法仅为跟 sandbox 对齐调用形状。 */
  releaseLocalInstanceForRun(runId: string): void {
    this.localInstances.releaseInstanceForRun(runId);
  }

  /** 服务重启后清理中断执行残留的 local 进程。 */
  recoverOrphanLocalInstance(runtimeInstanceId: string): Promise<void> {
    return this.localInstances.recoverOrphan(runtimeInstanceId);
  }

  /** 终止并清理指定 owner 的 local keep-alive 进程。 */
  shutdownLocalInstanceByOwnerId(ownerId: string): void {
    this.localInstances.shutdownRuntimeInstanceByOwnerId(ownerId);
  }

```

- [ ] **Step 2: 改 `worker-host.service.spec.ts`**

给已有的构造调用补上第 7 个参数(`localInstances` mock)。在文件末尾新增:

```ts

describe("WorkerHostService local instance orchestration", () => {
  function makeService() {
    const localInstances = {
      getChannel: vi.fn().mockReturnValue(undefined),
      acquireInstanceForRun: vi.fn(),
      releaseInstanceForRun: vi.fn(),
      recoverOrphan: vi.fn(),
      shutdownRuntimeInstanceByOwnerId: vi.fn(),
      sendCommand: vi.fn(),
      openSession: vi.fn(),
    };
    const commandDispatcher = {
      openSession: vi.fn(),
      sendCommand: vi.fn(),
      cleanupRun: vi.fn(),
      cleanupByOwnerId: vi.fn(),
    };
    const service = new WorkerHostService(
      {} as never,
      {} as never,
      commandDispatcher as never,
      {} as never,
      {} as never,
      {} as never,
      localInstances as never
    );
    return { service, localInstances, commandDispatcher };
  }

  it("acquireLocalInstanceForRun forwards to the local executor", async () => {
    const { service, localInstances } = makeService();
    const input = { runConfig: { runId: "run-1" } } as never;
    localInstances.acquireInstanceForRun.mockResolvedValue({ outcome: "ready" });

    await expect(service.acquireLocalInstanceForRun(input)).resolves.toEqual({
      outcome: "ready",
    });
    expect(localInstances.acquireInstanceForRun).toHaveBeenCalledWith(input);
  });

  it("recoverOrphanLocalInstance forwards to the local executor", async () => {
    const { service, localInstances } = makeService();
    await service.recoverOrphanLocalInstance("4242:token");
    expect(localInstances.recoverOrphan).toHaveBeenCalledWith("4242:token");
  });

  it("shutdownLocalInstanceByOwnerId forwards to the local executor", () => {
    const { service, localInstances } = makeService();
    service.shutdownLocalInstanceByOwnerId("ws-1");
    expect(localInstances.shutdownRuntimeInstanceByOwnerId).toHaveBeenCalledWith(
      "ws-1"
    );
  });

  it("sendCommand routes through the local channel when one is registered for the owner", () => {
    const { service, localInstances, commandDispatcher } = makeService();
    localInstances.getChannel.mockReturnValue({});

    service.sendCommand("ws-1", "run-1", { type: "cancel" } as never);

    expect(localInstances.sendCommand).toHaveBeenCalledWith("ws-1", {
      type: "cancel",
    });
    expect(commandDispatcher.sendCommand).not.toHaveBeenCalled();
  });

  it("sendCommand falls back to the HTTP queue when no local channel is registered", () => {
    const { service, localInstances, commandDispatcher } = makeService();
    localInstances.getChannel.mockReturnValue(undefined);

    service.sendCommand("ws-1", "run-1", { type: "cancel" } as never);

    expect(commandDispatcher.sendCommand).toHaveBeenCalledWith("ws-1", "run-1", {
      type: "cancel",
    });
    expect(localInstances.sendCommand).not.toHaveBeenCalled();
  });

  it("openSession routes through the local channel when one is registered for the owner", () => {
    const { service, localInstances, commandDispatcher } = makeService();
    localInstances.getChannel.mockReturnValue({});
    const params = { runId: "run-1", ownerId: "ws-1", runConfig: {} as never };

    service.openSession(params);

    expect(localInstances.openSession).toHaveBeenCalledWith("ws-1", params.runConfig);
    expect(commandDispatcher.openSession).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: 跑测试确认通过**

Run: `pnpm --filter api test -- worker-host.service.spec.ts`
Expected: PASS(补完既有构造调用的第 7 个参数后)

- [ ] **Step 4: 接线 `worker-host.module.ts`**

顶部新增 import:

```ts
import { LocalInstanceExecutor } from "./local/local-instance.executor";
```

`providers` 数组里,在 `SandboxInstanceExecutor,` 之后插入一行:

```ts
    SandboxInstanceExecutor,
    LocalInstanceExecutor,
    RuntimeInstanceLifecycleService,
```

(`LocalInstanceExecutor` 依赖 `RuntimeService`(`RuntimeModule` 已导出)、`WorkerRegistryRepository`/`WorkerUpstreamRegistry`(同模块已注册)——不依赖 `WorkerHostService`,注册顺序不会造成环,`imports: [RuntimeModule]` 不需要变。)

- [ ] **Step 5: 跑 typecheck + 全量测试**

Run: `pnpm --filter api typecheck && pnpm --filter api test`
Expected: 全部通过

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/worker-host/worker-host.service.ts apps/api/src/worker-host/worker-host.service.spec.ts apps/api/src/worker-host/worker-host.module.ts
git commit -m "feat(api): wire LocalInstanceExecutor, route sendCommand/openSession by transport"
```

---

### Task 6: 重写 `run/execution/local.executor.ts`(改走 `worker-host`,不再直接持有 channel)

**Files:**
- Modify: `apps/api/src/run/execution/local.executor.ts`
- Modify: `apps/api/src/run/execution/local.executor.spec.ts`
- Modify: `apps/api/src/run/recovery/run-recovery.service.ts`(如果 `isRuntimeInstanceUserScoped` 对 local 的调用路径需要调整——先读现状确认要不要改,见 Step 5)

**Interfaces:**
- Consumes:`WorkerHostService.acquireLocalInstanceForRun`/`releaseLocalInstanceForRun`/`recoverOrphanLocalInstance`/`openSession`/`sendCommand`/`cleanupRun`(Task 5 产出)。
- 不再 Consumes:`RuntimeService.launchLocal`/`recoverOrphanLocal`(直接调用,改经 `WorkerHostService` 间接触达)、`node:child_process` 的任何直接引用。

- [ ] **Step 1: 重写 `local.executor.ts`,结构对齐 `sandbox.executor.ts`**

```ts
import { Injectable, Logger } from "@nestjs/common";
import { generateId } from "@agework/shared";
import type {
  AcquireInstanceResult,
  WorkerExecutionHandle,
  WorkerExecutionStartInput,
  CommandPayload,
} from "@agework/shared/protocol";
import type { RunEventPort, RunExecutor } from "./executor";
import { WorkerHostService } from "../../worker-host/worker-host.service";
import { errorLogFields, safeLogJson } from "../../common/logging";
import { swallow } from "../../common/swallow";

type LocalRunState = {
  handle: WorkerExecutionHandle;
  ownerId: string;
  status: "acquiring" | "ready";
  cancelled: boolean;
};

/**
 * local run executor:owner 长期复用一个 keep-alive 进程(worker-host 的
 * LocalInstanceExecutor 负责),per-run 执行编排归 run 层——跟 SandboxRunExecutor
 * 同构,不再自己 fork/持有 IPC channel(那是 Phase 2 之前的旧模型,已废弃)。
 */
@Injectable()
export class LocalRunExecutor implements RunExecutor {
  readonly type = "local" as const;
  private readonly logger = new Logger(LocalRunExecutor.name);
  private readonly states = new Map<string, LocalRunState>();
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

    try {
      this.workerHost
        .acquireLocalInstanceForRun(input)
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

    if (state.cancelled) {
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
        `local send command dropped ${safeLogJson({
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
    state.cancelled = true;
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
      `acquire local instance failed ${safeLogJson({ runId, ...errorLogFields(err) })}`
    );
    this.states.delete(runId);
    this.notifyWorkerError(runId, `acquire local instance failed: ${String(err)}`);
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
    this.logger.warn(`terminating local run session ${safeLogJson({ runId, reason })}`);
    this.cleanup(runId);
  }

  cleanup(runId: string): void {
    this.workerHost.cleanupRun(runId);
    this.states.delete(runId);
  }

  cleanupInterruptedExecution(runtimeInstanceId: string): Promise<void> {
    return this.workerHost.recoverOrphanLocalInstance(runtimeInstanceId);
  }
}
```

(`releaseLocalInstanceForRun` 故意不在这里调用——跟 `SandboxRunExecutor.cleanup()` 不同,local 本轮不做引用计数/idle 回收,`cleanup()` 只需要清 `run` 层自己的 `states` 和 `worker-host` 的 `cleanupRun`(config store),owner 级的 keep-alive 进程始终保留到显式 `shutdownLocalInstanceByOwnerId` 或进程自己退出为止——这是跟 sandbox 故意不同的地方,不是遗漏。)

- [ ] **Step 2: 重写 `local.executor.spec.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  LocalRuntimePlacement,
  RunConfig,
  RuntimeTarget,
} from "@agework/shared/protocol";
import { LocalRunExecutor } from "./local.executor";
import type { WorkerHostService } from "../../worker-host/worker-host.service";

function makeWorkerHost(overrides: Record<string, unknown> = {}) {
  return {
    acquireLocalInstanceForRun: vi
      .fn()
      .mockResolvedValue({ outcome: "ready", runtimeInstanceId: "4242:token" }),
    openSession: vi.fn(),
    sendCommand: vi.fn(),
    cleanupRun: vi.fn(),
    recoverOrphanLocalInstance: vi.fn().mockResolvedValue(undefined),
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
  return { ...makePlacement(), ownerId: "ws-1", ...overrides } as RuntimeTarget;
}

describe("LocalRunExecutor", () => {
  let executor: LocalRunExecutor;
  let workerHost: ReturnType<typeof makeWorkerHost>;
  let receiver: {
    recordCommandSent: ReturnType<typeof vi.fn>;
    notifyWorkerError: ReturnType<typeof vi.fn>;
    notifyCancelledBeforeReady: ReturnType<typeof vi.fn>;
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  beforeEach(() => {
    workerHost = makeWorkerHost();
    executor = new LocalRunExecutor(workerHost as unknown as WorkerHostService);
    receiver = {
      recordCommandSent: vi.fn().mockResolvedValue(undefined),
      notifyWorkerError: vi.fn().mockResolvedValue(undefined),
      notifyCancelledBeforeReady: vi.fn().mockResolvedValue(undefined),
    };
    executor.setRunEventPort(receiver as never);
  });

  it("declares the local runtime type", () => {
    expect(executor.type).toBe("local");
  });

  it("returns a handle synchronously and acquires the instance via worker-host", () => {
    const handle = executor.start({
      runtimeTarget: makeRuntimeTarget(),
      runConfig: makeRunConfig(),
    });
    expect(handle.runId).toBe("run-1");
    expect(handle.runtimeInstanceId).toBe("");
    expect(workerHost.acquireLocalInstanceForRun).toHaveBeenCalled();
  });

  it("on ready: opens the worker session and dispatches the first user_message", async () => {
    const handle = executor.start({
      runtimeTarget: makeRuntimeTarget(),
      runConfig: makeRunConfig(),
    });
    await flush();

    expect(handle.runtimeInstanceId).toBe("4242:token");
    expect(workerHost.openSession).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", ownerId: "ws-1" })
    );
    expect(workerHost.sendCommand).toHaveBeenCalledWith(
      "ws-1",
      "run-1",
      expect.objectContaining({ type: "user_message", runId: "run-1" })
    );
    expect(receiver.recordCommandSent).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", commandType: "user_message" })
    );
  });

  it("on error: notifies run, never opens a session", async () => {
    workerHost.acquireLocalInstanceForRun.mockResolvedValueOnce({
      outcome: "error",
      error: "boom",
    });
    executor.start({ runtimeTarget: makeRuntimeTarget(), runConfig: makeRunConfig() });
    await flush();

    expect(workerHost.openSession).not.toHaveBeenCalled();
    expect(receiver.notifyWorkerError).toHaveBeenCalledWith("run-1", "boom");
  });

  it("cancel before ready: marks cancelled, skips the session even if ready arrives later", async () => {
    let resolveAcquire!: (result: unknown) => void;
    workerHost.acquireLocalInstanceForRun.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveAcquire = resolve;
      })
    );
    const handle = executor.start({
      runtimeTarget: makeRuntimeTarget(),
      runConfig: makeRunConfig(),
    });

    executor.cancel(handle);
    resolveAcquire({ outcome: "ready", runtimeInstanceId: "4242:token" });
    await flush();

    expect(workerHost.openSession).not.toHaveBeenCalled();
    expect(receiver.notifyCancelledBeforeReady).toHaveBeenCalledWith("run-1");
  });

  it("cancel after ready: dispatches a cancel command", async () => {
    const handle = executor.start({
      runtimeTarget: makeRuntimeTarget(),
      runConfig: makeRunConfig(),
    });
    await flush();
    workerHost.sendCommand.mockClear();

    executor.cancel(handle);

    expect(workerHost.sendCommand).toHaveBeenCalledWith(
      "ws-1",
      "run-1",
      expect.objectContaining({ type: "cancel", runId: "run-1" })
    );
  });

  it("cleanup releases the worker session via worker-host", async () => {
    executor.start({ runtimeTarget: makeRuntimeTarget(), runConfig: makeRunConfig() });
    await flush();

    executor.cleanup("run-1");

    expect(workerHost.cleanupRun).toHaveBeenCalledWith("run-1");
  });

  it("cleanupInterruptedExecution delegates to worker-host", async () => {
    await executor.cleanupInterruptedExecution("4242:token-9");
    expect(workerHost.recoverOrphanLocalInstance).toHaveBeenCalledWith(
      "4242:token-9"
    );
  });
});
```

- [ ] **Step 3: 跑测试确认通过**

Run: `pnpm --filter api test -- local.executor.spec.ts`
Expected: PASS

- [ ] **Step 4: 确认 `run.module.ts`/`executor.registry.ts` 不需要改动**

`LocalRunExecutor` 现在只依赖 `WorkerHostService`(`run.module.ts` 已经 `imports: [..., WorkerHostModule]`),不再需要 `RuntimeService`——但 `run` 模块的其他类(`RunLauncher`)仍然需要 `RuntimeModule`,所以 `imports` 数组不用动。`OnApplicationShutdown` 接口不再实现(local 不再由 `run` 层直接管理进程终止),确认 `LocalRunExecutor implements RunExecutor` 就够(不再 `implements ... OnApplicationShutdown`)——检查 `executor.ts` 里 `RunExecutor` 接口是否要求 `OnApplicationShutdown`,不要求的话这里天然满足,不用改接口定义。

Run: `pnpm --filter api test -- run.module.spec.ts`
Expected: PASS

- [ ] **Step 5: 确认 `run-recovery.service.ts` 的 local 分支行为**

`RunRecoveryService.shouldCleanupInterruptedRuntimeResource` 调 `workerHost.isRuntimeInstanceUserScoped(runtimeType, runtimeInstanceId)`——这个方法内部查 `findRuntimeByRuntimeId` 返回的 `isolationScope`。local 现在会真正写 WorkerRegistry(`isolationScope: "workspace"` 恒定),所以这个方法对 local 现在能查到真实数据,行为从"local 永远查不到、按 catch 兜底保守跳过清理"变成"local 查到 isolationScope=workspace、`!userScoped` 为 true、正常触发清理"——**这是期望中的行为改善,不是需要额外改代码的地方**,`RunRecoveryService` 本身不需要改动,只需要确认现有测试(`run-recovery.service.spec.ts` 里 `runtimeType: "local"` 那个用例,如果断言的是"跳过清理"的旧行为)是否需要更新断言。

Run: `pnpm --filter api test -- run-recovery.service.spec.ts`
Expected: 如果这一步 FAIL,读一下失败用例断言的是什么行为,把断言更新为反映新行为(local 现在有真实 WorkerRegistry 数据,`isRuntimeInstanceUserScoped` 对 local 返回 `false`,清理会执行)——不要为了让测试通过而 mock 出假数据掩盖真实行为变化。

- [ ] **Step 6: 跑 typecheck + 全量测试 + lint**

Run: `pnpm --filter api typecheck && pnpm --filter api test && pnpm --filter api lint`
Expected: 全部通过

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/run/execution/local.executor.ts apps/api/src/run/execution/local.executor.spec.ts apps/api/src/run/recovery/run-recovery.service.spec.ts
git commit -m "refactor(api): LocalRunExecutor delegates to worker-host like SandboxRunExecutor"
```

---

### Task 7: 收尾验证——跨包全量测试、admin 展示核实、清理遗留引用

**Files:**
- 无固定 Modify 列表,本 task 是验证 + 按发现的问题修 task。

**Interfaces:** 无新增。

- [ ] **Step 1: 全仓库验证**

```bash
pnpm --filter api typecheck
pnpm --filter api test
pnpm --filter api lint
pnpm --filter worker typecheck 2>/dev/null || pnpm --filter worker exec tsc --noEmit
pnpm --filter worker test
```

Expected: 全部通过。

- [ ] **Step 2: 核实 admin 界面对 local 实例的展示不需要改动**

`WorkerHostService.listResources`/`getRuntimeInstanceForAdmin` 已经是读 `RuntimeInstance` 表的通用查询,不特化 sandbox——local 现在真的写数据进这张表(Task 4),admin 界面应该已经能直接展示,不需要额外改代码。手工验证(不是自动化测试):

```bash
pnpm dev
```

在浏览器打开 admin runtime 资源列表页面,启动一次 `runtimeType=local` 的部署下的 run,确认列表里出现一条 `runtimeType: "local"`、`transport: "ipc"` 的 running 记录;结束/关闭这次 run 所在的整个 workspace(或直接触发 owner 删除级联),确认这条记录状态变为 stopped。**这一步没有自动化测试覆盖,是手工验收,记录验收结果在这个 step 的 commit message 或 PR 描述里。**

- [ ] **Step 3: 核实 `RuntimeInstanceLifecycleService`(Phase 2 产出)现在对 local 真的会触发物理清理**

Phase 2 的 `worker-host/lifecycle/lifecycle.service.ts` 里 `shutdownResource` 有一个 `if (resource.runtimeType === "sandbox")` 判断,只对 sandbox 调用物理关闭,local 分支只写 DB 不做物理动作——**这是本 task 需要修的地方**,因为 local 现在有真实的 `LocalInstanceExecutor.shutdownRuntimeInstanceByOwnerId` 可以调用了。改 `apps/api/src/worker-host/lifecycle/lifecycle.service.ts`:

顶部新增 import:

```ts
import { LocalInstanceExecutor } from "../local/local-instance.executor";
```

构造函数新增参数:

```ts
  constructor(
    private readonly workerHost: WorkerHostService,
    private readonly sandboxInstances: SandboxInstanceExecutor,
    private readonly localInstances: LocalInstanceExecutor
  ) {}
```

`shutdownResource` 方法,从:

```ts
    try {
      if (resource.runtimeType === "sandbox") {
        await Promise.resolve(
          this.sandboxInstances.shutdownRuntimeInstanceByOwnerId(resource.ownerId)
        );
      }
      await this.workerHost.markRuntimeStoppedById(resource, "owner_released");
    } catch (err) {
```

改成:

```ts
    try {
      if (resource.runtimeType === "sandbox") {
        await Promise.resolve(
          this.sandboxInstances.shutdownRuntimeInstanceByOwnerId(resource.ownerId)
        );
      } else if (resource.runtimeType === "local") {
        await Promise.resolve(
          this.localInstances.shutdownRuntimeInstanceByOwnerId(resource.ownerId)
        );
      }
      await this.workerHost.markRuntimeStoppedById(resource, "owner_released");
    } catch (err) {
```

同步改 `apps/api/src/worker-host/lifecycle/lifecycle.service.spec.ts`:原本"legacy local 场景,不调用任何 provider,只标记 DB stopped"的用例(`marks legacy local runtime resources stopped without calling the sandbox executor`)现在行为变了——补一个 `localInstances` mock 到构造调用里,把这个用例的断言从"不调用"改成"调用 `localInstances.shutdownRuntimeInstanceByOwnerId`",新增用例名类似 `shuts down a workspace-owned local resource by calling the local executor`。

改 `worker-host.module.ts`:`RuntimeInstanceLifecycleService` 的 providers 数组位置不需要动(`LocalInstanceExecutor` Task 5 已经注册在同一个模块),NestJS 会自动按构造函数参数解析依赖,不需要手动调整顺序。

- [ ] **Step 4: 跑 lifecycle 测试确认通过**

Run: `pnpm --filter api test -- worker-host/lifecycle`
Expected: PASS

- [ ] **Step 5: 再跑一次全仓库验证**

```bash
pnpm --filter api typecheck && pnpm --filter api test && pnpm --filter api lint
```
Expected: 全部通过

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/worker-host/lifecycle
git commit -m "fix(api): RuntimeInstanceLifecycleService physically shuts down local instances too"
```

---

## Self-Review 备注

- **Spec 覆盖**:设计文档 2.4 节"local 也按 owner 长期复用"→ Task 4/6 覆盖;"worker-host 接管 IPC channel 收发"→ Task 4/5 覆盖;"WorkerRegistry 要覆盖 local,local 也要开始写这张表"→ Task 3/4 覆盖(`transport` 字段第一次被显式写入);1.1 节"channel 交接走 launch() 返回值"→ Phase 2 已完成,这次只是新增调用方(`LocalInstanceExecutor`),不改交接机制本身。**没有覆盖、明确留白**:local 的 idle watchdog(本文档 Architecture 一节已说明为什么不做)、自注册鉴权(沿用 Phase 1/2 的"仍待讨论"第 1 条)。
- **命名一致性**:`LocalInstanceExecutor` 方法名(`acquireInstanceForRun`/`releaseInstanceForRun`/`sendCommand`/`openSession`/`getChannel`/`shutdownRuntimeInstanceByOwnerId`/`recoverOrphan`)在 Task 4 定义、Task 5/6/7 消费,全程一致;`WorkerHostService` 新方法名(`acquireLocalInstanceForRun`/`releaseLocalInstanceForRun`/`recoverOrphanLocalInstance`/`shutdownLocalInstanceByOwnerId`)跟 sandbox 对应方法名(`acquireSandboxInstanceForRun` 等)保持同构命名模式。
- **占位符扫描**:全文无 "TBD"/"后面实现" 类占位;Task 2 的"如果不存在就跳过"是给实现者的条件判断指令,不是模糊占位——两条分支都给出了明确动作。
