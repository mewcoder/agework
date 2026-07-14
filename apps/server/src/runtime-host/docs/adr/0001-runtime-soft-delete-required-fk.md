# Runtime 只软删除（`removedAt`），Workspace/Worker 的 runtimeId 必填

最初设计里 `Runtime` 被删除时用 `onDelete: SetNull` 把 `Workspace.runtimeId` / `Worker.runtimeId`
置空表达"已解绑"。但 `runtimeId = null` 已经被现状代码用来表示另一件事——"Managed（本机
in-process），不查 Runtime 表"，这次改造又要给本机引入 `builtin-*` 固定行、让它也占一个
非空 `runtimeId`。同一个 null 值改造前后代表相反的语义（正常状态 vs 已失效状态），会让现状
里所有靠 `runtimeId === null` 判断 Managed 的分支在迁移后被误判。

决定：`Runtime` 不物理删除，注销只打 `removedAt` 时间戳，行永久保留；`Workspace.runtimeId` /
`Worker.runtimeId` 因此可以设计成必填（`onDelete: Restrict`），不存在"引用的 Runtime 行没了"
的情况。注销时把 `name` 打散（追加 id 后缀），腾出原名给用户重新注册同名机器，避免
`@@unique([ownerId, name])` 因为旧行还占着名字而拒绝重建。

注销一台还有活跃 Worker 的 Runtime 时，不主动停止/清理这些 Worker（放任其自然结束或被
fence 判死），因此注销也不能像现状 `RuntimeService.delete()` 那样顺手踢断隧道连接——连接
一断在线 Worker 就没法上报心跳，等同强制判死。

## Consequences

- 现状代码里 `runtimeId === null` / `Boolean(runtimeId)` 用作"是否 Managed"判断依据的地方
  （`runtime.service.ts` 的 `runtimeFor()`、`worker-manager/instance/lifecycle.handler.ts`、
  `worker-manager/instance/worker.provisioner.ts`、`workspace.service.ts`、
  `run/launch/run-launcher.ts` 等）迁移后要全部改成判断 `runtime.source === "builtin"`。
- 历史 `Workspace.runtimeId = null`（Managed）的行要先回填成对应的 `builtin-*` id，才能把列
  改成必填并删掉 `runtimeType`/`isolationScope` 快照列。
- `Runtime.list` / `getOwned` / `delete` 等 owner-scoped 查询方法要跟着改成同时覆盖
  `ownerId = 我` 和 `ownerId = null`（全局）两类行。
