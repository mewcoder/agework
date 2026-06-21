# Agent Runtime Phase 3 — Worker 进程化 Implementation Plan

> **Spec 文档**：`docs/superpowers/specs/2026-06-10-agent-runtime-phase3-worker-process-design.md`

**Goal:** 将 agent 执行从 API 进程搬到独立 `apps/worker` 子进程，API 只负责调度 + IPC 转发。外部行为（聊天 / 停止 / HITL / 项目列表）保持不变。

**已确认的设计决策：**
- `requires_action` 无独立超时，本期不做（worker 挂着资源开销极低）
- `trace`：worker 不传 trace，构造 adapter 时 `trace: undefined`
- `pendingActionSink`：桥接为 `run.status` envelope（`requires_action` / `running`），API 端 `RunEventBus` 统一处理持久化
- Plan 粒度：6 task 顺序执行，每个 task 可独立 commit

**提交约定**：按项目记忆，AI 不自动 commit，每个 task 结束时 `git add` 暂存并给出建议 commit message。

---

## Task 1: 扩展 `packages/protocol` 类型

**Files:**
- Modify: `packages/protocol/src/transport.ts`
- Modify: `packages/protocol/src/index.ts`

**Steps:**

- [ ] **Step 1.1: `RunStatus` 补全**

  在 `transport.ts` 中 `RunStatus` 联合类型加入 `"requires_action"` 和 `"cancelled"`：

  ```ts
  export type RunStatus =
    | "queued"
    | "preparing"
    | "running"
    | "requires_action"
    | "cancelling"
    | "finished"
    | "error"
    | "cancelled";
  ```

- [ ] **Step 1.2: `RunStatusPayload` 加 `pendingAction`**

  ```ts
  export type RunStatusPayload = {
    status: RunStatus;
    phase?: string;
    error?: string;
    pendingAction?: "question" | null;
  };
  ```

- [ ] **Step 1.3: `ControlPayload` 加 `commandId`，`approval` 改名 `approval_resolved`**

  ```ts
  export type ControlPayload =
    | { type: "cancel"; commandId: string }
    | { type: "interrupt"; commandId: string }
    | {
        type: "approval_resolved";
        commandId: string;
        threadId: string;
        answers: Record<string, string | string[]>;
      }
    | { type: "user_message"; commandId: string; message: string };
  ```

- [ ] **Step 1.4: `RunConfig` 加 `adapter` 字段**

  ```ts
  export type ClaudeAdapterRuntimeConfig = {
    kind: "claude";
    isEnvironmentConfig: boolean;
    apiKey?: string;
    baseUrl?: string;
    model?: string;
  };

  export type CodexAdapterRuntimeConfig = {
    kind: "codex";
    isEnvironmentConfig: boolean;
    apiKey?: string;
    baseUrl?: string;
    model?: string;
  };

  export type AdapterRuntimeConfig =
    | ClaudeAdapterRuntimeConfig
    | CodexAdapterRuntimeConfig;

  export type RunConfig = {
    runId: string;
    threadId: string;
    agentType: "claude" | "codex";
    runtimePath: string;
    env: Record<string, string>;
    input: unknown;
    adapter: AdapterRuntimeConfig;
  };
  ```

- [ ] **Step 1.5: `index.ts` 补充导出**

  新增导出 `ClaudeAdapterRuntimeConfig`、`CodexAdapterRuntimeConfig`、`AdapterRuntimeConfig`。

- [ ] **Step 1.6: 验证**

  `pnpm typecheck` 通过（`packages/protocol`、`packages/adapters`、`apps/api` 都不能报类型错误）。`apps/api/src/runs/run.service.ts` 中本地定义的 `RunStatus` 类型也需要同步加上 `"requires_action"` | `"cancelled"`（或者改为从 `@agework/protocol` 导入，消除重复定义）。

---

## Task 2: 新建 `apps/worker` 骨架

