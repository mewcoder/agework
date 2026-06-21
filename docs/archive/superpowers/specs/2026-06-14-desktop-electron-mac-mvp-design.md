# 桌面客户端（Electron，mac-only MVP）设计

## Context

平台目前支持**服务器部署**（团队多人，浏览器访问）。本设计目标是新增**个人用户桌面 App**形态：普通用户下载安装包双击安装，前端 + 后端都跑在本机，浏览器无关。

关键事实（已验证代码）：

- 运行时是可插拔 provider 架构（`apps/api/src/runtime/providers/`），默认 `RUNTIME_PROVIDER ?? "local"`（`apps/api/src/config/config.service.ts:111`）。
- `local` provider 直接 `fork` Node worker 子进程跑 Agent（`apps/api/src/runtime/providers/local-runtime-provider.ts:49`），不依赖 Docker。
- 后端已用 `@nestjs/serve-static` 托管前端（`SERVE_FRONTEND`，`config.service.ts:25`），桌面里复用"单进程同时提供 API + 前端"。
- Prisma 使用 driver-adapter 模式（`provider = "prisma-client"` + `@prisma/adapter-better-sqlite3`，`apps/api/src/prisma/prisma.service.ts`），生成的 client **不含 Rust query engine 二进制**，唯一需要处理的原生模块是 `better-sqlite3`。
- Claude Agent SDK / Codex SDK 通过平台专属 npm 可执行包分发 CLI 二进制（如 `@anthropic-ai/claude-agent-sdk-darwin-arm64`、`@openai/codex-darwin-arm64`），各约 190-205MB，且两个 SDK 均支持显式路径覆盖：
  - Claude: `query()` 的 `pathToClaudeCodeExecutable`
  - Codex: `CodexOptions.codexPathOverride`（`packages/adapters/src/codex/base/adapter.ts:625`）
- `DockerSandboxEngine`（`apps/api/src/runtime/providers/sandbox-engine/docker-sandbox-engine.ts`）通过 `docker run` 启动容器，默认镜像 `agework/worker:latest`（由 `apps/worker/Dockerfile` 从 monorepo 根构建，容器内是 Linux 版 claude/codex CLI，与桌面内置的 macOS 二进制无关）。

## MVP 范围

**目标平台**：仅 macOS（Apple Silicon / arm64）。

**技术选型**：Electron + electron-builder。理由：后端是重 Node + 原生模块（better-sqlite3）+ Prisma，Electron 主进程即 Node，集成成本最低；Tauri 需把 NestJS 编 sidecar，反而更折腾。

新增 `apps/desktop`（Electron 工程），不改动现有 web/api 架构。

### 范围内

1. **进程结构**：主进程 fork 已编译的 `apps/api/dist`；`SERVE_FRONTEND=true` 让后端托管 `apps/web/dist`；`RUNTIME_PROVIDER=local`（默认）。渲染进程 `BrowserWindow` 加载 `http://127.0.0.1:<动态端口>`。
2. **端口**：主进程用 `get-port`（或绑定 `0` 端口取系统分配的空闲端口）动态分配本地端口，避免与用户本机 `pnpm dev`（默认 3000）等冲突。每次启动重新分配。
3. **数据目录**：SQLite、`.env`、workspace 根目录指向 `app.getPath('userData')`。
4. **首启初始化**：主进程检测 `userData` 是否已初始化；未初始化则写默认 `.env`（`DEV_AUTH_DISABLED=true`、`DATABASE_URL` 指向 userData 内 db 文件、`PORT=<动态端口>`），再执行 `prisma db push` 建库（复用 `scripts/init.mjs` 的建库逻辑，改造为非交互、可在主进程内调用）。
5. **better-sqlite3 重编译**：`apps/desktop` 构建脚本中加入 `@electron/rebuild`，针对 darwin-arm64 + 当前 Electron 版本的 Node ABI 重编译 `better-sqlite3`。Prisma query engine 不涉及（driver-adapter 模式无该问题）。
6. **worker 打包**：不做预编译，沿用现状（`tsx` + `apps/worker` TS 源码）。`tsx` 是 `@agework/worker` 的常规依赖，随 `node_modules` 正常打包即可，无需任何特殊处理；`LocalRuntimeProvider` 代码不改。
7. **Agent CLI 内置打包**：
   - `@anthropic-ai/claude-agent-sdk-darwin-arm64` 与 `@openai/codex-darwin-arm64` 两个平台二进制包（darwin-arm64，约 1GB 合计）通过 electron-builder `extraResources` 打入 `Resources/bin/`。
   - 主进程 fork 后端时设置环境变量 `AGEWORK_CLAUDE_CLI_PATH` / `AGEWORK_CODEX_CLI_PATH` 指向 `process.resourcesPath/bin/claude` 与 `.../codex`。
   - `apps/worker/src/main.ts` 的 `createAdapter`（约第 327 行）读取这两个环境变量，分别传给 `ClaudeAgentAdapter` 的 `pathToClaudeCodeExecutable` 和 `CodexAgentAdapter` 的 `codexPathOverride`；未设置时保持现有行为（dev 模式不受影响）。
