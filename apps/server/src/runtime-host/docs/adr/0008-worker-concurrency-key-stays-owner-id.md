> **⚠ SUPERSEDED**: 本 ADR 已被 server-runtime-worker 目标架构推翻。worker-manager 执行栈在 Phase 3 全部删除，worker 池/信箱/握手/fence 移入 `@agework/runtime/host`。

# Worker 防重键维持裸 ownerId，不升级成 (ownerId, isolationScope, runtimeId)

设计 `Worker`/`Runtime` 新表时一度想把并发防重键从裸 `ownerId` 升级成
`(ownerId, isolationScope, runtimeId)` 三列，让同一用户在两个不同 Runtime 实例上的
user-scope Worker 不互相撞车（比如同时注册了两台 docker 机器）。写代码时发现这个方向站不住：
worker-manager 的整条控制面协议——长轮询取命令（`WorkerManagerService.pollCommands`）、
握手确认（`WorkerHandshakeStore`，内部就是 `Map<ownerId, PendingHandshake>`）、心跳存活
（`WorkerLivenessStore`，按 ownerId 记录 last-seen）、fence 判死——全部只用 `ownerId` 当
key，协议本身不认识 `runtimeId`。哪怕把 DB 唯一约束放开到三列、允许同一 ownerId 同时存在
两个活跃 `Worker` 行，这两个物理进程回连注册时握手表还是会用同一个 `ownerId` 键互相覆盖，
长轮询也分不清命令该发给哪一个——DB 约束放开了，控制面协议本身撑不住，等于制造了一个
DB 允许、实际会串数据的假支持。

## 决定

`Worker.ownerId` 维持 `@unique`（裸列，不是复合键）。系统的真实不变量是"任一时刻一个
owner 只有一个活跃 Worker，与 runtimeType/runtimeId 无关"——这是现状（`activeOwnerKey`
本来就是裸 `ownerId`）就有的限制，不是这次新引入的收紧。真要支持一个 owner 同时对应多个
Worker，需要把 register/poll/心跳/handshake 整条协议的 key 从裸 `ownerId` 换成
`(ownerId, runtimeId)` 复合 key，这是牵一发动全身的协议改动，本次改表不做。

## Consequences

- 同一用户如果先后用不同 runtimeType 起过 Worker（比如先用 docker 又用 opensandbox），
  历史行必须在下一次起号前彻底清空，不能只标终态再等下次 sweep——sweep 如果按
  `(runtimeType, isolationScope, ownerId)` 三元组做，删不掉"同 owner 不同 runtimeType"
  的旧终态行，会在裸 `ownerId @unique` 下产生假冲突。因此 Worker 的停止/报错路径改成
  立刻物理删行，不再是标记终态 + 懒惰 sweep（见
  `docs/design/server-runtime-worker-target-architecture.md` 的翻案清单）。
- 一个用户同时只能有一个活跃的 user-scope Worker，不能跨两台 Runtime 并行——沿用现状限制，
  不是回归。
