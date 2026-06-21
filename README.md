<div align="center">
  <img src="docs/images/agework-logo.png" alt="AgeWork Logo" width="96" />
  <h1>AgeWork ✨</h1>
  <p>
    <img src="https://img.shields.io/badge/%E6%AD%A3%E5%9C%A8%E5%BC%80%E5%8F%91%E4%B8%AD-%E6%AC%A2%E8%BF%8E%E5%85%B3%E6%B3%A8-blue?style=flat-square" alt="正在开发中，欢迎关注" />
  </p>
  <p>可本地化部署的多 Agent 工作台，把项目、会话、运行环境和模型配置放进同一个可控系统。</p>
</div>

![AgeWork 工作台截图](docs/images/agework-screenshot.png)

AgeWork 是一个可本地化部署的多 Agent 工作台。它不是单纯的聊天界面，而是把「项目工作区、Agent 会话、运行环境、模型配置、执行日志」放在同一个可控系统里，帮助你在自己的机器或服务器上使用 Claude、Codex 等 AI Agent 完成真实开发任务。

AgeWork 适合这些场景：

- 个人想把 AI 编程助手部署在自己的电脑或服务器上，数据和配置不交给第三方平台托管。
- 团队希望在内网提供统一的 Agent 工作台，让成员按项目创建会话、复用配置、追踪历史。
- 需要区分本机运行和沙箱运行的任务，例如普通代码修改走 local，高风险或隔离要求更高的任务走 sandbox。
- 想同时试用不同 Agent 能力，并把它们接入同一套项目、会话和 UI 工作流。

## ✨ 主要特性

- 🤖 多 Agent 接入：通过 adapter 接入 Claude、Codex 等 Agent。前后端使用共享协议传递消息、工具调用和运行状态，方便后续继续扩展新的 Agent。
- 🗂️ 项目化工作区：每个工作区都可以绑定目录、运行环境和会话历史。你可以围绕一个代码项目持续工作，而不是每次都从零开始描述上下文。
- 💬 会话与任务管理：Web UI 提供会话列表、工作区分组、消息流和任务输入区，适合反复创建、切换和追踪 Agent 任务。
- 🔒 本地优先的数据控制：默认使用本地 SQLite，运行数据、配置和诊断日志由当前 AgeWork 实例管理，便于个人私有部署或团队内网部署。
- 🔑 可选登录验证：开发时可以免登录快速调试；生产部署时启用登录验证，并通过首次访问页面设置固定 `admin` 管理员密码。
- 🧰 Local / Sandbox runtime：同一个服务实例可以限制允许的运行环境。普通工作区可以直接使用本机进程，高隔离任务可以使用 sandbox。
- 📦 OpenSandbox 支持：需要沙箱能力时，可以启动本地 OpenSandbox Server，并使用 AgeWork worker 镜像执行 Agent 任务。
- 🖥️ Web + API + Desktop：React Web、NestJS API、Agent Worker 与 Electron 桌面壳都在同一仓库维护，既能部署成服务，也能继续演进桌面端。

## 💡 设计思想

AgeWork 希望把 AI Agent 从「一次性的聊天工具」变成「可部署、可管理、可追踪的工作系统」。

## 🧱 技术栈

- Monorepo：pnpm workspace + Turborepo
- Web：React 19、Vite、Tailwind CSS v4、TanStack Router、TanStack Query、assistant-ui
- API：NestJS 11、Prisma、SQLite / PostgreSQL driver adapter
- Worker / Adapters：Claude Agent SDK、Codex SDK、AG-UI
- Desktop：Electron
- Test：Vitest、Playwright

## ⚙️ 环境要求

- Node.js `>=20`
- pnpm `10.33.4`
- Docker：仅在使用 sandbox、OpenSandbox 或构建 worker 镜像时需要

## 🚀 快速开始

推荐使用交互式向导：

```bash
pnpm boot
```

`pnpm boot` 会安装依赖、创建 `.env`、生成 Prisma Client、同步数据库，并按向导选择是否启动服务。

也可以使用非交互命令：

```bash
pnpm init:dev
pnpm dev
```

默认开发地址：

- Web：http://localhost:5173
- API：http://localhost:3000/api/v1

首次进入系统后，在「设置 -> Agent 配置」添加 API Key，然后回到首页创建项目即可开始使用。生产模式或手动启用登录验证时，第一次打开页面会引导你设置固定 `admin` 管理员密码。

