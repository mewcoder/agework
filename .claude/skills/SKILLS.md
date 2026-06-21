# Skills 文档

项目 `.claude/skills/` 目录下共 **30 个 skill**，按功能分为 6 大类。

## 如何使用

在 Claude Code 对话中输入斜杠命令即可触发，例如 `/nestjs-best-practices`。部分 skill 会在相关场景下自动触发（无需手动调用）。

---

## 一、assistant-ui 系列（聊天 UI 框架）

与 [assistant-ui](https://www.assistant-ui.com/) 库相关的 skill，覆盖从安装到高级定制的完整链路。

| Skill | 斜杠命令 | 说明 | 触发场景 |
|-------|---------|------|---------|
| **assistant-ui** | `/assistant-ui` | assistant-ui 架构总览与调试指南 | 从零搭建聊天 UI、连接 AI 后端、自定义消息类型、多线程应用 |
| **setup** | `/setup` | 安装与配置 assistant-ui | 执行 `npx assistant-ui init/create/add`、配置 runtime、排查安装问题 |
| **runtime** | `/runtime` | Runtime 系统与状态管理 | 使用 `useAui`/`useAuiState` 访问状态、管理 thread/message 数据 |
| **primitives** | `/primitives` | UI 原语（Thread/Composer/Message Primitive） | 自定义聊天 UI 组件底层行为 |
| **ai-elements** | `/ai-elements` | ai-elements 组件库（对话、消息、工具展示、输入框等） | 构建聊天机器人、AI 助手 UI |
| **thread-list** | `/thread-list` | 多线程管理 | 实现线程列表、线程切换、对话历史管理 |
| **tools** | `/tools` | 工具注册与工具 UI | 实现 LLM 工具、`makeAssistantToolUI` 渲染、human-in-the-loop |
| **streaming** | `/streaming` | assistant-stream 包与流式协议 | 实现流式后端、自定义流协议、调试流问题 |
| **cloud** | `/cloud` | assistant-cloud 持久化与授权 | 配置线程持久化、文件上传、认证 |
| **update** | `/update` | 升级 assistant-ui / AI SDK | 版本升级、breaking changes 迁移 |

---

## 二、Prisma 系列（数据库 ORM）

覆盖 Prisma CLI、Client API、数据库配置、升级等完整工作流。

| Skill | 斜杠命令 | 说明 | 触发场景 |
|-------|---------|------|---------|
| **prisma-cli** | `/prisma-cli` | Prisma CLI 命令参考 | `prisma init/generate/migrate/db studio` 等命令 |
| **prisma-client-api** | `/prisma-client-api` | Prisma Client API 参考 | `findMany`/`create`/`update`/`$transaction` 等查询操作 |
| **prisma-database-setup** | `/prisma-database-setup` | 数据库提供商配置指南 | 切换数据库（PostgreSQL/MySQL/SQLite/MongoDB）、配置连接字符串 |
| **prisma-postgres** | `/prisma-postgres` | Prisma Postgres 托管数据库操作 | Console 管理、`create-db` CLI、Management API/SDK |
| **prisma-postgres-setup** | `/prisma-postgres-setup` | 新建 Prisma Postgres 数据库并连接项目 | "set up a database"、"get a connection string" |
| **prisma-driver-adapter-implementation** | `/prisma-driver-adapter-implementation` | Prisma v7 Driver Adapter 实现参考 | 实现/修改 driver adapter、`SqlDriverAdapter`/`Transaction` 接口 |
| **prisma-upgrade-v7** | `/prisma-upgrade-v7` | Prisma v6 → v7 升级迁移指南 | "upgrade to prisma 7"、v7 报错修复 |

---

## 三、后端架构与最佳实践

| Skill | 斜杠命令 | 说明 | 触发场景 |
|-------|---------|------|---------|
| **nestjs-best-practices** | `/nestjs-best-practices` | NestJS 最佳实践与架构模式 | 编写模块/Controller/Service、实现认证、代码审查、性能优化、微服务 |
| **clean-ddd-hexagonal** | `/clean-ddd-hexagonal` | DDD / Clean Architecture / Hexagonal 架构 | 设计 API/微服务、领域建模、聚合根、CQRS、事件溯源、六边形架构 |
| **database-schema-designer** | `/database-schema-designer` | 数据库 Schema 设计 | "design schema"、"create tables"、"model data"、索引策略、迁移模式 |

---

## 四、前端框架与模式

| Skill | 斜杠命令 | 说明 | 触发场景 |
|-------|---------|------|---------|
| **shadcn** | `/shadcn` ⚠️ | shadcn/ui 组件管理 | 添加/搜索/调试 shadcn 组件、样式定制、组合模式。**注意：此 skill 标记为 `user-invocable: false`，通常自动触发** |
| **vercel-composition-patterns** | `/vercel-composition-patterns` | React 组合模式（Compound Components 等） | boolean props 泛滥时重构、构建灵活组件库、React 19 API 变更 |
| **vercel-react-best-practices** | `/vercel-react-best-practices` | React/Next.js 性能优化指南 | 编写新组件、数据获取、bundle 优化、重渲染优化 |
| **tanstack-query** | `/tanstack-query` | TanStack Query (React Query) v5 | 数据获取、缓存、mutation、乐观更新、无限滚动 |
| **tanstack-router** | `/tanstack-router` | TanStack Router 类型安全路由 | 文件路由、search params、数据加载、代码分割 |

---

## 五、工程化工具

| Skill | 斜杠命令 | 说明 | 触发场景 |
|-------|---------|------|---------|
| **monorepo-management** | `/monorepo-management` | Monorepo 管理（Turborepo/Nx/pnpm） | 搭建 monorepo、优化构建、共享依赖、CI/CD、版本发布 |

---

## 六、OpenSpec 工作流

OpenSpec 是一套实验性的变更管理工作流，4 个 skill 形成完整闭环。

| Skill | 斜杠命令 | 说明 | 触发场景 |
|-------|---------|------|---------|
| **openspec-explore** | `/openspec-explore` 或 `/opsx:explore` | 探索模式 — 思考伙伴 | 变更前/中需要头脑风暴、调研问题、澄清需求。**不写代码，只探索** |
| **openspec-propose** | `/openspec-propose` 或 `/opsx:propose` | 提案模式 — 一键生成完整变更方案 | 描述想构建什么，自动生成 proposal.md + design.md + tasks.md |
| **openspec-apply-change** | `/openspec-apply-change` 或 `/opsx:apply` | 实施模式 — 执行变更任务 | 开始/继续实施 OpenSpec 变更中的 task |
| **openspec-archive-change** | `/openspec-archive-change` 或 `/opsx:archive` | 归档模式 — 完结变更 | 实施完成后，归档变更记录 |

**典型工作流：** `/opsx:explore` → `/opsx:propose` → `/opsx:apply` → `/opsx:archive`

---

## 快速参考

### 按场景查找

| 你要做什么 | 用哪个 Skill |
|-----------|-------------|
| 搭建/配置 assistant-ui | `/setup` |
| 自定义聊天 UI 组件 | `/primitives` 或 `/ai-elements` |
| 实现工具调用 / human-in-the-loop | `/tools` |
| 多线程聊天 | `/thread-list` |
| 流式响应 | `/streaming` |
| 写 NestJS 代码 | `/nestjs-best-practices` |
| 设计领域模型 / 微服务架构 | `/clean-ddd-hexagonal` |
| 设计数据库表结构 | `/database-schema-designer` |
| 写 Prisma 查询 | `/prisma-client-api` |
| 跑 Prisma 命令 | `/prisma-cli` |
| 升级 Prisma v7 | `/prisma-upgrade-v7` |
| 添加 shadcn 组件 | 自动触发 `/shadcn` |
| React 组件重构 | `/vercel-composition-patterns` |
| React 性能优化 | `/vercel-react-best-practices` |
| 数据获取/缓存 | `/tanstack-query` |
| 路由配置 | `/tanstack-router` |
| Monorepo 管理 | `/monorepo-management` |
| 变更管理全流程 | `/opsx:explore` → `/opsx:propose` → `/opsx:apply` → `/opsx:archive` |
