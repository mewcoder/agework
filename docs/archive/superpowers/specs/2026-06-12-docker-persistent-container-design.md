# Docker 工作空间级持久容器设计（MVP）

## 目标

- **一个 workspace 一个持久容器**：容器以 workspaceId 命名，同 workspace 复用同一个长期运行的容器。
- **thread 并行**：同一 workspace 下多个 thread 可以同时运行，互不阻塞。
- **能 resume**：同一 thread 连续多轮对话能续上会话。

## 背景

当前 Docker 模式每次 run 起新容器，worker 跑完 `adapter.run()` 就 `process.exit(0)`，容器 `--rm` 自删。导致：

- adapter 的 `sessions` Map 随容器销毁，下一条消息无法 resume，报 "No conversation found with session ID"
- 每条消息都有容器冷启动开销（几秒）
- 因为上面这点，`agent-run-handler.ts` 对 docker 直接关掉了 resume（`providerType !== "docker"` 才传 `forwardedProps.resume`）

持久化容器后，常驻 worker 持有的 adapter 实例跨 run 复用，`sessions` Map 保持，resume 与并行都成立。

## 核心决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 容器粒度 | workspace 级 | 容器以 workspaceId 命名（`agework-ws-{wsId}`），同 workspace 共享一个持久容器 |
| 并发策略 | **并行多 thread** | 同 workspace 多个 thread 可并行跑；adapter 内部状态（`activeQueries`/`sessions`）按 threadId 分片，单实例天然并发安全 |
| 文件系统 | 共享 `/workspace`，不隔离 | 接受并发编辑；不同文件无冲突，同一文件并发写竞争由使用方承担（见下方说明） |
| 复用方式 | worker 常驻 + 多路复用 | 一个 adapter 实例跨 run 复用，`sessions` 保持；worker 同时持有多个活跃 run 的订阅 |
| Resume | 内存 + DB 两层 | 容器存活时靠 adapter `sessions`（threadId→sessionId）自动续；容器重建时靠 DB `agentResumeId` 兜底 |
| 空闲回收 | MVP 不做 | 容器持续运行，后续再加超时回收 |

> **并发编辑的代价（已知并接受）**：单个 agent 的并行 tool call 由一个进程内协调；两个 thread 的 `query()` 是两个互不知情的子进程，对**同一个文件**可能基于各自旧读取做 read-modify-write 而丢更新。`enableFileCheckpointing` 只记录变更用于回溯，不防并发写竞争。不同文件并发无问题。MVP 接受此代价，不做 worktree/拷贝隔离。

## Resume 怎么成立（两层）

| 层 | 机制 | 作用 |
|----|------|------|
| 内存（主路径） | 容器常驻 → worker 常驻 → adapter 实例常驻 → `sessions: Map<threadId, sessionId>` 不销毁 | 同容器内多轮，`adapter.run` 按 threadId 自动注入 `resume`（`adapter.ts:143`）；按 thread 分片，并发不冲突 |
| DB（持久兜底） | `thread.agentResumeId`，由 `runtime-event-processor` 收到 `session_id` 事件时落库 | 容器被重建/崩溃/孤儿回收后内存 Map 为空时，用它经 `forwardedProps.resume` 续上 |

`adapter.run()` 里两者合流：内存有 session 用内存的，没有则用传入的 `forwardedProps.resume`（即 agentResumeId），两者指向同一 sessionId。

## 容器生命周期

容器命名：`agework-ws-{workspaceId}`

| 事件 | 行为 |
|------|------|
| workspace 首次 run | `docker run --name agework-ws-{wsId}`（**不带 `--rm`**）新建持久容器，起常驻 worker |
| 同 workspace 再来 run（容器在） | 注册 runConfig + push `user_message{runId}` 控制；worker 新开一路并发执行，**不拒绝、不排队** |
| 某个 run 完成 | worker 关闭该 run 的订阅并上报终态；容器和其他并行 run 不受影响 |
| cancel 某 thread | 发 cancel 控制；worker 精确中断该 thread 的 query；容器存活 |
| workspace 删除 | `shutdownContainer(wsId)`：停止并删除容器 |
| 服务重启 | 清理所有 `agework-ws-*` 容器（孤儿回收），相关 run 标记 error |

