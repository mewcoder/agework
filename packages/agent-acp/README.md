# @agework/agent-acp

AgeWork 默认随 Worker 携带的 ACP Agent Plugin，也是 `@agework/agent-sdk` 的官方
插件示例。包内包含通用 ACP Driver，以及 OpenCode、Pi 两个轻量 profile。

新增 ACP Agent 通常只需要实现 `AcpAgentProfile` 并注册到 profile registry，不需要
重新实现进程、会话、权限桥接或 AG-UI 映射。

每种 Agent 放在 `src/agents/<agent>/` 独立目录中，并由 `src/agents/registry.ts` 注册。
通用 ACP 生命周期位于 `src/engine/`，权限与 AG-UI 转换位于 `src/bridge/`。

完整使用和开发说明见 `docs/guide/acp-agent.md`。
