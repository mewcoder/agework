# Agent Runtime Phase 3 — Worker 进程化设计

## 背景与范围

Phase 1（packages 抽取）、Phase 2（Run/Workspace 数据模型 + 控制面注册表，进程内编排）已完成，详见：

- `docs/superpowers/plans/2026-06-10-agent-runtime-phase1-packages-extraction.md`
- `docs/superpowers/plans/2026-06-10-agent-runtime-phase2-run-workspace-model.md`
- 总体设计参考：`docs/superpowers/specs/2026-06-10-agent-runtime-infrastructure-design-v2.md`

Phase 1 已经在 `packages/protocol` 里落了一份 `Envelope` / `RuntimeTransport` / `ControlPayload` / `UpstreamMessage` / `RunConfig` / `RunStatus` 类型（`packages/protocol/src/transport.ts`、`envelope.ts`）。**Phase 3 直接复用并扩展这份协议，不新建第二个协议包**——worker 与 API 共用 `@agework/protocol`，避免出现两套互相不兼容的"运行配置/消息"定义。

Phase 3 的目标：把"运行 Agent"这件事从 API 进程里搬到一个独立的 `apps/worker` 子进程，API 进程只负责"调度子进程 + 通过统一的 envelope 协议转发事件/指令"。这是迈向"将来可能在沙箱/容器里运行 Agent"的第一步——本期只做本地子进程版本（`LocalProcessProvider` + `IpcTransport`），但严格遵守 `RuntimeTransport`/`RuntimeProvider` 抽象，使得 Phase 4 引入 `DockerProvider` + `HttpTransport` 时，worker 主体代码和 API 侧的 `RunEventBus`/`RunAggregator` 逻辑不需要改动。

**本期范围**：

- ✅ `apps/worker` 新增为独立 turborepo app，实现 `IpcTransport`（`RuntimeTransport` 的本地实现）
- ✅ 扩展 `packages/protocol`：补全 `RunStatus`/`ControlPayload`/`RunConfig` 等类型，使其满足 Phase 3 实际需要（`commandId` 幂等、`requires_action`/`cancelled` 状态）
- ✅ API 侧新增 `LocalProcessProvider`（`RuntimeProvider` 本地实现）+ `RunEventBus`（统一事件汇入口）
- ✅ 跨进程的"用户问答"（agent 提问、用户作答、agent 继续）与停止，均通过 `ControlPayload` + `commandId` 幂等
- ✅ worker 心跳 + API 端超时检测（标记为 `error`，不混同于用户主动停止）
- ✅ API 重启后的孤儿 Run 恢复（orphan cleanup）
- ✅ 明确浏览器断开连接（SSE close）对 Run 没有任何影响——包括正在等待用户回答问题的情况；用户重新打开页面后仍能看到问题并作答

**不在本期范围**（沿用既有共识，后置到 Phase 4 及以后）：

- 🚫 Docker/沙箱形态（`DockerProvider` + `HttpTransport`）、`SecretRef`/runtime token
- 🚫 多 Agent 并行 / Agent 编排
- 🚫 原始事件落库（Event Store / inbox 表）、workspace sync 策略

## 协议基础：扩展 `packages/protocol`

`packages/protocol/src/transport.ts` 现状（Phase 1 产物）与 Phase 3 实际需要之间有几处缺口，本期在**同一个文件**里直接扩展，不新建包：

### `RunStatus` / `RunStatusPayload`

现状缺少 `requires_action`（等待用户回答问题）和 `cancelled`（用户主动停止）两个状态，`RunStatusPayload` 也缺少"当前在等待哪种操作"的字段。改为：

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

