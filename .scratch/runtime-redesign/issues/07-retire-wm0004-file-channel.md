# 07 — wm-0004 文件通道退役

- Type: task
- Status: pending
- Blocked by: 05

## 目标

registered/docker 文件能力已改走隧道 RPC(05),wm-0004 的 worker 独立 owner-scoped 文件通道退役:移除 WorkspaceFileCommandStore / sendFileCommand / waitForFileCommandResult / ensureWorkerForFilePreview。

## 依据

- design.md §5.2(机器级能力统一走隧道 RPC)、§5.4(推翻 wm-0004 后投递语义)、§8(模块边界)
- wm-0004 部分推翻:文件能力改隧道 RPC,run 命令通道保留

## 范围

**移除组件**:
- `apps/server/src/worker-manager/connection/workspace-file-command.store.ts` —— 删
- `apps/server/src/worker-manager/connection/workspace-file-command.controller.ts` —— 删(文件结果端点)
- `apps/server/src/worker-manager/worker-manager.service.ts:144-166` —— sendFileCommand/waitForFileCommandResult/cancelFileCommand/resolveFileCommandResult 删
- `apps/server/src/worker-manager/instance/worker.provisioner.ts:199-272`(ensureWorkerForFilePreview)—— 删(文件预览不再需要拉起 worker)
- `packages/worker/src/files/workspace-file-command.handler.ts` —— 删(worker 不再处理文件命令)

**协议类型**:
- `packages/shared/src/protocol/workspace-file-command.ts` —— WorkspaceFileCommandPayload/OwnerCommand 文件分支移除(OwnerCommand 联合类型如果只剩这一种,整个删;如果还有别的,保留联合)
- `packages/shared/src/protocol/run-channel-message.ts` —— RunChannelMessage | OwnerCommand 联合里去掉文件 OwnerCommand

**调用方改路**:
- `apps/server/src/workspace/workspace.service.ts` —— 文件预览从「ensureWorkerForFilePreview + sendFileCommand」改为「RuntimeService.listFiles/readFile」(06 已让 RuntimeService 按 source 路由:native 直读 / 其余隧道 RPC)

**保留**:
- 数据面 run 命令通道(cancel/interrupt/approval/user_message)—— 不动,身份已是 workerId(03)
- seq/expiresAt 语义 —— run 命令通道仍用(身份改 workerId,owner 级 seq 改 worker 级 seq)

## 不做

- 不删 run 命令通道(只删文件通道)
- 不改 native 文件预览(走进程内,不经这些组件)
- 不定写操作幂等(§10 未决,discard_file_change 留后续)

## 验收

1. `pnpm typecheck` + `pnpm test:server` + `pnpm --filter worker test` 过
2. registered/docker 文件预览走隧道 RPC(05),不拉起 worker
3. native 文件预览走进程内直读(06)
4. grep 确认 sendFileCommand/waitForFileCommandResult/ensureWorkerForFilePreview 无残留调用
5. run 命令通道(cancel/interrupt)仍工作

## 依赖

05(隧道 RPC 文件能力就位,才能拆 worker 代理通道)
