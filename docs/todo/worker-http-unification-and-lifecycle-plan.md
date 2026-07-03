# Worker 通道统一 + 注册/心跳生命周期 Plan

**Date:** 2026-07-02
**Status:** Proposed
**Scope:** `apps/server/src/worker-manager`、`apps/server/src/runtime`、`apps/server/prisma`、`apps/worker`、`packages/shared/src/protocol`

## Goal

server 对 worker 一视同仁：不管跑在本地还是沙箱容器,server 负责拉起,worker 启动后**主动注册回连**确认就绪,之后常驻并以**长轮询即心跳**维持活性。local 与 sandbox 的差异被压缩到"怎么把进程弄起来"(fork vs 起容器)这一个动作,启动之后走完全相同的 HTTP 通道与生命周期。

三件事,按依赖排序：

1. local worker 切 HTTP,删 server↔worker IPC 分支(通道统一)。
2. worker 注册握手:server 拉起后等 worker 回连才算 running(修复"spawn 成功 ≠ worker 活着")。
3. 轮询即心跳 + 死亡判定(活性统一)。

## Current Problem

### 1. 通道分裂:local 走 IPC,sandbox 走 HTTP

- sandbox worker:长轮询 `GET /worker/owners/:ownerId/commands`(`command.controller.ts:26`) + `POST /worker/runs/:runId/events` 上行。
- local worker:server 直接持有 fork 出的 `ChildProcess` 收发(`local-instance.executor.ts:161-224` 的 channel 转发)。
- 分岔点:`worker-manager.service.ts:62-82` 的 `if (this.localInstances.has(ownerId))`,openSession/sendCommand 各分一次。
- worker 侧对应两套 transport:`worker-http.ts` / `worker-ipc.ts`(`worker.ts:293-296` 按 `AGEWORK_WORKER_CHANNEL` 选)。

IPC 的生命周期绑死父子进程关系:server 一重启通道即断,local worker 只能被当孤儿 SIGTERM(`local-runtime.provider.ts:48-58`)。只要目标是 worker 常驻,IPC 在架构上不成立。

### 2. server 把"spawn 成功"当"worker 起来了"

`launchWithHandshake`(`sandbox-instance.executor.ts:349`)等的是 `runtimeService.startSandbox()` 返回——即 **Docker 说容器起了**(`:521`),随即 `upsertRunning` 落 running(`:574`)。worker 进程本身能否通信,server 全程不知道。worker 启动即崩(镜像坏、连不上 API base)时,server 认为它 running,命令推进队列永远没人拉。local 侧 fork 成功同样不等于 worker 就绪。

### 3. 没有活性追踪

metadata 里有 `lastSeenAt` 字段(`worker-registry-metadata.ts:9`),但只在状态跳变时写一次,没人刷新。worker 运行中死掉(kill -9、容器 OOM),server 永远不知道,in-flight run 悬死。

## Target Architecture

```text
RunLauncher → resolveRuntimeTarget(isolationScope → ownerId)      # 不变
WorkerRunExecutor → workerManager.resolveInstance()               # 不变
WorkerManagerService.resolveInstance():
    local   → LocalInstanceExecutor   (fork,  env CHANNEL=http)   # 启动策略差异,保留
    sandbox → SandboxInstanceExecutor (容器)                       # 启动策略差异,保留
        └─ 两者 launch 都生成 startToken 注入 env,等 register 才算 running

启动之后 ↓ local / sandbox 完全同一条路
worker → POST /worker/owners/:ownerId/register   (带 startToken,就绪握手)
worker → GET  /worker/owners/:ownerId/commands   (长轮询 = 命令下行 + 心跳)
worker → POST /worker/runs/:runId/events         (事件上行,seq 去重已有)
worker → GET  /worker/runs/:runId                (拉 RunConfig)
```

生命周期状态机(registry 行语义收紧):

```text
insertStarting ──(spawn/起容器)──▶ 等 register ──(startToken 匹配)──▶ upsertRunning + settle ready
      │                                │
      │                                └─ launchTimeout 超时 → markError + 清理进程/容器
      └─ spawn 失败 → markError

running ──(连续 N 个轮询周期未见心跳)──▶ unhealthy → fence(stop/kill 载体) → markStopped + 终结 in-flight run + 清命令队列
worker ──(任意端点收到 410: token 不匹配/已被驱逐)──▶ 退出进程(主动 re-register 留到后续阶段)
server 重启 ──(sandbox: running 行+token 列存活,worker poll 命中即被动收编;宽限窗内未现身 → fence)
           ──(local: 清孤儿 + 行标 stopped,现状行为)
```

