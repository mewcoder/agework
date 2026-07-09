# 03 — 协议身份:ownerId → workerId

- Type: task
- Status: pending
- Blocked by: 02

## 目标

协议层身份从裸 `ownerId` 改 `workerId`(= `Worker.id` 主键)。poll/心跳/握手/命令路由全按 workerId。ownerId 退回纯业务字段。

## 依据

- design.md §5.3(协议身份 workerId)、§5.4(改动清单)
- wm-0003 推翻的协议层部分

## 范围

**端点路径**:
- `apps/server/src/worker-manager/command.controller.ts` + `worker-run.controller.ts` —— `/worker/owners/:ownerId/commands` → `/worker/:workerId/commands`(或保留 ownerId 路径但加 workerId,见 design.md §5.4,推荐直接改 workerId)
- `apps/server/src/worker-manager/connection/workspace-file-command.controller.ts` —— 文件结果端点(注:文件通道在 07 退役,这里先改 key)

**Store / Dispatcher**(key 全改 workerId):
- `apps/server/src/worker-manager/connection/worker-liveness.store.ts` —— `Map<ownerId, lastSeen>` → `Map<workerId, lastSeen>`
- `apps/server/src/worker-manager/connection/worker-handshake.store.ts` —— `Map<ownerId, PendingHandshake>` → `Map<workerId, PendingHandshake>`
- `apps/server/src/worker-manager/connection/command-dispatcher.ts` + `command-queue.ts` —— sendCommand/poll 按 workerId
- `apps/server/src/worker-manager/instance/owner-run.store.ts` —— `runId → ownerId` → `runId → workerId`(+ 可反查 ownerId)
- `apps/server/src/worker-manager/worker-manager.service.ts` —— pollCommands/registerWorker/sendCommand 等签名

**worker 侧**:
- `packages/worker/src/transport/worker-http.ts` —— poll/register 携带 workerId
- `packages/worker/src/worker.ts` —— 读 env `AGEWORK_WORKER_ID`
- `apps/server/src/worker-manager/instance/worker.provisioner.ts:314-343`(buildWorkerEnv)—— env 注入 `AGEWORK_WORKER_ID`(launch 时预生成 workerId = Worker.id),保留 `AGEWORK_WORKER_OWNER_ID` 作业务字段

**workerId 来源**:provisioner launch 时 `randomUUID()` 写入 `Worker.id`(现状 :82 已传 uuid 给 insertStarting,确认它就是 Worker.id),worker 回连时携带。

## 不做

- 不改 managed 容器起进程(04)
- 不改文件能力通道(07)
- 不改复用缓存 key(02 已改)

## 验收

1. `pnpm typecheck` + `pnpm test:server` + `pnpm --filter worker test` 过
2. worker 回连用 workerId,poll/心跳/握手按 workerId 路由
3. 同一 owner 多个 worker(02 已放开)的命令不串(各按 workerId 路由)
4. fence 判死按 workerId

## 依赖

02(DB 已放开复合 key)
