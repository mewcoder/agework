> **⚠ SUPERSEDED**: 本 ADR 已被 server-runtime-worker 目标架构推翻。worker-manager 执行栈在 Phase 3 全部删除，worker 池/信箱/握手/fence 移入 `@agework/runtime-host`。

# 工作空间文件命令(list_files/read_file)走独立通道,不进 command.result / RunEvent

工作空间文件预览需要 worker 执行 `list_files` / `read_file` 并把结果带回 server。直觉上应该复用现有的
「server 发命令 → worker 长轮询拉取 → 处理完 `command.result` 回传」范式——`cancel`/`interrupt`/
`approval_resolved`/`user_message` 都是这么走的,看起来是个现成的「server 发请求 → worker 应答」机制。
但这条通道从下到上都是彻头彻尾 run-scoped 的:`RunChannelMessage.runId` 是必填字段;
`packages/worker/src/runner-manager.ts` 的 `RunnerManager.handle()` 靠 `command.runId` 把命令转发给
对应的 runner 子进程,文件浏览没有 runner 可转发;`command.result` 最终落进 `RunEvent` 表,
`RunEvent.runId` 是必填外键关联 `Run`(`onDelete: Cascade`)。而文件预览的典型场景恰恰是「worker 在线但
没有活跃 run」(上一个 run 已终态,容器/进程还常驻着)——这时候没有任何真实 runId 可用;伪造一个会在外键
处直接失败,借用最近一次真实 run 的 runId 又会污染那次 run 的审计事件时间线,还会撞上 `WorkerSeqStore`
的 seq 去重状态。

## 决定

文件命令完全不进 `CommandPayload` / `CommandResultPayload` / `RunChannelMessage` / `WorkerUpstreamPort`
/ `RunEventService` 这条 run 专属流水线,新开一条独立的、无 run 语义的 owner-scoped 通道:

- 下行复用同一条物理长轮询连接(`/worker/owners/:ownerId/commands`,同一个 `WorkerCommandQueue`),
  但队列消息类型是新的 `RunChannelMessage<CommandPayload> | OwnerCommand<WorkspaceFileCommandPayload>`
  联合——不新开连接,只是同一个信箱里多一种不含 `runId` 的信封。`OwnerCommand` 与 `RunChannelMessage`
  **共享同一个 owner 级 seq 计数器**(否则混在同一队列时 `afterSeq` 确认语义失效),并携带
  `workspaceRoot`(执行环境内绝对路径,server 经 `resolveRuntimeSpec` 算出——user 隔离下一个常驻
  worker 服务同用户多个 workspace,worker 没有唯一工作区根,不能靠自身 workdir 推)与 `expiresAt`。
- worker 侧分流点在 `worker.ts` 里 `commands.run((command) => runnerManager.handle(command))` 那个
  回调 lambda,**`commands.ts` 一行不动**:lambda 里判断命令类型,文件类命令交给常驻 worker 新增的
  `WorkspaceFileCommandHandler`(`RunnerManager` 的兄弟角色,不进 `RunnerManager.handle()`),
  以 `void fileHandler(cmd).catch(...)` fire-and-forget(立即返回,外层 `await` 秒过,不阻塞同批次
  排在后面的 `cancel`/`interrupt`);其余命令仍走 `runnerManager.handle`。
- 上行结果经一个新端点(`POST /worker/owners/:ownerId/file-command-results`)直接回传,由
  `worker-manager` 新增的 `WorkspaceFileCommandStore`(pending map + `withTimeout`,结构照抄
  `WorkerHandshakeStore`)按 `commandId` resolve,不落 `RunEvent`,纯内存、不持久化。

## 为什么

1. `CommandPayload` 的每个分支语义上都是「转发给某个 runner 子进程」,文件命令没有 runner 可转发,硬塞
   进去会让 `RunnerManager.handle()` 承担两种不相关的职责。
2. `RunEvent.runId` 外键要求真实存在的 `Run` 行,文件预览常见的「无活跃 run」场景下根本凑不出一个合法
   runId。
3. 两个方向都独立出来(而不是只改上行或只改下行),协议形状更一致,`channel.ts` 里的 run 专属类型对这个
   功能保持零侵入。

## 投递语义(队列是 at-least-once)

`WorkerCommandQueue.pollByOwnerId` 只删 `seq ≤ afterSeq` 的消息,worker 冷启动 `commandSeq=0`
(`worker-http.ts`)会重放所有未确认消息。两层防线互补:

- `WorkerCommands.processedCommands`(`commands.ts`,已存在的 commandId 去重 Set)挡**同一进程生命周期内**
  的重复投递;进程重启即清空,对文件命令天然生效(白赚一层)。
- `OwnerCommand.expiresAt`(server 入队时取 now + awaiter 超时 10s)挡**跨重启**的陈旧重放——worker
  分流处先查过期,过期直接丢弃、不执行不回传。这正是 `processedCommands` 挡不住、对将来写命令(见
  workspace-diff-and-versioning-design.md 的 `discard_file_change`)危险的场景:重启后重放几分钟前的
  写操作会在用户不知情时改工作区。
- server `file-command-results` 端点收到未知 `commandId`(pending 已超时清理)时静默返回 200——迟到
  结果是协议正常情况,不是异常。

## Consequences

- 下一个类似「常驻 worker 需要处理非 run 请求」的场景,应该延续这个「owner-scoped 独立通道」模式,
  而不是继续尝试塞进 `CommandPayload`。
- `WorkspaceFileCommandStore` 的 pending 条目必须在 `withTimeout` 超时/出错分支显式清理(照抄
  `worker.provisioner.ts` 里 `handshakeStore.cancel(...)` 那个 catch 分支的写法),否则 worker 迟迟
  不回或永久失联时会在 Store 里留下再也不会被消费的 pending Promise。
