<div align="center">
  <img src="docs/images/agework-logo.png" alt="AgeWork Logo" width="96" />
  <h1>AgeWork</h1>
  <p><strong>Local-first, self-hosted AI Agent workbench for real development workflows.</strong></p>
  <p>把 Claude、Codex 等 AI Agent 放进一个可部署、可管理、可追踪的工作系统。</p>
  <p>
    <img src="https://img.shields.io/badge/status-active%20development-blue?style=flat-square" alt="Active development" />
    <img src="https://img.shields.io/badge/node-%3E%3D22-43853d?style=flat-square" alt="Node.js >=22" />
    <img src="https://img.shields.io/badge/pnpm-10.33.4-f69220?style=flat-square" alt="pnpm 10.33.4" />
    <img src="https://img.shields.io/badge/monorepo-Turborepo-000000?style=flat-square" alt="Turborepo" />
  </p>
</div>

![AgeWork 工作台截图](docs/images/agework-screenshot.png)

## What is AgeWork?

AgeWork 是一个面向 AI 编程工作流的本地化多 Agent 工作台。它不是单纯的聊天界面，也不是把多个 Agent 简单聚合到一个面板里，而是把 **项目工作区、Agent 会话、运行环境、模型配置、执行日志和历史记录** 放进同一个可控系统。

你可以把它理解为：

> 一个开源、可私有化部署、可扩展的 Agent Workbench / Agent Control Plane。

AgeWork 当前重点服务两类场景：

- **个人开发者**：在自己的电脑或服务器上运行 AI Agent，统一管理项目、会话、配置和执行记录。
- **团队和组织**：在内网或私有环境中部署统一的 Agent 工作台，沉淀 workspace、run history、审计日志和团队配置。

## Why AgeWork?

AI 编程工具正在从「聊天助手」变成「能执行任务的 Agent」。但在真实开发场景里，仅有聊天窗口通常不够：

- 项目上下文需要被持续管理，而不是每次重新描述。
- Agent 执行过程需要可追踪、可中断、可恢复。
- 代码、密钥、运行环境和日志需要留在自己的机器、内网或私有云。
- 团队需要统一配置模型、权限、运行策略和审计记录。
- 不同 Agent 的能力需要接入同一套 workspace、UI 和事件协议。

AgeWork 的目标就是把这些能力组织成一个可以长期运行的工作系统。

## Features

| 能力 | 说明 |
| --- | --- |
| 多 Agent 接入 | 内置 Claude、Codex adapter，并可通过 ACP 协议接入 OpenCode、pi 等 Agent，统一转换为前后端可消费的 AG-UI 事件流。 |
| 插件体系 | Agent 与 Runtime 均按插件扩展：`agent-sdk` / `runtime-sdk` 定义契约，ACP Agent、Docker Runtime 以官方插件交付。 |
| 项目化工作区 | 以 workspace 组织代码目录、会话历史、任务输入和执行记录。 |
| 会话与运行历史 | 保留 conversation、run history、工具调用、状态变化和诊断信息，支持中断、恢复与审计事件查询。 |
| Native / Docker Runtime | 同一套执行链路支持本机直跑，也可切换 Docker 沙箱隔离执行；OpenSandbox 作为实验性插件按需启用。 |
| 本地优先数据控制 | 默认使用本地 SQLite，数据、配置和日志由当前 AgeWork 实例管理。 |
| 可选登录验证 | 开发模式可免登录；生产部署默认启用登录验证，并在首次访问时设置固定 `admin` 管理员密码。 |
| Web + API + Runtime + Desktop | 同一仓库维护 React Web、NestJS API、Runtime（Host + Worker）和 Electron 桌面壳。 |

## Quick start

### Requirements

- Node.js `>=22.18`
- pnpm `10.33.4`
- Docker：仅在使用 Docker Runtime 或构建 worker 镜像时需要

### Start with the interactive guide

```bash
pnpm boot
```

### Or start manually

```bash
pnpm init:dev
pnpm dev
```

默认开发地址：

- Web: http://localhost:5173
- API: http://localhost:3000/api/v1

进入系统后，在「设置 -> Agent 配置」添加 Claude、Codex 等 Agent 所需的 API Key，然后回到首页创建项目即可开始使用。

> 生产模式或手动启用登录验证时，第一次打开页面会引导你设置固定 `admin` 管理员密码。

## Common commands

| 命令 | 说明 |
| --- | --- |
| `pnpm boot` | 交互式初始化向导 |
| `pnpm init:dev` / `pnpm init:prod` | 初始化开发 / 生产环境 |
| `pnpm dev` | 同时启动 API 和 Web |
| `pnpm dev:server` / `pnpm dev:web` | 只启动后端 / 前端 |
| `pnpm typecheck` | 全仓类型检查 |
| `pnpm lint` | 全仓 ESLint |
| `pnpm test:server` / `pnpm test:web` | 后端 / 前端单元测试 |
| `pnpm db:push` | 同步数据库 schema |
| `pnpm db:studio` | 打开 Prisma Studio |
| `pnpm build` | 构建全部产物 |
| `pnpm app:deploy` | 构建并启动生产服务 |
| `pnpm kill-port <port>` | 清理指定端口 |