**Files (new):**
- `apps/worker/package.json`
- `apps/worker/tsconfig.json`
- `apps/worker/src/main.ts`
- `apps/worker/src/ipc-transport.ts`

**Steps:**

- [ ] **Step 2.1: `apps/worker/package.json`**

  ```json
  {
    "name": "worker",
    "version": "0.0.1",
    "private": true,
    "scripts": {
      "typecheck": "tsc --noEmit"
    },
    "dependencies": {
      "@agework/protocol": "workspace:*",
      "@agework/adapters": "workspace:*",
      "tsx": "^4.19.0"
    },
    "devDependencies": {
      "@types/node": "^24.0.0",
      "typescript": "^5.7.3"
    }
  }
  ```

  注意 `tsx` 在 `dependencies`（非 dev），保证 `pnpm install --prod` 也有。无 `build` script——worker 用 tsx 直跑 TS 源码。

- [ ] **Step 2.2: `apps/worker/tsconfig.json`**

  ```json
  {
    "compilerOptions": {
      "module": "nodenext",
      "moduleResolution": "nodenext",
      "esModuleInterop": true,
      "isolatedModules": true,
      "target": "ES2023",
      "types": ["node"],
      "sourceMap": true,
      "outDir": "./dist",
      "rootDir": "./src",
      "skipLibCheck": true,
      "strict": true,
      "noEmit": true
    },
    "references": [
      { "path": "../../packages/protocol" },
      { "path": "../../packages/adapters" }
    ],
    "include": ["src/**/*.ts"]
  }
  ```

- [ ] **Step 2.3: `apps/worker/src/ipc-transport.ts`**

  实现 `RuntimeTransport` 接口：

  - `fetchRunConfig()`: `process.on("message")` 等待第一条 `type === "run.config"` 消息，resolve 其 `payload` 为 `RunConfig`。设置超时（10 秒），超时则 `process.exit(1)`。
  - `emit(msg)`: 内部维护 `seq` 自增计数器（从 1 开始），填充 `msg.seq` 和 `msg.ts`，`process.send!(msg)`。
  - `subscribeControls(cb)`: 监听 `process.on("message")`，过滤 `type === "control"` 的消息，调用 `cb(msg)`。返回 unsubscribe 函数。
  - `close()`: `process.disconnect()`。

- [ ] **Step 2.4: `apps/worker/src/main.ts`**

  入口逻辑：

  1. 检查 `process.send` 存在（确认以 fork 方式启动）。
  2. `const transport = new IpcTransport()`
  3. `const config = await transport.fetchRunConfig()`
  4. 根据 `config.adapter.kind` 构造对应 adapter（从 `@agework/adapters` 导入 `ClaudeAgentAdapter` / `CodexAgentAdapter`）：
     - Claude: `new ClaudeAgentAdapter({ apiKey, model, baseUrl, cwd: config.runtimePath, isEnvironmentConfig, pendingActionSink })`
     - Codex: `new CodexAgentAdapter({ apiKey, model, baseUrl, cwd: config.runtimePath })`
     - `trace: undefined`（本期不传）
     - `pendingActionSink`: 桥接为 `transport.emit({ type: "run.status", payload: { status: "requires_action"|"running", pendingAction } })`
  5. `transport.emit({ type: "run.status", payload: { status: "running" } })`
  6. 启动 5 秒心跳定时器：`setInterval(() => transport.emit({ type: "heartbeat", payload: { at: new Date().toISOString() } }), 5000)`
  7. `commandId` 幂等集合：`const processedCommands = new Set<string>()`
  8. `transport.subscribeControls((envelope) => {...})` 处理：
     - `cancel`: `adapter.interrupt()`；如有 pending question 则 `cancelQuestion(config.threadId)`
     - `approval_resolved`: `resolveQuestion(envelope.payload.threadId, envelope.payload.answers)`
     - 所有 control 先检查 `processedCommands` 去重
  9. `adapter.run(config.input).subscribe({ next, error, complete })`：
     - `next(event)`: `transport.emit({ type: "agui.event", payload: event })`
     - `complete()`: `transport.emit({ type: "run.status", payload: { status: "finished" } })` → `transport.close()` → `process.exit(0)`
     - `error(err)`: 区分 stopRequested（`cancelled`）和真错误（`error`）→ emit 对应 `run.status` → `transport.close()` → `process.exit(0)`
  10. `process.on("disconnect", () => { adapter.interrupt(); process.exit(1); })`

