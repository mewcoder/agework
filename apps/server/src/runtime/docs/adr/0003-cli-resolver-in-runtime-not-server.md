# CliResolver 放 apps/runtime，server 不做 CLI 检测

CliResolver（已知位置搜索 + 版本检测 + 认证状态检查）有三个潜在消费者：apps/runtime（manager
注册时检测）、apps/server（builtin local bootstrap 时检测）、packages/worker（run 执行时 fallback）。

但 server 刻意不依赖 @agework/worker（见 `runtime/local/runtime-config.ts` 注释），只消费
agework-runtime 外部产物。把 CliResolver 放 packages/worker 会导致 server 无法 import。
放 @agework/shared 则把 OS 级检测逻辑（spawnSync、existsSync、homedir）混入纯类型/工具包。

决定：CliResolver 放 `apps/runtime/src/`。server 不做任何本机 CLI 检测——builtin local runtime
的 envConfig 也由 runtime manager 注册时上报，server 只存展示。"系统环境"可用性判断由
前端读 runtime envConfig 完成，不靠 server 进程 spawnSync。

## Consequences

- server 零 CLI 检测代码，`agent-cli-status.ts` 彻底删除。
- builtin local runtime 的 envConfig 在 server 启动后异步到达（manager 连上隧道后），此前为 null。
  前端展示"检测中"或"未连接"，不做 server 侧即时检测填补时序空洞。
- packages/worker 的 `resolveCliPaths` 保持现状（env → which/where），不引入已知位置搜索。