## Architecture

AgeWork 采用 monorepo 组织，核心链路是 Server → Runtime Host → Worker 三层：

```text
Web UI
  -> API Server
    -> Runtime Host (native / docker / sandbox provider)
      -> Worker (per-run Runner)
        -> Agent Adapter
          -> Claude / Codex / ACP Agents
```

其中：

- **Web UI**：工作区、会话、任务输入、消息流和管理后台。
- **API Server**（`apps/server`）：用户与鉴权、workspace、conversation、run、模型 Provider 配置和事件聚合；通过 `runtime-host` 模块统一管理本机内置与远程注册的 Runtime Host。
- **Runtime Host**（`apps/runtime`）：一台执行机上的运行环境权威，按 Runtime 插件（native / docker / opensandbox）供给执行载体，管理 Worker 生命周期与复用。
- **Worker / Runner**：常驻 Worker 进程按 run 派生 Runner，负责启动 Agent adapter、转发命令、回传事件和运行状态。
- **Agent Adapter**（`packages/adapters`、`packages/agent-acp`）：把 Claude Agent SDK、Codex app-server、ACP 等不同协议统一转换为 AgeWork 的 AG-UI 事件流。

## Tech stack

- Monorepo: pnpm workspace + Turborepo
- Web: React 19, Vite, Tailwind CSS v4, TanStack Router, TanStack Query, assistant-ui
- API: NestJS 11, Prisma, SQLite / PostgreSQL driver adapter
- Runtime / Adapters: Claude Agent SDK, Codex app-server (JSON-RPC), ACP (Agent Client Protocol), AG-UI
- Desktop: Electron
- Test: Vitest, Playwright

## Repository structure

```text
.
├── apps
│   ├── server              # NestJS API、Prisma schema、服务端模块
│   ├── runtime             # @agework/runtime：Runtime Host + Worker / Runner
│   ├── web                 # React + Vite 前端
│   └── desktop             # Electron 桌面壳（不在 pnpm workspace 内）
├── packages
│   ├── shared              # 前后端共享类型、协议类型、API 类型
│   ├── adapters            # Claude、Codex 等内置 Agent adapter
│   ├── agent-sdk           # Agent Adapter 插件的公共轻量契约
│   ├── agent-acp           # 官方 ACP Agent 插件（OpenCode、pi 等接入）
│   ├── runtime-sdk         # Runtime 插件公共 SDK
│   ├── runtime-docker      # 官方 Docker Runtime 插件
│   ├── runtime-opensandbox # 实验性 OpenSandbox Runtime 插件
│   └── react-ag-ui         # @assistant-ui/react-ag-ui，AG-UI 适配层
├── e2e                     # Playwright E2E 测试
├── infra                   # 可选运行时等基础设施配置
├── docs                    # 项目文档（入口 docs/README.md）
└── scripts                 # 初始化、端口清理、worker 构建等脚本
```

## Documentation

完整索引见 [docs/README.md](docs/README.md)。常用入口：

- [使用与部署指南](docs/usage.md)：安装、启动、开发、部署与日常使用。
- [配置管理](docs/config.md)：环境变量与配置边界、模型 Provider 配置。
- [插件开发指南](docs/guide/README.md)：Runtime 插件、Agent 插件与 ACP Agent Profile 的开发与接入。
- [架构参考](docs/README.md#架构参考当前)：worker RPC 协议、Docker Runtime、权限矩阵、事件与日志排查。
- [产品定位与方向](docs/product-positioning-and-direction.md)：AgeWork 的定位、边界和阶段性路线。

OpenSandbox provider 以独立插件包作为按需启用、非主要维护方向的实验能力保留，见
[实验性 OpenSandbox](docs/experimental/opensandbox.md)。

## Roadmap

AgeWork 仍处于快速开发阶段。当前优先级：

- 稳定 local workspace、conversation、run history 和事件流体验。
- 打磨 Claude / Codex 等核心 Agent 的深度接入，而不是浅层堆叠大量 Agent。
- 稳定面向个人与团队部署的 Native / Docker runtime 和 worker 镜像构建链路。
- 强化团队部署所需的权限、审计、配置治理和 API-first 能力。
- 持续演进 Web、API、Runtime、Desktop 的统一部署体验。

## Contributing

AgeWork 还在早期阶段，欢迎通过 Issue / Discussion 参与：

- 反馈安装、启动、部署问题。
- 提出新的 Agent adapter 或 runtime 需求。
- 讨论 workspace、sandbox、权限、审计、团队协作等产品设计。
- 提交文档、测试、bugfix 或小型功能 PR。

在提交较大的功能前，建议先开 Issue 讨论设计边界，避免和当前架构方向冲突。

## Status

AgeWork is under active development. APIs, runtime abstractions and deployment scripts may change before a stable release.