export type RunStatusPayload = {
  status: RunStatus;
  phase?: string;
  error?: string;
  /** status === "requires_action" 时，说明在等待什么操作；resolve 后置回 null。 */
  pendingAction?: "question" | null;
};
```

### `ControlPayload`

现状的 `approval`/`user_message`/`cancel`/`interrupt` 缺少幂等 key（`commandId`）。改为：

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

`approval_resolved` 不携带 `questionId`：一个 Run 同一时刻最多只有一个等待回答的问题（adapter 阻塞在 `canUseTool` 上），不存在"同时有多个待回答问题"的情况；如果 Run 已结束，worker 已退出，`sendControl` 也不会有效果。引入 `questionId` 校验对当前场景没有实质收益，故不做。

`user_message` 类型在 Phase 3 暂不使用（沿用现状：每次对话是新的 `/agent/run` 请求，不在运行中追加消息），保留类型定义是为了与 `packages/protocol` 既有导出兼容，不在本期任务中实现其处理逻辑。

worker 必须维护一个"已处理 `commandId` 集合"（每个 worker 进程生命周期内的内存 `Set<string>`），收到重复 `commandId` 的 control 直接忽略。

### `RunConfig`

现状 `RunConfig` 只有 `{runId, threadId, agentType, runtimePath, env, input}`，缺少"用 哪个 adapter、哪些密钥"的信息——这部分目前是 `AgentService.getAdapter()` 在 API 进程内组装的。Phase 3 把这部分挪到 `RunConfig.adapter`：

```ts
export type RunConfig = {
  runId: string;
  threadId: string;
  agentType: "claude" | "codex";
  runtimePath: string;
  env: Record<string, string>;
  input: unknown;
  adapter: ClaudeAdapterRuntimeConfig | CodexAdapterRuntimeConfig;
};

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
```

`apiKey` 在本期是明文字符串（见下文"密钥边界"）；v2 设计中的 `SecretRef`/`InlineSecret` 区分是 Phase 4（Docker/HTTP，跨主机传输密钥）才需要的，本期不引入，避免过度设计。

### `Envelope` / `UpstreamMessage` / `RuntimeTransport`

`packages/protocol/src/envelope.ts` 的 `Envelope<T>` 和 `transport.ts` 的 `UpstreamMessage`、`RuntimeTransport` 接口本期**不改**，直接复用：

```ts
export interface Envelope<T = unknown> {
  runId: string;
  seq: number;
  type: string;
  payload: T;
  ts: string;
}

export type UpstreamMessage =
  | Envelope<RunStatusPayload>   // type: "run.status"
  | Envelope<AGUIEvent>          // type: "agui.event"
  | Envelope<HeartbeatPayload>;  // type: "heartbeat"
  // ArtifactRefPayload 本期不发送，类型保留但不在 UpstreamMessage 联合中使用

