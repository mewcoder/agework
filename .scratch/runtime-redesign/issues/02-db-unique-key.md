# 02 — DB 防重 key:Worker.ownerId @unique → 复合 @@unique

- Type: task
- Status: pending
- Blocked by: 01

## 目标

破 wm-0003 的 DB 层:`Worker.ownerId @unique`(裸)→ `(ownerId, runtimeId, isolationScope) @@unique`,允许同一 owner 跨 workspace/跨机器并行多个 worker。

## 依据

- design.md §3.3(破 wm-0003)、§7(数据模型)
- wm-0003 ADR(推翻):原文警告「协议整条链用裸 ownerId」——本 ticket 只改 DB 层,协议层在 03 改

## 范围

- `apps/server/prisma/schema.prisma:227-259`(Worker model):
  - 删 `ownerId String @unique`(:237)
  - 加 `@@unique([ownerId, runtimeId, isolationScope])`
  - 更新 :232-236 的注释(原注释解释「为什么维持裸 ownerId」,改为「为什么升级成复合」)
- `apps/server/src/worker-manager/registry/worker-registry.repository.ts` —— insertStarting/upsertRunning 的唯一冲突判断,从按 ownerId 改按复合 key
- `apps/server/src/worker-manager/instance/worker.provisioner.ts:50-63` —— `owners` Map 复用 key 从 `ownerId` 改 `(ownerId, runtimeId, isolationScope)`(注:协议身份改 workerId 在 03,这里先改复用缓存 key)
- 对应 spec

## 不做

- 不改协议层(端点/Store/Dispatcher 的 key)——那是 03
- 不改 WorkerWorkspaceBinding(workspaceId @unique 保留,不引入 isolationMode)
- 不改 Runtime 表

## 验收

1. `pnpm db:push` 成功,migration 生成
2. `pnpm --filter server typecheck` + `pnpm test:server` 过
3. 手工:同一 owner 在两个不同 workspace 能同时起 worker(之前会冲突,现在不冲突)
4. 同一 (owner, runtime, isolationScope) 仍不能重复 launch(复合唯一约束生效)

## 依赖

01(用新字段值命名)