## 改动清单

### 1. Worker 多路复用（`apps/worker/src/main.ts`）

当前：`fetchRunConfig() → adapter.run() → finalize() → process.exit(0)`，单 run、跑完即退。

改为：常驻 + 多路复用，同时持有多个并发 run。

```
读 AGEWORK_WORKSPACE_ID → createAdapter()（只创建一次）
轮询 workspace 级控制端点：
runs: Map<runId, Subscription>
收到 user_message { runId }:
  config = GET /internal/runs/:runId/config        // 拿 threadId + input + model
  sub = adapter.run(config.input).subscribe({
    next:     e => transport.emit({ runId, type:"agui.event", payload:e }),  // 按各自 runId 打标
    complete: () => { emitStatus(runId,"finished"); runs.delete(runId) },
    error:    e => { emitStatus(runId,"error");     runs.delete(runId) },
  })
  runs.set(runId, sub)
收到 cancel { runId, threadId }:  adapter.interrupt(threadId)
收到 approval_resolved { threadId, answers }:  resolveQuestion(threadId, answers)
```

- adapter 实例只创建一次，跨 run 复用（`sessions`/`activeQueries` 按 threadId 分片，并发安全）
- `finalize()` 拆成「单个 run 的终态上报」：只上报该 runId 的终态，**不调 `process.exit()` / `transport.close()`**
- 心跳持续发送（即使 `runs` 为空也发，保持容器存活）
- 事件回报的 runId 用每个订阅闭包里的那个，天然不串

### 2. Adapter 按 thread 精确中断（`packages/adapters/src/claude/base/adapter.ts`）

当前 `interrupt()` 中断**所有** `activeQueries`。并发下 cancel 一个 thread 不能误杀别的：

```ts
async interrupt(threadId?: string): Promise<void> {
  if (threadId) { await this.activeQueries.get(threadId)?.interrupt(); return; }
  for (const q of this.activeQueries.values()) await q.interrupt();
}
```

### 3. HttpTransport 改造（`apps/worker/src/http-transport.ts`）

- 读取 `AGEWORK_WORKSPACE_ID` 环境变量
- 控制轮询改为 workspace 级端点：`GET /internal/workspaces/:workspaceId/controls?afterSeq=N`
- 每条控制 envelope 携带 `runId`（worker 据此分发到对应订阅 / RunConfig fetch）
- `emit()` 事件用各 run 的 `runId`（来自订阅闭包，不需要全局 currentRunId）

> **为什么 workspace 级而非 thread 级**：一个常驻 worker 要同时服务同 workspace 下多个并行 thread。若按 thread 轮询，worker 得同时轮询 N 个端点。workspace 级端点让 worker 只轮询一个目标，envelope 里靠 `runId`/`threadId` demux。

### 4. Docker Provider 改造（`apps/api/src/runtime/providers/docker-runtime-provider.ts`）

**状态从 per-run 改为 per-workspace + 并发计数**：

```ts
type DockerWorkspaceState = {
  containerId: string;
  accessKey: string;            // workspace 级 access key
  activeRuns: Set<string>;      // 当前并行的 runId 集合
};
workspaceContainers: Map<workspaceId, DockerWorkspaceState>
```

**`start()` 改造**：
- 查 `workspaceContainers.get(workspaceId)`
- 没有容器 → `docker run --name agework-ws-{wsId}`（去掉 `--rm`），生成 workspace 级 access key
- 有容器 → 直接复用
- 两种情况都：`runConfigStore.register(runId, config)` → push `user_message{runId}` 到 workspace 控制队列 → `activeRuns.add(runId)`。**不拒绝、不排队。**

**`cancel()` 改造**：
- 发 cancel 控制中断对应 thread 的 `adapter.run()`，**不杀容器**
- `activeRuns.delete(runId)`

**`cleanup(runId)` 改造**：
- 只清 per-run 状态（control/config/access-for-run），`activeRuns.delete(runId)`，**容器保留**

**心跳 watchdog 改为容器级**：
- 当前 watchdog 按 runId，超时杀容器。持久并发下必须按 **workspaceId/容器**，否则单个 run 超时会误杀共享容器
- worker 只要容器活着就持续发心跳，watchdog 按 wsId 计时