8. **Docker 隔离模式**：
   - `docker` 本身是系统依赖，不随 App 打包；主进程检测本机 Docker（`docker info`），设置页提供"容器隔离模式"开关。
   - 切换开关会将 `RUNTIME_PROVIDER` 在 `.env` 中改写为 `docker`/`local`，并**重启后端子进程**（该值仅在后端启动时读取一次）。
   - **MVP 不实现镜像自动拉取/构建**：假定 `agework/worker:latest` 已在本机存在（测试阶段手动 `docker build`/`docker load`）。若镜像不存在，切换开关后启动失败时给出提示，不做自动 `docker pull`。镜像分发机制（registry pull / 预置 tarball 等）留待后续阶段。
   - 镜像内是 Linux 版 claude/codex CLI（镜像构建时安装），与桌面内置的 macOS 二进制是两套独立资源，互不影响。
9. **进程生命周期**：
   - App 退出（quit / 全部窗口关闭）时 kill 后端子进程及其派生的 worker/容器进程。
   - 后端 stdout/stderr 重定向写入 `userData/logs/`。
   - 后端启动失败（端口冲突、初始化报错等）时展示简单错误窗口，而非空白页。
10. **macOS Gatekeeper**：不做 notarization，文档说明用户需 `xattr -cr` 或右键打开绕过提示。

### 范围外（后续阶段）

- Windows 全平台打包（原生模块/Prisma/Agent CLI 各自的 Windows 二进制）
- 自动更新（electron-updater）+ 更新分发服务
- macOS notarization、Windows 代码签名
- Intel mac（x64）支持

### Node 运行时说明

最终安装包是自包含的：Electron 内嵌特定版本 Node.js，主进程即跑在该 Node 上；`fork` 启动的 NestJS 后端子进程默认使用 Electron 自带的 Node（除非显式指定其他 `execPath`）。用户机器无需预装 Node/pnpm。`electron-rebuild` 的作用就是确保 `better-sqlite3` 编译目标是 Electron 内嵌 Node 的 ABI，而非系统 Node 的 ABI。

## 进程/数据流程

```
Electron 启动
└─ 主进程
   ├─ 1. 检查/初始化 userData（写 .env；首次执行 prisma db push）
   ├─ 2. get-port 选取本机空闲端口
   ├─ 3. fork apps/api/dist/main.js，注入环境变量：
   │      PORT=<动态端口>、SERVE_FRONTEND=true、
   │      RUNTIME_PROVIDER=local|docker（取自 .env，由设置页切换）、
   │      AGEWORK_CLAUDE_CLI_PATH / AGEWORK_CODEX_CLI_PATH = Resources/bin/...
   ├─ 4. 轮询健康检查，等待后端就绪
   └─ 5. 创建 BrowserWindow，加载 http://127.0.0.1:<动态端口>

NestJS 后端子进程（已 fork）
   ├─ serve-static 托管 apps/web/dist
   ├─ /api/v1/* 路由
   └─ AgentRunHandler → RuntimeProvider
        ├─ local: LocalRuntimeProvider → fork apps/worker（tsx + TS 源码）
        │    └─ createAdapter → ClaudeAgentAdapter/CodexAgentAdapter
        │         → pathToClaudeCodeExecutable / codexPathOverride
        │         → Resources/bin/claude|codex（macOS 二进制）
        └─ docker: DockerSandboxEngine → docker run agework/worker:latest
             └─ 容器内 worker（Linux claude/codex CLI，镜像自带）
```

设置页切换"容器隔离模式" → 改写 `.env` 中 `RUNTIME_PROVIDER` → 重启后端子进程（若 docker 模式且镜像不存在，先 `docker pull`）。

## 验证方式

- dev 模式（`electron .`）拉起，确认窗口加载到前端、能分别用 claude 和 codex 各跑一次 Agent run（验证 CLI 路径注入生效）。
- 切换容器隔离模式，确认能 `docker pull` 镜像并跑通一次对话。
- `electron-builder` 出 arm64 `.dmg`，干净用户目录下双击安装 → 首启自动建库 → 完成一次端到端对话（local + docker 各一次）。
- 确认本机 3000 端口被 `pnpm dev` 占用时，桌面 App 仍能通过动态端口正常启动。
- 确认 SQLite / workspace 数据落在 userData，卸载 App 后数据可清理。

## 工期预估

- macOS 可用版（含 local + docker 两种模式）：约 2-3 周
- Windows 全平台 + 自动更新 + 签名公证：另需 1-2 周（后续阶段）
