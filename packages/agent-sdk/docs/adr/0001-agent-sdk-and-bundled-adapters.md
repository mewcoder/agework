# ADR 0001: Agent SDK 与 bundled Agent plugins

## Decision

- `@agework/agent-sdk` 只提供稳定、轻量的 `AgentDriver` / `AgentPlugin` 契约。
- `@agework/worker` 是插件宿主，负责显式加载、注册、按 `agentType` 选择实现。
- Claude、Codex 继续聚合在 `@agework/adapters/plugin`。
- 通用 ACP Driver 与 profiles 抽到 `@agework/agent-acp`，作为官方插件示例。
- 两个官方包都由 Worker 默认注册，但和外部包使用同一 `AgentPlugin` 契约。
- 外部包导出 `createAgentPlugin()`，通过 `AGEWORK_AGENT_PLUGINS` 加载。

## Rationale

Claude/Codex 仍由同一团队、同一节奏维护，继续合包可以避免无意义离散。ACP 本身则是
可复用协议层：独立包既隔离依赖，也允许新增 Agent 只实现 profile，并能完整展示插件开发方式。

## Current limitation

插件机制目前解决执行侧扩展。控制面的 Agent 清单、模型协议矩阵和 UI 仍是显式产品配置；
新增 `agentType` 还需要在这些位置开放，后续可再用 Host capabilities 驱动动态清单。