**新增 `shutdownContainer(workspaceId)`**：
- 停止容器（docker stop/kill）+ 清理所有关联状态
- 在 workspace 删除时调用

**`startContainer()` 改造**：
- 传 `AGEWORK_WORKSPACE_ID` 环境变量（替代/补充 `AGEWORK_RUN_ID`）
- 加 `--name agework-ws-{workspaceId}`，去掉 `--rm`

### 5. RuntimeRunner 适配（`apps/api/src/runtime/core/runtime-runner.ts`）

- 去掉任何「同 workspace 有活跃 run 就拒绝」的门控（并行允许）
- 容器在 → 复用路径（register + push `user_message`）；容器不在 → 新建路径

### 6. AgentRunHandler 去掉 docker resume 限制（`apps/api/src/agent/agent-run-handler.ts`）

去掉 `providerType !== "docker"` 判断，docker 也传 `forwardedProps.resume = agentResumeId`：

```ts
if (agentResumeId && agentType === "claude") {
  forwardedProps.resume = agentResumeId;
}
```

容器持久化后内存 session 跨 run 保持；即使容器被重建，DB `agentResumeId` 兜底，两条路都能 resume。

### 7. Workspace 级控制队列和端点

**RuntimeControlQueue**（`apps/api/src/runtime/internal/runtime-control-queue.ts`）：
- 现有的 `pushForThread`/`pollByThread`/`cleanupThread`（thread 级）粒度不对，改为 **workspace 级**：`pushForWorkspace(workspaceId, envelope)` / `pollByWorkspace(workspaceId, afterSeq)` / `cleanupWorkspace(workspaceId)`
- envelope 内含 `runId`（控制按 run 定位）

**RuntimeWorkspaceController**（`apps/api/src/runtime/internal/runtime-workspace.controller.ts`，替换现有的 `runtime-thread.controller.ts`）：
- `GET /internal/workspaces/:workspaceId/controls?afterSeq=N`
- 供持久容器 worker 按 workspaceId 轮询控制消息

### 8. RuntimeProvider 接口扩展（`packages/shared/src/protocol/transport.ts`）

新增可选方法：
```ts
getStateByWorkspaceId?(workspaceId: string): { containerId: string } | undefined;
heartbeatWorkspace?(workspaceId: string): void;
shutdownContainer?(workspaceId: string): void;
```

### 9. 孤儿回收

`RunRecoveryService.recoverOrphanRuns()` 改造：
- 扫描所有 `agework-ws-*` 容器（`docker ps --filter name=agework-ws-`）
- 停止并删除
- 标记相关 run 为 error

### 10. Access Key 管理（workspace 级）

- 当前 access key 按 runId 签发/吊销（`issueAccessKey(runId)` / `revokeAccess(runId)`）
- 改为容器启动时生成一个 **workspace 级** access key，存入 `DockerWorkspaceState`，worker 用这个 key 访问所有端点（config fetch + control poll + event emit）
- per-run 端点（config fetch / event emit）的鉴权需接受该 workspace 下任意 run 的请求（用 workspace key 校验）

## 不改的部分

- **Local Provider**：保持每次 fork 新进程 + DB resume，不动
- **RuntimeEventProcessor**：基本不变，事件按 runId 处理，天然支持多 run 并发；session_id 落 DB（`agentResumeId`）的逻辑保留
- **RuntimeInternalController**：保持 per-run 的 config fetch / event emit 端点（worker 拿到 `user_message{runId}` 后按 runId fetch config、emit 事件）

## 验证

1. `pnpm typecheck` + `pnpm test:api` 通过
2. Docker 模式下同一 thread 连续发两条消息，第二条能 resume（adapter session 保持）
3. 同一 workspace 两个不同 thread **同时**发 run，能并行执行，事件按各自 runId 正确回报，互不阻塞
4. 并行的两个 run 各自 cancel 互不影响，且都不杀容器
5. workspace 删除后对应容器被停止删除
6. 服务重启后孤儿 `agework-ws-*` 容器被清理，相关 run 标记 error
7. Local 模式不受影响