## 🛠️ 开发模式

```bash
pnpm init:dev
pnpm dev
```

`init:dev` 默认行为：

- 安装依赖
- 从 `.env.example` 创建 `apps/api/.env` 与 `apps/web/.env`
- 生成 `AGEWORK_PRIVATE_JWT_SECRET`
- 设置 `AGEWORK_DEV_AUTH_DISABLED=true`
- 生成 Prisma Client
- 执行 `prisma db push`

常用开发命令：

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 同时启动 API 和 Web |
| `pnpm dev:api` | 只启动后端 |
| `pnpm dev:web` | 只启动前端 |
| `pnpm dev:reset` | 重置数据库并启动开发服务 |
| `pnpm kill-port <port>` | 清理指定端口 |
| `pnpm typecheck` | 全仓类型检查 |
| `pnpm --filter web typecheck` | 前端类型检查 |
| `pnpm --filter api typecheck` | 后端类型检查 |

## 初始化参数

`pnpm init:dev`、`pnpm init:prod` 和 `pnpm boot` 底层都使用 `scripts/init.mjs`。常用参数如下：

| 参数 | 说明 |
| --- | --- |
| `--no-install` | 跳过 `pnpm install` |
| `--no-auth` | 禁用登录验证，写入 `AGEWORK_DEV_AUTH_DISABLED=true` |
| `--reset` | 重写环境默认值并清空重建数据库；交互模式下有数据时可选择备份 |
| `--start` | 初始化后启动开发服务 |
| `--ctx <path>` | 设置部署子路径，例如 `/agent` |
| `--name <name>` | 设置应用名称 |
| `--port <port>` | 设置后端端口 |
| `--runtime <local\|sandbox\|local,sandbox>` | 设置允许创建的工作空间运行环境 |
| `--isolation <user\|workspace\|user,workspace>` | 设置允许创建的沙箱隔离级别 |
| `--sandbox-engine <docker\|opensandbox>` | 设置沙箱引擎 |

示例：

```bash
pnpm init:dev --name AgeWork --port 3001
pnpm init:prod --ctx /agent
pnpm init:dev --runtime local,sandbox --isolation workspace --sandbox-engine opensandbox
```

## 环境变量

初始化脚本会从模板创建：

- `apps/api/.env`
- `apps/web/.env`

通常只需要改少量配置。

### API

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `AGEWORK_PRIVATE_DATABASE_URL` | 数据库连接 | `file:./dev.db` |
| `AGEWORK_APP_NAME` | 应用名称 | `AgeWork` |
| `PORT` | 后端端口 | `3000` |
| `AGEWORK_SERVE_FRONTEND` | 是否由 API 托管前端静态资源 | `false` |
| `AGEWORK_PRIVATE_JWT_SECRET` | JWT 签名密钥 | init 自动生成 |
| `AGEWORK_DEV_AUTH_DISABLED` | 是否禁用登录验证 | dev 为 `true`，prod 为 `false` |
| `AGEWORK_CONTEXT` | 后端上下文路径，例如 `/agent` | 根路径 |
| `AGEWORK_RUNTIME_ALLOWED_TYPES` | 允许的 runtime 类型 | `local` |
| `AGEWORK_RUNTIME_ALLOWED_ISOLATION_SCOPES` | 允许的 sandbox 隔离级别 | `user` |
| `AGEWORK_SANDBOX_ENGINE` | Sandbox 引擎 | `docker` |
| `AGEWORK_DATA_DIR` | AgeWork 本机数据根目录 | `~/.agework` |

### Web

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `VITE_APP_BASE_PATH` | 前端页面、路由和静态资源路径 | 跟随 `AGEWORK_CONTEXT` |
| `VITE_APP_API_CONTEXT` | 前端请求 API 时使用的上下文路径 | 跟随 `AGEWORK_CONTEXT` |

使用 `--ctx /agent` 时，初始化脚本会同时写入 API 和 Web 配置。

## Runtime 与 Sandbox

AgeWork 的工作空间运行环境由 `AGEWORK_RUNTIME_ALLOWED_TYPES` 控制：

- `local`：在本机进程中运行 Agent。
- `sandbox`：在沙箱环境中运行 Agent。
- `local,sandbox`：创建工作空间时可选择运行环境。

