<div align="center">
  <img src="docs/images/agework-logo.png" alt="AgeWork Logo" width="96" />
  <h1>AgeWork ✨</h1>
  <p>
    <img src="https://img.shields.io/badge/%E6%AD%A3%E5%9C%A8%E5%BC%80%E5%8F%91%E4%B8%AD-%E6%AC%A2%E8%BF%8E%E5%85%B3%E6%B3%A8-blue?style=flat-square" alt="正在开发中，欢迎关注" />
  </p>
  <p>可本地化部署的多 Agent 工作台，把项目、会话、运行环境和模型配置放进同一个可控系统。</p>
</div>

![AgeWork 工作台截图](docs/images/agework-screenshot.png)

AgeWork 是一个面向 AI 编程工作流的本地化多 Agent 工作台，支持 Claude、Codex 等 Agent。它希望把 AI Agent 从「一次性的聊天工具」变成「可部署、可管理、可追踪的工作系统」。

## AgeWork 做什么

| 方向 | 说明 |
| --- | --- |
| Agent 工作台 | 用工作区组织代码项目、会话历史、任务输入和执行记录。 |
| 多 Agent 接入 | 通过 adapter 接入 Claude、Codex 等 Agent，后续可扩展更多 Agent。 |
| 本地化控制 | 默认使用本地 SQLite，数据、配置和诊断日志由当前实例管理。 |
| 运行环境管理 | 支持 local 和 sandbox runtime，高隔离任务可接入 OpenSandbox。 |
| 多端形态 | 仓库内同时维护 Web、API、Worker 和 Electron 桌面壳。 |

## 快速开始

环境要求：

- Node.js `>=20`
- pnpm `10.33.4`
- Docker：仅在使用 sandbox、OpenSandbox 或构建 worker 镜像时需要

推荐使用交互式向导：

```bash
pnpm boot
```

也可以直接启动开发环境：

```bash
pnpm init:dev
pnpm dev
```

默认开发地址：

- Web：http://localhost:5173
- API：http://localhost:3000/api/v1

进入系统后，在「设置 -> Agent 配置」添加 API Key，然后回到首页创建项目即可开始使用。

## 开发常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 同时启动 API 和 Web |
| `pnpm dev:api` | 只启动后端 |
| `pnpm dev:web` | 只启动前端 |
| `pnpm typecheck` | 全仓类型检查 |
| `pnpm test:api` | 后端单测 |
| `pnpm test:web` | 前端单测 |
| `pnpm db:studio` | 打开 Prisma Studio |
| `pnpm kill-port <port>` | 清理指定端口 |

## 更多文档

- [使用与部署指南](docs/usage.md)：启动、开发、部署、配置、Runtime / Sandbox、桌面端。
- [系统架构图](docs/agework-system-architecture.png)

## 技术栈

- Monorepo：pnpm workspace + Turborepo
- Web：React 19、Vite、Tailwind CSS v4、assistant-ui
- API：NestJS 11、Prisma
- Worker / Adapters：Claude Agent SDK、Codex SDK、AG-UI
- Desktop：Electron
