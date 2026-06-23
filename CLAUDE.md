# CLAUDE.md

## Monorepo 关键目录

这是 pnpm workspace + Turborepo monorepo。

- `apps/web`：前端应用，React 19 + Vite + Tailwind CSS v4。
- `apps/api`：后端服务，NestJS 11 + Prisma。
- `apps/worker`：Agent worker。
- `apps/desktop`：Electron 桌面壳；不在 workspace 内，使用根目录 `desktop:*` 脚本。
- `packages/shared`：前后端共享类型、API 类型、协议类型。
- `packages/adapters`：Claude、Codex 等 agent adapter。
- `packages/react-ag-ui`：本仓库维护的 `@assistant-ui/react-ag-ui`。
- `e2e`：Playwright 端到端测试。

## AI 常用命令

```bash
# 开发服务
pnpm dev
pnpm dev:api
pnpm dev:web

# 类型检查
pnpm typecheck
pnpm --filter web typecheck
pnpm --filter api typecheck

# 精准测试
pnpm test:api
pnpm test:web
pnpm --filter api test -- <spec-file>
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

- 新功能按 NestJS Feature Module 组织：`*.module.ts`、`*.controller.ts`、`*.service.ts`。
- `apps/api/src/app.module.ts` 只负责组合 feature module。
- Controller 处理 HTTP 输入输出，业务逻辑放 Service。
- 使用构造函数依赖注入，避免循环依赖。
- DTO、配置和外部输入要验证。
- 前后端共享结构优先放 `packages/shared`。
- Prisma 相关代码在 `apps/api/src/prisma` 和 `apps/api/prisma`。

### 模块组织与封装

- 后端模块按业务领域组织，不按数据库表；模块外只能调用该领域公开 Service 和公开类型，不穿透 Repository、helper、internal、provider、execution、events 等内部文件；Service 是该领域对外唯一入口。
- 模块依赖必须按架构定义保持单向；上层调用下层，下层不得反向注入或直接调用上层 Service；需要反向通知时用 domain event、回调端口或注册表解耦，避免 God Service 和循环依赖。
- 辅助逻辑跟着它修改/拥有的数据走：默认合并进 owner Service 的 private method；数据库读写细节进 Repository，跨边界类型进公开 `*.types.ts` 或 shared contract；禁止为了“分层好看”制造无意义层级。
- 是否抽成独立文件/目录看独立变化原因，不看行数；能起出清晰领域概念名才抽成同目录带领域名前缀的内部文件，起不出名就留在 private method；默认子目录最多一层，大领域确有稳定子能力时才加深。

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
