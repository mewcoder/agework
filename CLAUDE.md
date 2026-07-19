# CLAUDE.md

## Monorepo 关键目录

这是 pnpm workspace + Turborepo monorepo。

- `apps/web`：前端应用，React 19 + Vite + Tailwind CSS v4。
- `apps/server`：后端服务，NestJS 11 + Prisma。
- `packages/worker`：Agent worker。
- `apps/desktop`：Electron 桌面壳；不在 workspace 内，使用根目录 `desktop:*` 脚本。
- `packages/shared`：前后端共享类型、API 类型、协议类型。
- `packages/adapters`：Claude、Codex 等 agent adapter。
- `packages/agent-sdk`：Agent Adapter 插件的公共轻量契约。
- `packages/agent-acp`：官方 ACP Agent 插件与 profile 扩展示例。
- `packages/runtime-docker`：官方 Docker Runtime 插件与 Runtime Provider 示例。
- `packages/react-ag-ui`：本仓库维护的 `@assistant-ui/react-ag-ui`。
- `e2e`：Playwright 端到端测试。

## AI 常用命令

```bash
# 开发服务
pnpm dev
pnpm dev:server
pnpm dev:web

# 类型检查
pnpm typecheck
pnpm --filter web typecheck
pnpm --filter server typecheck

# 精准测试
pnpm test:server
pnpm test:web
pnpm --filter server test -- <spec-file>
pnpm --filter web test -- <test-file>

# 数据库
pnpm db:push
pnpm db:studio

# 工具
pnpm kill-port 3000
```

## 前端约定

- 组件库使用 shadcn/ui，组件源码在 `apps/web/src/components/ui`。
- 业务组件放在 `apps/web/src/components`。
- 通过 `@/components/ui/<name>` 引入 shadcn/ui 组件。
- 不要手写替代已有的 Button、Dialog、Sheet、Select、Table、Tabs、Badge、Skeleton、Separator 等。
- 图标使用 `lucide-react`。
- 样式使用 Tailwind CSS v4 和语义 token，例如 `bg-background`、`text-foreground`、`text-muted-foreground`、`bg-primary`、`text-destructive`。
- 条件 class 使用 `cn()`，从 `@/lib/utils` 引入。
- 表单优先使用 React Hook Form + shadcn Field。

添加组件：

```bash
pnpm dlx shadcn@latest add <component> -c apps/web
pnpm dlx --package=shadcn@latest --package=zod@3.25.76 shadcn add https://elements.ai-sdk.dev/api/registry/<component>.json -c apps/web
```

## 后端约定

> 后端模块架构**完整规范**见 [`.claude/rules/backend-architecture.md`](.claude/rules/backend-architecture.md)（权威详版：文件骨架、模块边界、依赖与事件纪律、数据访问、「不要做」清单等）。以下为要点摘要。
> 后端命名、API URL / 接口动作命名见 [`.claude/rules/backend-naming.md`](.claude/rules/backend-naming.md)。

- 新功能按 NestJS Feature Module 组织：`*.module.ts`、`*.controller.ts`、`*.service.ts`。
- `apps/server/src/app.module.ts` 只负责组合 feature module。
- Controller 处理 HTTP 输入输出，业务逻辑放 Service。
- 使用构造函数依赖注入，避免循环依赖。
- DTO、配置和外部输入要验证。
- 前后端共享结构优先放 `packages/shared`。
- Prisma 相关代码在 `apps/server/src/prisma` 和 `apps/server/prisma`。

### 模块组织与封装

- 要点：模块按业务领域组织、Service 是领域唯一对外入口、依赖单向、辅助逻辑跟数据走、不为分层造层级。
- **完整规则(模块边界、依赖与事件纪律、文件骨架、子文件夹 vs 平级 module、「不要做」清单)见 [`.claude/rules/backend-architecture.md`](.claude/rules/backend-architecture.md)。**

## 测试约定

- 前后端单测统一用 Vitest。
- 后端测试命名 `*.spec.ts`，通常放在对应 feature 目录。
- 前端测试命名 `*.test.ts` 或 `*.test.tsx`，通常靠近被测文件。
- 改 `shared`、`adapters`、`runtime`、消息聚合等共享逻辑时，优先补精准单测。
- E2E 只有用户明确要求时再运行。

## 环境路径

- 后端默认端口来自 `PORT`，未配置时为 `3000`。
- 前端 Vite dev server 默认 `5173`。
- API 固定路径段为 `/api/v1`。

## 参考文档

- assistant-ui：https://www.assistant-ui.com/llms-full.txt
- AG-UI：https://docs.ag-ui.com/llms-full.txt
- shadcn: https://ui.shadcn.com/llms.txt
- base-ui: https://base-ui.com/llms.txt

## Agent skills

### Issue tracker

Issues live as local markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles using default label strings. See `docs/agents/triage-labels.md`.

### Domain docs

Multi-context layout (per-context `docs/adr/`, indexed by `CONTEXT-MAP.md`). See `docs/agents/domain.md`.
