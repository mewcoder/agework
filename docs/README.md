# AgeWork 文档索引

面向开发者的文档导航。产品定位见 [`product-positioning-and-direction.md`](product-positioning-and-direction.md)，
上手使用见 [`usage.md`](usage.md)。

## 使用与配置

| 文档 | 内容 |
|---|---|
| [usage.md](usage.md) | 安装、启动、日常使用 |
| [config.md](config.md) | 环境变量与四类配置边界 |
| [opensandbox-setup.md](opensandbox-setup.md) | OpenSandbox 运行时本地开发环境搭建与排查 |
| [desktop-electron-commands.md](desktop-electron-commands.md) | 桌面客户端（Electron）构建/运行命令 |

## 架构参考（当前）

`architecture/` 下是与代码保持同步的技术参考。

| 文档 | 内容 |
|---|---|
| [architecture/worker-rpc-protocol.md](architecture/worker-rpc-protocol.md) | worker ↔ server 的 HTTP RPC 协议与方法清单 |
| [architecture/docker-runtime-explained.md](architecture/docker-runtime-explained.md) | Docker / OpenSandbox / worker 镜像入门讲解 |
| [architecture/rbac-matrix.md](architecture/rbac-matrix.md) | 权限归属矩阵与实现锚点 |
| [architecture/agent-event-logging-guide.md](architecture/agent-event-logging-guide.md) | Agent 事件 / 日志排查实操指南 |
| [architecture/acp-agent-integration-guide.md](architecture/acp-agent-integration-guide.md) | 新增 ACP agent 的接入触点、权限接法与验证清单 |

> 更贴近代码的模块级决策记录（ADR）随代码就近存放，见各模块 `docs/adr/`，如
> `apps/server/src/runtime/docs/adr/`、`apps/server/src/runtime-host/docs/adr/`、
> `packages/providers/docs/adr/`、`packages/worker/docs/adr/`、`apps/runtime/docs/adr/`。
> 后端架构与命名规则见 [`.claude/rules/`](../.claude/rules/)。

## 设计定案

| 文档 | 内容 |
|---|---|
| [design/runtime-workspace-worker-schema.md](design/runtime-workspace-worker-schema.md) | Runtime / Workspace / Worker 的数据模型定案 |

## 待办与活账本

`todo/` 下是仍有效的待办与销账文档（非历史计划）。

| 文档 | 状态 |
|---|---|
| [todo/run-event-v2-big-bang-design.md](todo/run-event-v2-big-bang-design.md) | Phase A/B 已落地，仅 Phase C 特意搁置——活账本 |
| [todo/auth-security-priority-plan.md](todo/auth-security-priority-plan.md) | P0/P1 完成，剩 P2-9 审计日志、P2-10 入库密钥加密 |
| [todo/interrupt-migration-to-agui-spec.md](todo/interrupt-migration-to-agui-spec.md) | 未实现的设计稿 |
| [todo/workspace-file-preview-design.md](todo/workspace-file-preview-design.md) | 未实现的设计稿——工作空间文件树+预览（全 runtime 统一 worker 代理读） |
| [todo/workspace-diff-and-versioning-design.md](todo/workspace-diff-and-versioning-design.md) | 未实现的设计稿——工作空间 diff+版本管理（第二阶段，依赖文件预览一期通道） |
| [todo/nestjs-techniques-priority-plan.md](todo/nestjs-techniques-priority-plan.md) | 含真实未落地 P0（持久化队列、任务调度、启动期 env 校验） |
| [todo/nestjs-fundamentals-priority-plan.md](todo/nestjs-fundamentals-priority-plan.md) | NestJS 能力菜单式参考/决策记录 |
| [todo/nestjs-overview-priority-plan.md](todo/nestjs-overview-priority-plan.md) | 请求生命周期约定与决策记录 |

## 研究与借鉴

`research/` 下是外部协议研究与标杆项目借鉴。

| 文档 | 内容 |
|---|---|
| [research/acp-migration-feasibility.md](research/acp-migration-feasibility.md) | ACP 迁移可行性（结论：保留 AG-UI，ACP 作广度层并存） |
| [research/ag-ui.md](research/ag-ui.md) | AG-UI 协议 / 包结构 / EventType 速查 |
| [research/codeg-and-aionui-inspiration.md](research/codeg-and-aionui-inspiration.md) | codeg × AionUi 联合架构启示 |
| [research/openhands-architecture-deep-analysis.md](research/openhands-architecture-deep-analysis.md) | OpenHands 源码架构剖析 |
| [research/openhands-upgrade-priority-roadmap.md](research/openhands-upgrade-priority-roadmap.md) | 借鉴 OpenHands 的升级优先级路线 |
| [research/queue-send-immediately-research.md](research/queue-send-immediately-research.md) | 运行中"立即发送"能力研究 |

## 归档

[`archive/`](archive/) 存放已被取代或已落地的历史设计、评审与计划（含 `archive/superpowers/`
的过程产物）。仅作历史追溯，不代表当前实现。