export interface RuntimeTransport {
  fetchRunConfig(): Promise<RunConfig>;
  emit(msg: UpstreamMessage): Promise<void>;
  subscribeControls(cb: (control: Envelope<ControlPayload>) => void): Unsubscribe;
  close(): Promise<void>;
}
```

worker 主体（`apps/worker`）只依赖 `RuntimeTransport` 接口，不知道自己跑在本地子进程还是（将来的）容器里。本期唯一实现是 `IpcTransport`（见 Section B）。

## Section A — 进程模型与启动方式

`apps/worker` 是一个新的、独立的 turborepo app：

- 纯 Node 脚本，不依赖 NestJS / Prisma / `apps/api` 的任何模块；只依赖 `@agework/protocol` 和 `@agework/adapters`。
- 入口文件：`apps/worker/src/main.ts`。
- 启动方式：API 用 `child_process.fork()` 直接运行 `tsx` CLI 去执行 `apps/worker/src/main.ts`（TS 源码直跑），dev 和 prod 用同一种方式，不需要单独的 `tsc -b` 构建步骤。

  为避免"生产环境是否还有 `tsx`"的不确定性，`apps/worker/package.json` 把 `tsx` 声明为**自己的 `dependencies`**（不仅依赖根目录的 devDependency）。`apps/api` 在 `prepareRun`/`start` 时，通过 `require.resolve("tsx/cli", { paths: [workerPackageDir] })` 之类的方式定位到 `apps/worker` 自身 `node_modules` 里的 `tsx` 可执行文件，fork 它来运行 `main.ts`。这样无论 `pnpm install` 是否带 `--prod`，`apps/worker` 目录下都保证有 `tsx`。

**一个 Run 对应一个 worker 进程**（不是常驻进程池）：

- API 每次开始一个新 Run 时，`fork()` 一个新的 worker 子进程。
- 注入环境变量：`RUNTIME_TRANSPORT=ipc`、`AGEWORK_RUN_ID=<runId>`、`AGEWORK_RUN_START_TOKEN=<随机 token>`（用于 Section C 的孤儿检测）。
- 这个 Run 走到终态（`finished` / `error` / `cancelled`）后，worker 进程退出（`process.exit(0)`）。
- worker 监听 IPC `disconnect` 事件：一旦父进程（API）异常退出导致 IPC 通道断开，worker 立即 `adapter.interrupt()` 并 `process.exit(1)`，不允许在父进程消失后继续运行（避免孤儿进程）。

## Section B — IpcTransport、RunConfig 装配、用户问答与停止

### `IpcTransport`：`RuntimeTransport` 的本地实现

`apps/worker/src/ipc-transport.ts` 实现 `RuntimeTransport`：

- `fetchRunConfig()`：worker 启动后，API 会在 fork 完成的第一时间通过 `child.send(envelope)` 推送一个 `type: "run.config"` 的 envelope（`payload` 是 `RunConfig`）。`fetchRunConfig()` 内部 `process.on("message")` 等待第一条 `type === "run.config"` 的消息并 resolve。
- `emit(msg)`：`process.send(msg)`（`msg` 已经是 `UpstreamMessage`，即一个 `Envelope`）。worker 内部维护一个从 1 开始自增的 `eventSeq`，每次 `emit` 前 `seq = eventSeq++`。
- `subscribeControls(cb)`：`process.on("message", (msg) => { if (msg.type === "control") cb(msg as Envelope<ControlPayload>); })`——`run.config` 类型的消息只会在 `fetchRunConfig` 阶段出现一次，之后所有从 API 来的消息都是 `type: "control"`。
- `close()`：`process.disconnect()`。

API 侧（`LocalProcessProvider`，见 Section D）是 `IpcTransport` 的"对端"：fork 后立刻 `child.send({runId, seq: 0, type: "run.config", payload: runConfig, ts})`；监听 `child.on("message")` 把 `agui.event`/`run.status`/`heartbeat` 转给 `RunEventBus`；调用 `child.send({runId, seq: controlSeq++, type: "control", payload: controlPayload, ts})` 下发控制指令。

### `RunConfig` 怎么组装

API 把现有 `AgentService.getAdapter()` 里"从 `ModelConfig` 表解析 `apiKey`/`model`/`baseUrl`/`isEnvironmentConfig`"的逻辑抽成一个新方法 `AgentService.buildRunConfig(...)`，返回值就是上面定义的 `RunConfig`（`adapter` 字段为 `ClaudeAdapterRuntimeConfig`/`CodexAdapterRuntimeConfig`）。`runtimePath` 直接取 `Workspace.locator`（即 `projectInfo.workdir`）。

worker 收到 `RunConfig` 后，按 `agentType`/`adapter.kind` 构造对应 adapter（`packages/adapters` 现有构造逻辑不改，只是调用方从 `AgentService` 变成 worker 的 `main.ts`）。

### 密钥边界

worker 是 API fork 出来的本机子进程，`child.send()` 走进程间内存通道，不落盘、不走网络。因此 `RunConfig.adapter.apiKey` 以明文字符串形式直接发送，安全级别与现状（`apiKey` 在 API 进程内存里流转）一致。

`isEnvironmentConfig: true` 场景下，`pickSafeEnv()` 逻辑不变，只是现在跑在 worker 进程里——worker 由 `fork()` 创建，会继承 API 进程的 `process.env`，所以这部分行为与现状一致。

### 跨进程的"用户问答"（agent 提问、用户作答、agent 继续）

`packages/adapters/src/claude/business/claude-agent.adapter.ts` 中现有的 `pendingQuestions` Map 及 `resolveQuestion(threadId, answers)` / `cancelQuestion(threadId)` 函数代码不变，只是现在运行在 worker 进程里，并且增加一个 `questionId`：

1. adapter 在 worker 内调用 `canUseTool` 时，沿用现状把等待状态记录在 `pendingQuestions` Map（key 是 `threadId`）。
2. worker 通过 `transport.emit()` 发送一条 `run.status` envelope：`{ type: "run.status", payload: { status: "requires_action", pendingAction: "question" } }`。
3. worker 通过 `transport.emit()` 发送一条 `agui.event` envelope，携带原本就会下发给前端的"提问"事件（沿用现状的 AG-UI 事件，不新增事件类型）。
4. API 的 `RunEventBus`（见 Section C）收到 `run.status: requires_action` 后，更新 `Run.status`。
5. 用户在前端回答后，请求打到 `POST /agent/threads/:threadId/question-answer`。API 找到该 thread 的 active Run，调用 `provider.sendControl(handle, { type: "approval_resolved", commandId: randomUUID(), threadId, answers })`。
6. worker 收到 `approval_resolved` control：调用现有的 `resolveQuestion(threadId, answers)`（返回 `false` 表示当前没有该 thread 的待回答问题）。`resolveQuestion` 返回 `true` 后，`transport.emit()` 一条 `run.status: { status: "running", pendingAction: null }`；返回 `false` 则忽略（Run 已经不在 `requires_action`）。
7. 如果 worker 已经退出（Run 不在 active 状态），`POST /agent/threads/:threadId/question-answer` 在 API 侧找不到对应的活跃 `RuntimeHandle`，直接返回 404（与现状 `resolveQuestion` 返回 `false` 时抛 `NotFoundException` 的行为一致）。

### 停止（stop）

API 端维护一个 `runId -> 子进程句柄` 的映射（沿用 Phase 2 的 `RunRegistry`）。

流程：

1. 用户点击停止，请求打到 `POST /agent/threads/:threadId/stop`。
2. API 找到对应的 `RuntimeHandle`，调用 `provider.sendControl(handle, { type: "cancel", commandId: randomUUID() })`，并把 `Run.status` 置为 `cancelling`。
3. worker 收到 `cancel`：调用 `adapter.interrupt()`；如果该 thread 有 `pendingQuestions` 记录，调用 `cancelQuestion(threadId)`（避免 worker 因为还在等待用户回答而无法退出）。
4. worker 的 `adapter.run()` observable 收到 interrupt 后会走 `error`/`complete`，worker 据此 `transport.emit()` 一条 `run.status: { status: "cancelled" }`，随后退出进程。
5. `commandId` 幂等：worker 对同一个 `commandId` 的 `cancel`/`approval_resolved` 只处理一次。

## Section C — RunEventBus、心跳与崩溃恢复

### 事件怎么从 worker 传回 API、再推给前端

API 侧新增 `RunEventBus`（`apps/api/src/runs/run-event-bus.service.ts`），是所有上行 `UpstreamMessage` 的唯一处理入口：

```ts
interface RunEventBus {
  publish(envelope: UpstreamMessage): Promise<void>;
}
```

`LocalProcessProvider` 监听到 `child.on("message", envelope)` 后，原样转给 `runEventBus.publish(envelope)`。`publish` 内部按 `envelope.type` 分发：

- `"run.status"`：更新 `Run.status`/`Run.phase`/`Run.error`，并写入 `Run.lastSeq = envelope.seq`。如果 `status` 是终态（`finished`/`error`/`cancelled`），调用 `RunRegistry.unregister(runId)`、设置 `Thread.runStatus`。
- `"heartbeat"`：更新 `Run.lastHeartbeatAt = envelope.payload.at`（即 `new Date()`）。
- `"agui.event"`：
  1. 通过 `RunRegistry.get(runId)` 找到该 Run 当前挂载的 SSE 连接信息（`{ res, aggregator, runId, threadId }`，由 `AgentController.run()` 在收到第一个事件前注册）。
  2. 调用 `aggregator.handle(envelope.payload)`，按 Phase 2 现有规则做 chunk 节流 `saveRun()`。
  3. 如果 SSE 连接仍然 `!res.writableEnded`，`res.write(\`data: ${JSON.stringify(envelope.payload)}\n\n\`)`。
  4. `agui.event` 中 `CUSTOM agent.resumeId` / `system:init.session_id` 的处理逻辑原样从 `AgentController` 搬到这里。

`envelope.seq` 的去重/顺序检查：`RunEventBus` 记录每个 `runId` 上次处理的 `seq`（内存 Map），如果新到的 `seq <= lastSeq`，丢弃（视为重复，理论上 IPC 不会发生，仅做防御性检查并打日志）；如果 `seq > lastSeq + 1`，记录一条 warning 日志但仍然处理（本地 IPC 是有序的，出现跳号大概率是 bug 而非网络丢包，不需要像 HTTP transport 那样阻塞等待补齐）。

### worker 心跳与超时

worker 每 5 秒通过 `transport.emit({ type: "heartbeat", payload: { at: new Date().toISOString() } })` 发一次心跳。`LocalProcessProvider` 为每个活跃 Run 启动一个定时器（每 5 秒检查一次），如果 `Date.now() - Run.lastHeartbeatAt > 60_000`（60 秒），判定 worker 卡死：

- `runService.markError(runId, "worker heartbeat timeout")` —— `Run.status = "error"`。
- `child.kill()` 结束子进程。
- `Thread.runStatus` 改为 `"error"`（**不是** `"idle"`，区别于用户主动停止）。
- 如果 SSE 连接仍然打开（`!res.writableEnded`），写入一个 `RUN_ERROR` 事件（`{ type: EventType.RUN_ERROR, threadId, runId, message: "worker heartbeat timeout" }`）后 `res.end()`。
- 按现有 `saveRun()` 规则落库当前已聚合的 assistant 消息，`status` 字段标记为错误（与现状 `RUN_ERROR` 分支的落库行为一致，**不**走"已停止"的 `incomplete` 分支）。

心跳超时与"用户点击停止"是两条独立路径，互不复用：前者最终 `Run.status = "error"` / `Thread.runStatus = "error"`，后者最终 `Run.status = "cancelled"` / `Thread.runStatus = "idle"`。

### API 重启后的孤儿 Run 恢复

worker 是 API 的子进程，API 重启/崩溃会导致：

- 所有 worker 子进程因 IPC `disconnect` 自杀退出（Section A）。
- 数据库里对应的 `Run` 记录仍停留在 `queued` / `preparing` / `running` / `cancelling` / `requires_action` 等非终态。

API 启动时（`RunsModule` 的 `onModuleInit`）执行一次扫描：

1. 查询所有 `status` 为 `queued` / `preparing` / `running` / `cancelling` / `requires_action` 的 `Run` 记录。
2. 对每条记录，`Run.runtimeId` 格式是 `"${pid}:${startToken}"`（fork 时记录，见 Section A）。尝试 `process.kill(pid, 0)` 探测进程是否存活——存活也无法安全恢复（API 重启后丢失了 worker 的 IPC 句柄、内存中的 `pendingQuestionId` 等状态），所以无论探测结果如何，都尝试 `process.kill(pid, "SIGTERM")`（包在 try/catch 里，忽略 `ESRCH` 等错误，pid 可能已不存在或被复用）。
3. 标记 `Run.status = "error"`，`Run.error = "服务重启导致运行中断"`，写入 `Run.finishedAt = new Date()`。
4. 把对应 `Thread.runStatus` 改为 `"error"`，避免前端一直显示"运行中"。

## Section D — 代码文件结构

### 扩展 `packages/protocol`

- `packages/protocol/src/transport.ts`：按"协议基础"一节扩展 `RunStatus`、`RunStatusPayload`、`ControlPayload`、`RunConfig`（新增 `ClaudeAdapterRuntimeConfig`/`CodexAdapterRuntimeConfig`）。
- `packages/protocol/src/envelope.ts`：不改。
- `packages/protocol/src/index.ts`：补充导出新增的 `ClaudeAdapterRuntimeConfig`/`CodexAdapterRuntimeConfig` 类型。

### 新增 app：`apps/worker`

- `apps/worker/package.json` —— 新增 turborepo app；`dependencies` 包含 `@agework/protocol`、`@agework/adapters`、`tsx`（理由见 Section A）。
- `apps/worker/src/ipc-transport.ts` —— `IpcTransport implements RuntimeTransport`（见 Section B）。
- `apps/worker/src/main.ts` —— 入口：
  1. `new IpcTransport()`，`await transport.fetchRunConfig()`。
  2. 根据 `config.adapter.kind` 构造对应 adapter（复用 `packages/adapters`）。
  3. `transport.emit({ type: "run.status", payload: { status: "running" } })`。
  4. `adapter.run(config.input).subscribe({ next, error, complete })`：`next` 里 `transport.emit({ type: "agui.event", payload: event })`；`error`/`complete` 里 `transport.emit({ type: "run.status", payload: {...终态... } })` 然后 `transport.close()` + `process.exit(0)`。
  5. 启动 5 秒定时器发心跳。
  6. `transport.subscribeControls((control) => {...})` 处理 `cancel`/`approval_resolved`（Section B）。
  7. `process.on("disconnect", ...)` 自杀逻辑（Section A）。

### API 端新增/修改

- 新增 `apps/api/src/runs/local-process-provider.service.ts`：`RuntimeProvider` 的本地实现。

  ```ts
  interface RuntimeProvider {
    start(config: RunConfig): Promise<RuntimeHandle>;
    sendControl(handle: RuntimeHandle, control: ControlPayload): Promise<void>;
    cancel(handle: RuntimeHandle): Promise<void>;
    getStatus(handle: RuntimeHandle): RunStatus | undefined;
  }

  interface RuntimeHandle {
    runId: string;
    providerType: "local";
    runtimeId: string; // `${child.pid}:${startToken}`
  }
  ```

  内部职责：`fork()` worker、发送 `run.config`、监听 `child.on("message")` 转发给 `RunEventBus`、心跳超时检测（定时器）、`sendControl` = `child.send()`、`cancel` = 发送 `{type:"cancel"}` 控制指令。

- 新增 `apps/api/src/runs/run-event-bus.service.ts`：`RunEventBus`（Section C）。
- 修改 `apps/api/src/runs/run-registry.service.ts`：`RunHandle` 不再持有 `interrupt: () => void`，改为持有 `{ res, aggregator, runtimeHandle: RuntimeHandle }`，供 `RunEventBus` 写 SSE、`AgentController` 的 stop/question-answer 调用 `provider.sendControl(runtimeHandle, ...)`。
- 修改 `apps/api/src/agent/agent.service.ts`：新增 `buildRunConfig(...)` 方法（Section B），原 `getAdapter(...)` 不再被 `AgentController` 调用（worker 内部会调用 `packages/adapters` 的构造逻辑，但那是 worker 自己的代码，不经过 `AgentService`）。
- 修改 `apps/api/src/agent/agent.controller.ts`：

  - `run()`：

    ```ts
    const runConfig = await this.agentService.buildRunConfig(
      agentType, modelConfigId, projectWorkdir, runId, threadId, runInput
    );
    const handle = await this.localProcessProvider.start(runConfig);
    this.runRegistry.register(run.id, { res, aggregator, runtimeHandle: handle });
    // 后续事件处理、SSE 写入全部移到 RunEventBus，
    // run() 方法本身只负责注册和错误兜底（start() 抛错时的 SSE error 响应）。
    ```

  - `stop()`：`provider.sendControl(handle.runtimeHandle, { type: "cancel", commandId: randomUUID() })`。
  - `answerQuestion()`：找到该 thread 对应的活跃 `RuntimeHandle`，`provider.sendControl(handle.runtimeHandle, { type: "approval_resolved", commandId: randomUUID(), threadId, answers })`；找不到活跃 Run 则 `NotFoundException`。
  - **不再注册 `res.on("close")` 处理器**：浏览器断开连接对 Run 没有任何影响，无论 Run 处于什么状态都不取消、不中断。`RunEventBus` 在 `agui.event` 分支里本来就有 `if (!res.writableEnded)` 判断，断开后只是不再写 SSE，但 `aggregator`/`saveRun()`/`Run.status` 的更新照常进行。如果 Run 当时正处于 `requires_action`，用户重新打开页面后，前端根据 `Thread`/`Run` 的 `pendingAction` 字段仍能看到这个待回答问题，`POST /agent/threads/:threadId/question-answer` 仍能找到活跃的 `RuntimeHandle` 并正常下发 `approval_resolved`——这个接口本来就不依赖 SSE 连接是否存活。
- 修改 `apps/api/src/runs/runs.module.ts`：注册 `LocalProcessProvider`、`RunEventBus`，并在 `onModuleInit` 执行 Section C 的孤儿 Run 扫描。

## Section E — 验证方式

### 自动化检查

- `pnpm typecheck`、`pnpm build`、`pnpm test:api` 全部通过（`apps/worker` 也需能通过类型检查）。
- 现有 `test:api` 用例（`AgentController`、`RunService`、`RunRegistry` 等）在改为走 `LocalProcessProvider` 后仍需全部通过。
- 新增单测：
  - `LocalProcessProvider`：fork、`run.config` 发送、`agui.event`/`run.status`/`heartbeat` 转发给 `RunEventBus`、`sendControl` 幂等（重复 `commandId` 不重复处理）。
  - `RunEventBus`：`seq` 去重/顺序检查、`agui.event` 转发到 SSE 与 aggregator、终态 `run.status` 触发 `RunRegistry.unregister`。
  - 心跳超时：模拟超过 60 秒未收到心跳，断言 `Run.status === "error"`、`Thread.runStatus === "error"`（不是 `"idle"`）。
  - 孤儿 Run 扫描：预置一条 `status="running"` 的 `Run`，启动后断言被标记为 `"error"`、`Thread.runStatus === "error"`。

### 手动冒烟测试（浏览器实测）

1. 发一条消息，确认前端仍正常流式收到回复，用户感知不到背后多了一个子进程。
2. 用 `sqlite3` 查看 `Run` 表：一次对话期间状态按 `queued → running → finished` 变化，`lastSeq`、`lastHeartbeatAt` 持续更新。
3. 点击"停止"按钮：确认能立刻打断 worker 内正在运行的 adapter，`Run.status` 变为 `cancelled`，`Thread.runStatus` 变为 `idle`，前端显示"已停止"。
4. 触发一次需要用户回答的提问：确认 `Run.status` 变为 `requires_action`；在前端回答后，worker 收到 `approval_resolved` 并继续往下跑，`Run.status` 变回 `running`。
5. **SSE 断开 + 待回答问题**：触发提问后，关闭浏览器标签页（不点停止），等待几秒后重新打开页面，确认还能看到这个待回答问题（`Run.status` 仍为 `requires_action`），并且能正常作答、agent 继续往下跑。
6. **重启恢复测试**：对话进行中手动杀掉并重启 API 进程，确认对应 `Run` 被标记为 `error`（`error="服务重启导致运行中断"`）、`Thread.runStatus` 变为 `error`，不会一直卡在"运行中"。
7. **心跳超时测试**：通过临时修改超时阈值（或在测试中 mock）验证 worker 卡死场景下 `Run.status` 变为 `error` 而不是 `cancelled`/`idle`。
8. 对比 Phase 2（adapter 跑在 API 进程内）做同一个 prompt，确认首字延迟无明显回退（fork + IPC 开销应很小）。
