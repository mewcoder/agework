# AgeWork 文档索引

面向开发者的文档导航。产品定位见 [`product-positioning-and-direction.md`](product-positioning-and-direction.md)，
上手使用见 [`usage.md`](usage.md)。

## 使用与配置

| 文档 | 内容 |
|---|---|
| [usage.md](usage.md) | 安装、启动、日常使用 |
| [config.md](config.md) | 环境变量与四类配置边界 |
| [desktop-electron-commands.md](desktop-electron-commands.md) | 桌面客户端（Electron）构建/运行命令 |

## 架构参考（当前）

`architecture/` 下是与代码保持同步的技术参考。

| 文档 | 内容 |
|---|---|
| [architecture/worker-rpc-protocol.md](architecture/worker-rpc-protocol.md) | worker ↔ server 的 HTTP RPC 协议与方法清单 |
| [architecture/docker-runtime-explained.md](architecture/docker-runtime-explained.md) | Docker / OpenSandbox / worker 镜像入门讲解 |
| [architecture/rbac-matrix.md](architecture/rbac-matrix.md) | 权限归属矩阵与实现锚点 |
| [architecture/agent-event-logging-guide.md](architecture/agent-event-logging-guide.md) | Agent 事件 / 日志排查实操指南 |

> 更贴近代码的模块级决策记录（ADR）随代码就近存放，见各模块 `docs/adr/`，如
> `apps/server/src/runtime-host/docs/adr/`、`packages/runtime-sdk/docs/adr/`、`apps/runtime/docs/adr/`。
> 后端架构与命名规则见 [`.claude/rules/`](../.claude/rules/)。

## 开发指南

`guide/` 存放面向开发者的操作指南，不作为架构设计记录。

| 文档 | 内容 |
|---|---|
| [guide/README.md](guide/README.md) | 插件开发指南入口与能力边界 |
| [guide/runtime-plugin.md](guide/runtime-plugin.md) | Runtime 插件的使用、Provider 开发、安装启用与 bundled 发行流程 |
| [guide/agent-plugin.md](guide/agent-plugin.md) | Agent 插件的使用、Driver 开发、执行侧边界与动态 manifest 目标 |
| [guide/acp-agent.md](guide/acp-agent.md) | ACP Agent Profile 的环境、bridge、权限与协议验证流程 |

## 设计定案

| 文档 | 内容 |
|---|---|
| [design/server-runtime-worker-target-architecture.md](design/server-runtime-worker-target-architecture.md) | Server · Runtime Host · Worker 三层目标架构（已落地） |
| [design/runtime-owner-boundary.md](design/runtime-owner-boundary.md) | Server 业务事实与 Runtime 隔离、复用、生命周期权威边界（已落地） |

## 实验性能力

`experimental/` 存放仍可按需启用、但不属于当前主要维护方向的能力。它们默认关闭，
不承诺随主线持续验证兼容性。

| 文档 | 内容 |
|---|---|
| [experimental/opensandbox.md](experimental/opensandbox.md) | OpenSandbox provider 插件的状态、启用方式与排错说明 |