worker 内部 worker↔runner 恒定 IPC(`runner-manager.ts:225-243`),与本计划无关,不动。

## Design Decisions

**轮询即心跳,不加独立 heartbeat RPC。** 长轮询每 ≤25s 必然回连一次(`COMMAND_LONG_POLL_MS = 25_000`,`worker.ts:24`),就是现成的心跳信号。独立 `POST /heartbeat` 让 worker 多一个定时器、server 多一个端点,信息量为零。

**lastSeen 放内存,不每 poll 写 DB。** 每 owner 每 25s 一次 DB 写没有意义。内存 store 记 `touch(ownerId)`,DB 只在状态跳变时落。server 重启后内存为空,由"重启语义"一条的收编/fence 流程重建(见下)。

**心跳超时即 unhealthy,处置用 fencing,不做"确认死亡"。** 超时不等于进程死了——worker 可能 event loop 卡死、poll 循环挂住、网络断开,这些情况进程还在但 run 已悬死。所以判定条件只有一个:超过阈值没见到心跳 → unhealthy → **主动 stop/kill 载体(幂等 fencing)** → markStopped → 终结 in-flight run。engine/pid 检查只用来选择清理手段和写诊断日志,不作为判死的必要条件。fence 之后才终结 run,保证卡死的 worker 不会事后诈尸上报。

**startToken 跟载体走,不跟化身走。** Docker resume 只是 `docker start`(`docker-engine.ts:142-160`),不会更新容器创建时注入的 env——每次 launch 都发新 token 的话,resume 后 worker 必然带旧 token register 然后超时。所以:token 在**载体创建时**生成(fresh 容器 create / local fork),只有重建载体才发新 token;resume 复用原 token,server 用持久化的 token 校验。防冒领语义不受影响:旧容器残留 worker 的 token 属于旧载体,冒领不了新载体的 register。owner 级 token,先例是 runner 级的 `AGEWORK_WORKER_RUN_START_TOKEN`。

**token 的存活闭环:独立列,不放 metadata。** "持久化在行里"必须落到具体机制,现有 registry 有两个销毁点:`markStoppedByOwner` 整体替换 metadata(`worker-registry.repository.ts:178-190`),`insertStarting` 插新行前先删该 owner 的 stopped/error 行(`:134-136`)——token 放 metadata 的话,idle stop → resume 一趟就丢了。放 ownerState 内存也不行(server 重启即丢,而重启收编恰恰依赖 token)。所以:**token 作为 WorkerInstance 独立列**;`markStoppedByOwner` 不动该列;`insertStarting` 走 resume 路径时先读出旧 stopped 行的 token 带入新行,重建载体时才生成新值。脱敏随之简单:该列默认不进对外 select(repository 层挡,规则本就要求敏感列在 select 层解决),admin runtime view(`runtime-instance-view.ts:45` 现在原样返回 metadata)与日志都碰不到它。

**server 重启语义:sandbox 被动收编,local 清孤儿。** 现状本来就刻意保留 sandbox running 行、重启后 `insertStarting` 冲突即复用容器(`sandbox-instance.executor.ts:341-346`),启动时 fence 全部旧 worker 是行为回退。token 列跨重启存活后,收编几乎免费:常驻 worker 一直在带 token poll,命中 DB running 行且 token 匹配 → 接受并 `touch()`,活性记录自然重建,**不需要 re-register 协议**(主动 re-register 握手仍留到后续阶段)。配套两件事:① 队列 seq 是内存计数,重启归零,worker 旧 `afterSeq` 会把新命令全部过滤掉——poll 响应带 `queueEpoch`(owner 队列创建时生成),worker 检测 epoch 变化即重置 afterSeq=0;② 启动后给收编一个宽限窗(约 2× 轮询周期),watchdog 以 DB running 行播种,窗内没等到该 owner 的 poll → 正常走 fence 流程,收编与判死共用一条路,不需要启动时特判。local 维持现状清孤儿(`local-runtime.provider.ts:48-58` SIGTERM)+ 行标 stopped:fork 子进程复用价值低,local run 本来也不恢复(`run-recovery.service.ts` 跳过 local)。