- [ ] **Step 2.5: `pnpm install` + `pnpm typecheck`**

  在根目录执行 `pnpm install`（让 pnpm-workspace 识别新 app），然后 `pnpm typecheck` 通过。

---

## Task 3: API 端新增 `LocalProcessProvider` + `RunEventBus`

**Files (new):**
- `apps/api/src/runs/local-process-provider.service.ts`
- `apps/api/src/runs/run-event-bus.service.ts`

**Files (modify):**
- `apps/api/src/runs/runs.module.ts`

**Steps:**

- [ ] **Step 3.1: `LocalProcessProvider`**

  ```ts
  @Injectable()
  export class LocalProcessProvider {
    start(runConfig: RunConfig): RuntimeHandle { ... }
    sendControl(handle: RuntimeHandle, control: ControlPayload): void { ... }
    cancel(handle: RuntimeHandle): void { ... }
  }
  ```

  `start()`:
  - 生成 `startToken = randomUUID()`
  - 定位 tsx CLI: `require.resolve("tsx/esm", { paths: [workerPackageDir] })` — 实际用 `child_process.fork(workerMainPath, [], { execArgv: ["--import", "tsx/esm"], env: { RUNTIME_TRANSPORT: "ipc", AGEWORK_RUN_ID: runConfig.runId, AGEWORK_RUN_START_TOKEN: startToken, ...process.env } })`
  - fork 后立刻 `child.send({ runId, seq: 0, type: "run.config", payload: runConfig, ts: new Date().toISOString() })`
  - 监听 `child.on("message", envelope)` → `runEventBus.publish(envelope)`
  - 监听 `child.on("exit", code)` → 如果 `RunEventBus` 还没收到终态 `run.status`，发一条 `run.status: error("worker exited unexpectedly")`
  - 启动心跳检测定时器（每 5 秒检查一次，超过 60 秒无心跳则 kill + 标记 error）
  - 返回 `RuntimeHandle = { runId, providerType: "local", runtimeId: \`${child.pid}:${startToken}\`, child }`

  `sendControl()`:
  - `handle.child.send({ runId, seq: controlSeq++, type: "control", payload: control, ts })`

  `cancel()`:
  - `sendControl(handle, { type: "cancel", commandId: randomUUID() })`

- [ ] **Step 3.2: `RunEventBus`**

  ```ts
  @Injectable()
  export class RunEventBus {
    publish(envelope: UpstreamMessage, context: RunEventContext): Promise<void> { ... }
  }
  ```

  `RunEventContext = { threadId, res?, aggregator, runId }`（由 controller 在注册时传入）

  `publish()` 按 `envelope.type` 分发：
  - `"run.status"`:
    - 更新 `Run.status`、`Run.phase`、`Run.error`、`Run.lastSeq`
    - 如果 `pendingAction` 存在 → `threadService.setPendingAction(threadId, pendingAction)`
    - 如果终态 → `RunRegistry.unregister`、`threadService.setRunStatus`、`runService.markFinished/markError`
  - `"heartbeat"`: 更新 `Run.lastHeartbeatAt`
  - `"agui.event"`:
    - `aggregator.handle(event)`
    - chunk 节流 `saveRun()`
    - SSE 写入（`if (!res.writableEnded) res.write(...)`）
    - 处理 `CUSTOM agent.resumeId` / `system:init.session_id`

  seq 去重：内存 `Map<runId, lastSeq>`，新 seq <= lastSeq 丢弃。

