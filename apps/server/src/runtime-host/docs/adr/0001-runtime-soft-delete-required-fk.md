# Runtime Host 只软删除，`Workspace.runtimeHostId` 必填

最初设计用 `Runtime` 表示执行节点，并允许 `Workspace.runtimeId = null` 表示 builtin 执行。这样同一个
`null` 同时可能表示「使用本机」和「原节点已删除」，无法区分正常 placement 与失效引用。

决定：执行节点统一建模为 `RuntimeHost`。builtin Host 也有固定 id `"builtin"`，因此
`Workspace.runtimeHostId` 必填，并通过 `onDelete: Restrict` 保持引用完整性。注销 registered Host 时
不物理删除，只写 `removedAt`；行永久保留，已有 workspace 的 placement 仍可解释。注销时把 `name`
追加 id 后缀，释放原名供用户重新配对同名机器。

注销一台仍有活跃 Worker 的 Runtime Host 时，不主动停止 Worker，也不踢断在线隧道。断开隧道会让
仍在运行的 Worker 无法回流事件，等同于强制判死；注销只阻止后续绑定和重新连接，现场资源由正常
生命周期或 fence 收尾。

## Consequences

- 判断 builtin / registered 只能看 `RuntimeHost.source` 或固定 Host id，不能用 nullable 外键推断。
- Workspace 始终持有可解释的 `runtimeHostId`；`runtimeType` 另存为该 Host 上的执行环境形态快照。
- owner-scoped 查询同时覆盖当前用户的 registered Host 与 `ownerId = null` 的全局 builtin Host。
- Worker 是 Host 内部现场，不再通过 server 数据库外键表达其所在节点。