**token 覆盖全部 worker 端点,不只 register。** 只校验 register 的话,被拒的旧 worker 仍能按 ownerId 轮询消费命令——而队列是单 consumer 假设、poll 即截断(`command-queue.ts:88` 的 TODO 自述),旧 worker 会吃掉新 worker 的命令。所以 register 之后,`commands` / `runs/:runId` / `events` 全部带 token(header,如 `x-agework-worker-token`),server 按 owner 当前 active token 校验,不匹配返回 410——这就是驱逐旧 poller 的机制,也是未来 access key 的现成位置(换掉 token 的生成与分发方式即可,校验管道不变)。

**为 WS 演进留接缝,但本轮只做轮询。** 后续可能把命令下行换成 WebSocket。通道差异必须收敛在三个点,业务层不感知:

| 接缝 | 轮询实现(本轮) | WS 时替换为 |
|---|---|---|
| worker 侧 transport 接口 | `pollCommands()` 循环 | WS 订阅 |
| server 侧命令下发 | `WorkerCommandQueue` push + poll 取走 | 连接直推(push 模型已适配) |
| 活性信号源 | poll 到达时 `touch(ownerId)` | 连接存活 / pong 时 `touch(ownerId)` |

另有两个现成扣子:`afterSeq` 重放语义(`GET /commands?afterSeq=N`)就是 WS 的断线重连机制——重连带 afterSeq 从队列重放不丢命令,所以 WS 时队列不能扔,它从"轮询取货架"变成"重连重放缓冲";`WorkerInstance.transport` 列已存在(默认 `"http"`),WS worker 落 `"ws"`,registry 结构零改动。

约束:`touch()` 由 controller/transport 层调用,活性 store 与死亡判定逻辑只认 "上次见到的时间",不认识 "poll" 这个词;register 保持一次性 HTTP POST,不随通道变(WS 也是先 register 再建连,不做"第一帧注册")。Step 1 删 `AGEWORK_WORKER_CHANNEL` 不堵扣子——将来通道由 server 下发配置决定,届时重新引入选择器,现在留着是死代码。

**鉴权本轮不做。** worker 端点维持 `@Public()` 现状(`worker-run.controller.ts:12-13` 已注明是临时移除)。register 端点就是未来换发 access key 的位置,形状先留好,逻辑推后。

## Steps

### Step 0: model 改名 RuntimeInstance → WorkerInstance

统一后一行 registry 记录就是"一个 owner 的常驻 worker"(槽位 + 运行载体),叫 `RuntimeInstance` 名不副实——它归 `worker-manager` module、repo 已经叫 `worker-registry.repository.ts`。

改动:

- Prisma schema(`schema.prisma:211,241`):`RuntimeInstance` → `WorkerInstance`;`WorkspaceRuntimeInstance` → `WorkspaceWorkerBinding`(它是 workspace ↔ 容器的关系表,schema 注释自述"语义上等价 SandboxWorkspaceBinding",用关系词命名,不冒充实体),其 `resourceId`/`resource` 字段 → `workerInstanceId`/`workerInstance`(指向 `WorkerInstance.id` 的外键,与载体 id `runtimeInstanceId` 是两回事);dev 阶段 `pnpm db:push` 即可。
- 代码引用替换:圈在 worker-manager 内部(registry repo/metadata、`runtime-instance-view.ts` → `worker-instance-view.ts`、lifecycle、admin DTO/controller 的类型引用)。
- **不改的**:`runtimeInstanceId` 字段与概念(容器 id / `pid:token`,语义是"运行载体 id",贯穿 protocol/runtime/run 模块,改它是错误的大范围替换);admin HTTP URL 路径(外部契约,不在本计划内动)。

→ 验证:`pnpm db:push` 成功;`pnpm typecheck` + eslint;`pnpm test:server` 全绿。

### Step 0.5: 恢复 active-owner 唯一约束(pre-flight 发现的存量断裂)

执行前核查发现:`insertStarting` 依赖的 partial unique index(`runtime_instance_active_owner_idx`,每 owner 最多一条 starting/running 行)**在当前 dev.db 里不存在**——`dee503bd` 曾建立迁移基线含此索引,但 `97444ff8`(apps/api→apps/server 改名)删除了整个 migrations 目录,仓库退回 db-push-only,索引随 db:push 重建而丢失。后果:并发防重与"重启后 insertStarting 冲突→复用 running 容器"的 P2002 路径在 DB 层面全部失效,而本计划的被动收编正建立在这条路径上。

