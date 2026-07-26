> **⚠ SUPERSEDED**: 本 ADR 已被 server-runtime-worker 目标架构推翻。worker-manager 执行栈在 Phase 3 全部删除，worker 池/信箱/握手/fence 移入 `@agework/runtime/host`。OwnerKey/WorkerKey 公共协议概念已被 [Runtime owner boundary](../../../../../../docs/design/runtime-owner-boundary.md) 进一步推翻，复用身份由 Runtime 内部派生。

# Worker 防重键升级为 (ownerId, runtimeId, isolationScope) 复合唯一约束

> 推翻 [ADR-0008](./0008-worker-concurrency-key-stays-owner-id.md)。

## 背景

ADR-0008 决定维持 `Worker.ownerId @unique`（裸列），理由是 worker-manager 的整条
控制面协议（长轮询、握手、心跳、fence）全部只用裸 `ownerId` 当 key，DB 约束放开到
复合键后协议层撑不住——两个物理进程回连时握手表会用同一个 `ownerId` 键互相覆盖。

## 决定

`Worker.ownerId` 从 `@unique`（裸列）升级为 `@@unique([ownerId, runtimeId, isolationScope])`
（复合唯一约束）。允许同一 owner 跨 runtime / 跨 isolationScope 并行多个活跃 Worker。

### 为什么现在能做

ADR-0008 的担忧仍然成立——协议层确实只用裸 `ownerId`。本次采取**分步推进**策略：

1. **Ticket 02（本 ADR）**：先破 DB 层。`@@unique([ownerId, runtimeId, isolationScope])`
   替换裸 `ownerId @unique`。`findActiveByOwnerId` 临时改用 `findFirst`（按 ownerId +
   active status 过滤），协议层仍保证同一 owner 同一时刻只有一个活跃 worker。
2. **Ticket 03（后续）**：协议层身份从 `ownerId` 改 `workerId`（= `Worker.id` 主键）。
   poll/心跳/握手/命令路由全按 workerId，ownerId 退回纯业务字段。此时复合键的语义
   完全生效——同一 owner 的多个 worker 各按 workerId 路由，不串数据。

### 为什么不一步到位

协议层改动（端点路径、Store key、Dispatcher key、worker 侧 env）牵一发动全身，
混在 DB 改动里会增加 review 难度和回滚风险。分两步让 DB 先放开（允许数据层并行），
协议再跟进（让控制面也并行），中间态可验证、可回滚。

## Consequences

- 同一 owner 可以在不同 runtime 上同时拥有活跃 Worker（如 docker + opensandbox 并行）。
- 同一 (owner, runtime, isolationScope) 仍不能重复 launch——复合唯一约束生效。
- `WorkerProvisioner.owners` Map 的复用 key 从裸 `ownerId` 改为
  `(ownerId, runtimeId, isolationScope)` 复合字符串。
- `findActiveByOwnerId` 临时使用 `findFirst`（非 `findUnique`），Ticket 03 将替换为
  `findActiveByWorkerId`。
- ADR-0008 的"一个用户同时只能有一个活跃 user-scope Worker"限制在 Ticket 03 完成后
  彻底解除。
