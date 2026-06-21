# Worker Docker 镜像打包改造设计

## 背景

`apps/worker/Dockerfile` 当前在构建阶段对整个 monorepo 执行 `pnpm install --frozen-lockfile`，
会装下所有 workspace（包括 `apps/api`）的依赖，其中 `better-sqlite3` 在 `node:22-slim` 上
需要本地编译，因缺少 Python/编译工具而构建失败。最终镜像也直接用 `tsx` 跑 TS 源码，
体积较大、启动较慢。

`RUNTIME_PROVIDER=opensandbox`（见 `docs/opensandbox-setup.md`）会频繁用这个镜像创建
sandbox 容器，镜像体积和启动速度直接影响 sandbox 创建速度。

目标：

1. worker 的 Docker 镜像改为打包后的 JS（不含 TS 源码、不含 `tsx`），消除当前的构建报错。
2. 缩小最终镜像体积、加快 sandbox 容器创建速度。
3. 不影响 `RUNTIME_PROVIDER=local` 模式（`apps/api/src/runtime/providers/local-runtime-provider.ts`
   通过 `tsx` 直接运行 `apps/worker/src/main.ts` TS 源码，桌面客户端场景使用）。

## 关键约束

- `@anthropic-ai/claude-agent-sdk`（`.mjs` only，自带二进制/资源文件）和
  `@openai/codex-sdk`（自带 `node_modules`，含可执行文件，被 `codex/base/adapter.ts` 通过
  `await import("@openai/codex-sdk")` 动态加载）都是"进程型" SDK，依赖自身在
  `node_modules` 中的真实文件结构，**不能被打包进单文件**，必须保留为真实 `node_modules` 包。
- `packages/adapters` 中仅以普通类方式使用 `@nestjs/common` 的 `Logger`（无装饰器元数据），
  可以安全内联进 bundle。
- 两个 SDK 均为 ESM-only，bundle 输出格式必须是 ESM，避免 CJS `require()` ESM-only 包的
  兼容性问题。

## 设计

### 1. `apps/worker` 新增打包脚本

`apps/worker/package.json`：

- `devDependencies` 新增 `esbuild`。
- 新增脚本：
  ```json
  "build": "esbuild src/main.ts --bundle --platform=node --target=node22 --format=esm --outfile=dist/main.js --external:@anthropic-ai/claude-agent-sdk --external:@openai/codex-sdk"
  ```
- 现有 `dependencies`（包括 `tsx`、`@agework/shared`、`@agework/adapters`、`rxjs`）**保持不变**。
  `local-runtime-provider.ts` 通过 `require.resolve("@agework/worker")` +
  `require.resolve("tsx/cli")` 直接运行 `src/main.ts`，这条路径不依赖本次改动。

`esbuild` 会把 `src/main.ts`、`@agework/shared`、`@agework/adapters` 源码以及 rxjs、zod、
`@ag-ui/*`、`@nestjs/common` 等纯 JS 依赖全部内联进 `dist/main.js`（ESM），仅
`@anthropic-ai/claude-agent-sdk` 和 `@openai/codex-sdk` 保留为 `import`/动态 `import()`，
运行时从 `node_modules` 解析。

`turbo.json` 的 `build` task（`dependsOn: ["^build"]`，`outputs: ["dist/**"]`）会自动捡到
这个新脚本，无需改动 `turbo.json`。`packages/shared`、`packages/adapters` 没有 `build`
脚本，esbuild 直接从其 TS 源码打包，turbo 对它们的 `^build` 是空操作。

### 2. 新增 `apps/worker/package.docker.json`

静态文件，提交到仓库，列出最终镜像运行时需要的真实 `node_modules` 依赖：

```json
{
  "name": "agework-worker-runtime",
  "private": true,
  "type": "module",
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.3.158",
    "@openai/codex-sdk": "^0.135.0"
  }
}
```

版本号需要和根 `package.json` / `packages/adapters/package.json` 中两个 SDK 的版本号保持
一致，手动维护（不引入额外校验脚本）。

### 3. `apps/worker/Dockerfile` 重写为两段

```dockerfile
# Build context must be the monorepo root:
#   docker build -t agework/worker:latest -f apps/worker/Dockerfile .

FROM node:22-slim AS builder
WORKDIR /repo
RUN corepack enable pnpm
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @agework/worker build

FROM node:22-slim
WORKDIR /app
RUN corepack enable pnpm

COPY apps/worker/package.docker.json ./package.json
RUN pnpm install --prod
COPY --from=builder /repo/apps/worker/dist/main.js ./dist/main.js

# Claude CLI 拒绝在 root/sudo 下使用 bypassPermissions，
# 所以创建非 root 用户运行 worker。
RUN groupadd -r agent && useradd -r -g agent -d /home/agent -s /sbin/nologin agent \
    && mkdir -p /home/agent && chown agent:agent /home/agent /app
USER agent
ENV HOME=/home/agent

CMD ["node", "dist/main.js"]
```

最终镜像只包含两个 SDK 的 `node_modules`（及其自带的子依赖/二进制）+ `dist/main.js`，
不再包含整个 monorepo、TS 源码、`tsx`、`better-sqlite3`。

`scripts/opensandbox.mjs` / `scripts/init.mjs` 中构建命令
（`docker build -t agework/worker:latest -f apps/worker/Dockerfile .`）和镜像 tag 不变，
无需修改这两个脚本。

## 范围之外

- 不改动 `apps/api/src/runtime/providers/local-runtime-provider.ts` 及 local 模式行为。
- 不改动 `scripts/opensandbox.mjs`、`scripts/init.mjs`、`infra/opensandbox/`。
- 不引入针对 `package.docker.json` 版本号的自动同步/校验机制。
- 最终镜像 `pnpm install --prod` 不使用 lockfile 锁定两个 SDK 的间接依赖版本
  （接受的 tradeoff，后续如需可单独引入专用 lockfile）。

## 测试 / 验证计划

- `pnpm --filter @agework/worker build` 本地跑通，产出 `apps/worker/dist/main.js`。
- `docker build -t agework/worker:latest -f apps/worker/Dockerfile .` 成功构建，
  对比改造前后镜像体积。
- 启动一个使用该镜像的容器，运行 `node dist/main.js`，分别触发一次 Claude adapter 和
  Codex adapter 的真实 agent run，验证打包后两个 SDK 子进程调用正常。
- `pnpm opensandbox:up` / `pnpm opensandbox:rebuild` 全流程跑通。
- `pnpm typecheck` / `pnpm test:api`（worker 相关单测，如有）不受影响。