修复(schema 原生,不恢复 migrations 工作流):WorkerInstance 加可空列 `activeOwnerKey` + `@@unique([activeOwnerKey])`——`insertStarting`/`upsertRunning` 时置为 ownerId,`markStopped/markError` 时置 NULL;SQLite unique 允许多个 NULL,语义等价 partial index 且在 db:push 下天然存活。写路径全部集中在 `worker-registry.repository.ts`,改动收口;同步修正该文件 `:117` 处引用不存在索引的注释。

→ 验证:单测覆盖 并发第二次 insertStarting 撞 P2002 走冲突分支 / 终态行不阻塞新插入;`sqlite3 dev.db` 确认 unique 索引存在;`pnpm test:server` 全绿。

### Step 1: local worker 切 HTTP,删 IPC 分支

改动:

- `local-instance.executor.ts`:补 `AGEWORK_WORKER_API_BASE`、`AGEWORK_WORKER_OWNER_ID` 等 sandbox 侧已有的变量(对齐 `sandbox-instance.executor.ts:421-435`)。**API base 不能只写 loopback + PORT**:必须像 `resolveDockerApiBase()`(`sandbox-utils.ts:9-18`)一样经 `resolveApiBasePath(AGEWORK_CONTEXT)` 拼上 `/api/v1` 全局前缀,否则 worker 打到 `/worker/...` 而不是 `/api/v1/worker/...`——local 版与 docker 版共用同一拼装函数,只有 host 不同(loopback vs `host.docker.internal`);删 channel 收发与上行转发(`:161-224` 一带)。`ChildProcess` 句柄仍保留用于 exit 监听(父进程免费的快速死亡信号)与 kill。
- `worker-manager.service.ts`:删 `localInstances.has(ownerId)` 分支(`:62-82`),openSession/sendCommand 统一走 commandDispatcher。
- `apps/worker`:删 server↔worker 的 `transport/worker-ipc.ts` 与 `worker.ts:293-296` 的通道选择(`runner-ipc.ts` 是 worker↔runner 的,保留)。**worker 进程不再读 channel**:transport 由角色决定(worker 恒 http、runner 恒 ipc,`AGEWORK_WORKER_ROLE` 已足够),`AGEWORK_WORKER_CHANNEL` env 整个删除——server 两个注入点与 worker 读取点同删,不留半套死开关。
- `runtime.types.ts` 的 `LocalInstanceHandle.channel`(`:61-65`)语义更新:不再交出 IPC 收发权。

→ 验证:`pnpm dev` 起 local 对话完整跑通一轮消息;`pnpm --filter server test -- worker-manager` 相关 spec 更新通过;`pnpm typecheck` + eslint(不能只信 tsc)。

### Step 2: 注册握手(修复假 running)

改动:

- `packages/shared/src/protocol`:加 `WorkerRegisterRequest` 类型(`startToken`、`pid`、诊断字段)。
- server 新端点 `POST /worker/owners/:ownerId/register`(放 `command.controller.ts` 同一 controller 或平级,`@Public()` 维持现状)→ `WorkerManagerService.registerWorker(ownerId, body)` → 路由到对应 executor 的 pending 握手。
- 两个 InstanceExecutor:**载体创建时**生成 `startToken` 注入 env `AGEWORK_WORKER_START_TOKEN`,持久化为 **WorkerInstance 独立列**(不放 metadata,存活闭环与脱敏见 Design Decisions;fresh 容器 create / local fork 才生成;**docker resume 不发新 token**——`docker start` 不更新 env,resume 路径读回原列值作为期望值,`insertStarting` 删旧终态行前先把 token 继承到新行);`launchWithHandshake` 的等待对象从 "engine start 返回" 延长为 "收到匹配 token 的 register"(pending promise map),现有 `withTimeout`(`sandbox-instance.executor.ts:383-387`,`getLaunchTimeoutSeconds`)罩住全程;register 到了才 `upsertRunning` + settle ready,并把化身信息(pid/registeredAt)写进行 metadata(行身份是载体级,resume 后容器 id 不变但 worker 是新化身,行里必须记清当前活着的是哪个化身);超时 → `markError` + 停容器/杀进程。token 不匹配的 register 拒绝并记日志。
- **token 校验覆盖全部 worker 端点**:register 通过后,`commands` / `runs/:runId` / `events` 请求带 `x-agework-worker-token` header,server 按 owner 当前 active token 校验,不匹配返回 410(驱逐旧 poller,防止它按 ownerId 截断消费命令队列)。
- `apps/worker/src/worker.ts`:启动后、进入 poll 循环前先 register(带重试/退避),失败到上限退出进程;此后所有请求带 token header;**任意端点收到 410 → 退出进程**(不 re-register,收编留到后续阶段)。