- [ ] **Step 3.3: 注册到 `RunsModule`**

  在 `runs.module.ts` 的 `providers` 和 `exports` 中注册 `LocalProcessProvider`、`RunEventBus`。`RunsModule` 需要 import `ThreadModule`（`RunEventBus` 依赖 `ThreadService`）。

- [ ] **Step 3.4: 验证**

  `pnpm typecheck` 通过。

---

## Task 4: `AgentController` 改造

**Files (modify):**
- `apps/api/src/agent/agent.controller.ts`
- `apps/api/src/agent/agent.service.ts`
- `apps/api/src/runs/run-registry.service.ts`
- `apps/api/src/agent/agent.module.ts`

**Steps:**

- [ ] **Step 4.1: `RunRegistry` 改造**

  `RunHandle` 不再持有 `interrupt`，改为：

  ```ts
  export type RunHandle = {
    runtimeHandle: RuntimeHandle;
    res: Response | null;  // SSE 连接，断开后置 null
    aggregator: RunAggregator;
    threadId: string;
    runId: string;
    stopRequested: boolean;
  };
  ```

- [ ] **Step 4.2: `AgentService.buildRunConfig()`**

  新增方法，从现有 `getAdapter()` 逻辑中提取出"解析 ModelConfig → 构建 config"的部分：

  ```ts
  async buildRunConfig(params: {
    agentType: string;
    modelConfigId: string;
    projectWorkdir: string;
    runId: string;
    threadId: string;
    input: unknown;
  }): Promise<RunConfig> { ... }
  ```

  `getAdapter()` 保留但标记 `@deprecated`（本期不删除，避免破坏已有测试引用）。

- [ ] **Step 4.3: `AgentController.run()` 改造**

  核心变化：
  - 不再调 `agentService.getAdapter()`，改为 `agentService.buildRunConfig()`
  - 不再 `adapter.run().subscribe()`，改为 `localProcessProvider.start(runConfig)`
  - `RunRegistry.register(runId, { runtimeHandle, res, aggregator, threadId, runId, stopRequested: false })`
  - 事件处理逻辑（`aggregator.handle`、`saveRun`、SSE 写入、`CUSTOM` 事件处理）全部移到 `RunEventBus.publish()` 中
  - `run()` 方法本身只负责：参数解析 → buildRunConfig → start → register → 等待/异常兜底
  - `res.on("close")` 不再 `cancelQuestion`（behavior change per spec），只把 `handle.res = null`

- [ ] **Step 4.4: `stop()` 改造**

  ```ts
  const handle = this.runRegistry.get(activeRunRecord.id);
  handle.stopRequested = true;
  await this.runService.markCancelling(activeRunRecord.id);
  this.localProcessProvider.cancel(handle.runtimeHandle);
  ```

- [ ] **Step 4.5: `answerQuestion()` 改造**

  ```ts
  const activeRun = await this.runService.findActiveByThreadId(threadId);
  const handle = activeRun ? this.runRegistry.get(activeRun.id) : undefined;
  if (!handle) throw new NotFoundException(...);
  this.localProcessProvider.sendControl(handle.runtimeHandle, {
    type: "approval_resolved",
    commandId: randomUUID(),
    threadId,
    answers: body.answers,
  });
  ```

- [ ] **Step 4.6: `AgentModule` 更新**

  import `RunsModule`（已有）无需改；确保 `LocalProcessProvider` 可被 `AgentController` 注入（通过 `RunsModule` exports）。

- [ ] **Step 4.7: 验证**

  `pnpm typecheck` + `pnpm build` 通过。手动 `pnpm dev` 冒烟测试：发消息→收到流式回复→Run 记录正确。

---

## Task 5: 孤儿 Run 恢复

**Files (modify):**
- `apps/api/src/runs/runs.module.ts`（或新建 `orphan-cleanup.service.ts`）
- `apps/api/src/runs/run.service.ts`