Sandbox 隔离级别由 `AGEWORK_RUNTIME_ALLOWED_ISOLATION_SCOPES` 控制：

- `user`：同一用户共享沙箱资源。
- `workspace`：每个工作空间使用独立沙箱资源。
- `user,workspace`：创建工作空间时可选择隔离级别。

如果 sandbox 工作空间指定用户自定义本地目录，需要允许并选择 `workspace` 隔离。

## OpenSandbox

使用 OpenSandbox 引擎时，可以通过初始化命令一次完成配置与启动：

```bash
pnpm init:dev --runtime sandbox --sandbox-engine opensandbox
```

也可以单独管理 OpenSandbox Server：

| 命令 | 说明 |
| --- | --- |
| `pnpm opensandbox:up` | 启动本地 OpenSandbox Server，默认监听 `8080` |
| `pnpm opensandbox:down` | 停止 OpenSandbox Server |
| `pnpm opensandbox:health` | 检查健康状态 |
| `pnpm opensandbox:logs` | 查看日志 |
| `pnpm opensandbox:build` | 重建 worker 镜像并重启 OpenSandbox Server |

OpenSandbox 相关配置位于 `infra/opensandbox`。worker 镜像默认标签为 `agework/worker:latest`。

## 生产部署

初始化生产环境：

```bash
pnpm init:prod
```

构建并启动：

```bash
pnpm app:deploy
```

`pnpm app:deploy` 等价于：

```bash
pnpm build
pnpm start
```

生产启动时，根脚本会设置 `AGEWORK_SERVE_FRONTEND=true`，由 API 服务托管已经构建好的 Web 静态资源。

部署到子路径：

```bash
pnpm init:prod --ctx /agent
pnpm app:deploy
```

Nginx 示例：

```nginx
location /agent/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_buffering off;
    proxy_read_timeout 3600s;
}
```

更新部署：

```bash
git pull
pnpm init:prod
pnpm app:deploy
```

## 桌面端

`apps/desktop` 是 Electron 桌面壳，不在根 pnpm workspace 内，通过根目录的 `desktop:*` 脚本管理。

```bash
pnpm desktop:setup
pnpm desktop:dev
```

常用命令：

| 命令 | 说明 |
| --- | --- |
| `pnpm desktop:build` | 构建 Web/API 相关产物并编译桌面端 |
| `pnpm desktop:start` | 启动已编译的桌面端 |
| `pnpm desktop:dist:mac` | 打包 macOS arm64 应用 |
| `pnpm desktop:dist:win` | 打包 Windows x64 应用 |
| `pnpm desktop:typecheck` | 桌面端类型检查 |
| `pnpm desktop:test` | 桌面端测试 |
| `pnpm desktop:reset` | 重置桌面端数据库 |

## 目录结构

```text
.
├── apps
│   ├── api       # NestJS API、Prisma schema、服务端模块
│   ├── web       # React + Vite 前端
│   ├── worker    # Agent worker
│   └── desktop   # Electron 桌面壳
├── packages
│   ├── adapters  # Claude、Codex 等 Agent adapter
│   ├── shared    # 前后端共享类型、协议类型、API 类型
│   └── react-ag-ui
├── e2e           # Playwright E2E 测试
├── infra         # OpenSandbox 等基础设施配置
└── scripts       # 初始化、端口清理、worker 构建等脚本
```

## 测试与质量检查

| 命令 | 说明 |
| --- | --- |
| `pnpm typecheck` | 全仓类型检查 |
| `pnpm test:api` | 后端单测 |
| `pnpm test:web` | 前端单测 |
| `pnpm test:e2e` | E2E 测试 |
| `pnpm lint` | 全仓 lint |

## 常用命令速查

| 命令 | 说明 |
| --- | --- |
| `pnpm boot` | 交互式初始化向导 |
| `pnpm init:dev` | 开发环境初始化 |
| `pnpm init:prod` | 生产环境初始化 |
| `pnpm dev` | 启动开发服务 |
| `pnpm build` | 构建生产产物 |
| `pnpm start` | 启动已有生产构建 |
| `pnpm app:deploy` | 构建并启动生产服务 |
| `pnpm db:push` | 同步数据库 schema |
| `pnpm db:reset` | 重置数据库 |
| `pnpm db:studio` | 打开 Prisma Studio |
| `pnpm worker:build` | 构建 worker 镜像 |
| `pnpm link-skills` | 链接本地 skills |