→ 验证:单测覆盖 握手成功 / launch 超时未 register / stale token 被拒 三条路;手动把 worker 入口改成启动即抛错,确认 server 在 launchTimeout 内落 error 而非假 running。注意 run 的 ready settle(`sandbox-instance.executor.ts:134`)会从"容器起了"推迟到"worker 注册了",首条消息等待更诚实地变长,是修正不是回退。

### Step 3: 轮询即心跳 + 死亡判定

改动:

- `worker-manager/registry/`(或 liveness 子目录)加内存活性 store:`touch(ownerId)` / `lastSeenAt(ownerId)`,由 `pollCommands` 入口调用。
- watchdog(照 `IdleWatchdog` 模式,`sandbox-utils.ts:24`):连续 2~3 × 25s 未见心跳 → unhealthy → **fence:主动 stop/kill 载体(幂等)** → `markStoppedByOwner` + 终结 in-flight run + 清空 `WorkerCommandQueue` + 清 ownerState。engine/pid 状态只用于选择清理手段和诊断日志,不作为判死前置条件(worker 卡死/断网时进程还在,但 run 已悬死,照样 fence)。
- **终结 run 的落点**:owner → attached runIds 索引放 **worker-manager.service facade 层,不放 executor**——release 路由现在只进 sandbox executor、local release 是 no-op(`worker-manager.service.ts:132`、`local-instance.executor.ts:153`),放 executor 会让 local run 泄漏在索引里,watchdog 误终结已完成 run。facade 在 acquire 成功后登记,`releaseInstanceForRun`/`cleanupRun` **先清索引再分发**给 executor。`WorkerUpstreamPort`(`worker-manager.types.ts:7`,现仅 `sendEvent`)增加 `notifyWorkerLost(runId, reason)`,watchdog 逐 run 回流,run 层 handler 走既有失败终结路径。Port 从 1 方法变 2,仍在 infra 回流纪律内;不需要在 run 层新建 owner 维度 facade。
- **queueEpoch**:poll 响应带 `queueEpoch`(owner 队列创建时生成),worker 检测 epoch 变化即重置 afterSeq=0——队列 seq 是内存计数,server 重启归零,否则被收编 worker 的旧 afterSeq 会把新命令全部过滤掉。
- worker 侧对偶动作:任意端点收到 410 → 退出进程(见 Step 2)。**server 启动 reconcile 只处理 local**(清孤儿 + 行标 stopped,现状行为);sandbox running 行保留——watchdog 以 DB running 行播种,启动宽限窗(约 2× 轮询周期)内等到该 owner 的 poll 即被动收编,没等到就走 fence,收编与判死共用一条路,不做启动时特判(见 Design Decisions 重启语义)。
- 阈值经 `ConfigService` 读,不散写常量。

→ 验证:单测覆盖 touch 刷新 / 超阈值 fence + 逐 run 回流终结 / 410 驱逐后旧 worker 不再消费队列;手动 `kill -9` local worker 与 `docker kill` 容器,确认 server 在窗口内标 stopped 且 run 被终结,再发消息能重新拉起;手动 `kill -STOP`(模拟卡死)确认同样被 fence;重启 server,确认存活 sandbox worker 在宽限窗内被收编、epoch 重置后新命令可达,local worker 被清孤儿。

## Non-goals(显式推后)

- **鉴权 / access key**:register 端点形状已为其留位,单独排期(见 `docs/todo/auth-security-priority-plan.md` 体系)。
- **主动 re-register 协议**:sandbox 的**被动收编**(worker 持续带 token poll 命中 DB running 行即收编)本轮已含;worker 主动重新握手(换 token、长时间断连后自证)留到后续。**local 跨重启复用**同样推后,本轮维持清孤儿。
- **WebSocket 下行**:只留接缝(见 Design Decisions),不实现。
- **暂停/休眠逻辑**、**local 的 isolationScope 粒度**(现为写死 `"workspace"` 占位,`local-instance.executor.ts:80`,user 级一进程 vs workspace 级一进程待拍板):维持现状。