**Steps:**

- [ ] **Step 5.1: `RunService` 加查询方法**

  ```ts
  async findAllActive(): Promise<Run[]> {
    return this.prisma.run.findMany({
      where: { status: { in: ["queued", "preparing", "running", "cancelling", "requires_action"] } },
    });
  }
  ```

- [ ] **Step 5.2: `RunsModule.onModuleInit` 执行孤儿扫描**

  在 `RunsModule` 实现 `OnModuleInit`：
  1. 查询所有活跃 Run
  2. 对每条 `runtimeId` 解析 `pid`，尝试 `process.kill(pid, "SIGTERM")`（try/catch 忽略 `ESRCH`）
  3. `runService.markError(run.id, "服务重启导致运行中断")`
  4. `threadService.setPendingAction(run.threadId, null)` + `threadService.setRunStatus(run.threadId, "error")`

- [ ] **Step 5.3: 验证**

  `pnpm typecheck` 通过。单元测试见 Task 6。

---

## Task 6: 测试

**Files (new):**
- `apps/api/src/runs/local-process-provider.service.spec.ts`
- `apps/api/src/runs/run-event-bus.service.spec.ts`

**Files (modify):**
- `apps/api/src/runs/run-registry.service.spec.ts`（适配新 `RunHandle`）
- `apps/api/src/runs/run.service.spec.ts`（补 `findAllActive` 测试）

**Steps:**

- [ ] **Step 6.1: `LocalProcessProvider` 单测**

  - fork worker、发送 `run.config`、收到 `agui.event`/`run.status`/`heartbeat` 转发给 mock `RunEventBus`
  - `sendControl` 幂等验证（重复 `commandId` worker 不重复处理）
  - worker exit 时如果未收到终态 → 自动发 error

- [ ] **Step 6.2: `RunEventBus` 单测**

  - seq 去重（重复 seq 丢弃）
  - `agui.event` 正确调用 `aggregator.handle` + SSE 写入
  - 终态 `run.status` 触发 `RunRegistry.unregister`

- [ ] **Step 6.3: 心跳超时测试**

  模拟 > 60 秒无心跳 → 断言 `Run.status === "error"` + child 被 kill

- [ ] **Step 6.4: 孤儿 Run 扫描测试**

  预置 `status="running"` 的 Run → 执行 `onModuleInit` → 断言标记为 `"error"`

- [ ] **Step 6.5: 已有测试适配**

  `run-registry.service.spec.ts` 适配新 `RunHandle` 结构。确保 `pnpm test:api` 全部通过。

- [ ] **Step 6.6: 最终验证**

  `pnpm typecheck && pnpm build && pnpm test:api` 全部通过。

---

## 注意事项

1. **Prisma schema**：`Run.status` 列现有 `@default("queued")` + `@@index([status])`，不需要改 schema（`requires_action`/`cancelled` 只是字符串值）。但 `run.service.ts` 的 `ACTIVE_RUN_STATUSES` 数组需要加入 `"requires_action"`。

2. **`apps/api` 对 `apps/worker` 没有 workspace 依赖**：`apps/api/package.json` 不加 `"worker": "workspace:*"`。API 通过文件路径定位 worker 源码（`path.resolve(__dirname, "../../../../apps/worker/src/main.ts")`，或用一个配置常量）。

3. **`res.on("close")` 行为变化**：Phase 3 后，浏览器断开不再 cancelQuestion。用户关闭标签页后重新打开仍能看到 pending question 并作答。如果用户永远不回来，worker 挂在 await（资源消耗极低），后续 Phase 4 加管理界面/超时清理。

4. **统一要求 project**：Phase 3 后所有 run 都走 worker 进程，没有关联 project（无 workspace/workdir）的 thread 拒绝 run（返回 400）。不保留进程内 adapter fallback 分支。`getAdapter()` 标记 `@deprecated`，不再被 controller 调用。
