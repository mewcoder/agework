# AgeWork 使用与部署指南

这份文档承接 README 中不展开的内容，按使用路径组织：先启动，再开发，再部署；配置、Runtime、桌面端和参考信息放在后面。

## 1. 启动项目

交互式初始化：

```bash
pnpm boot
```

开发环境初始化：

```bash
pnpm init:dev
pnpm dev
```

生产环境初始化：

```bash
pnpm init:prod
```

`init:dev` 默认会安装依赖、创建 `.env`、生成 `AGEWORK_PRIVATE_JWT_SECRET`、生成 Prisma Client，并执行 `prisma db push`。

## 2. 开发

常用命令：

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 同时启动 API 和 Web |
| `pnpm dev:api` | 只启动后端 |
| `pnpm dev:web` | 只启动前端 |
| `pnpm typecheck` | 全仓类型检查 |
| `pnpm test:api` | 后端单测 |
| `pnpm test:web` | 前端单测 |
| `pnpm db:push` | 同步数据库 schema |
| `pnpm db:reset` | 重置数据库 |
| `pnpm db:studio` | 打开 Prisma Studio |
| `pnpm kill-port <port>` | 清理指定端口 |

默认开发地址：

- Web：http://localhost:5173
- API：http://localhost:3000/api/v1

## 3. 生产部署

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

## 4. 初始化参数

`pnpm init:dev`、`pnpm init:prod` 和 `pnpm boot` 底层都使用 `scripts/init.mjs`。

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

## 5. 环境变量

初始化脚本会从模板创建：

- `apps/server/.env`
- `apps/web/.env`

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

## 6. Runtime 与 Sandbox

AgeWork 的工作空间运行环境由 `AGEWORK_RUNTIME_ALLOWED_TYPES` 控制：

- `local`：在本机进程中运行 Agent。
- `sandbox`：在沙箱环境中运行 Agent。
- `local,sandbox`：创建工作空间时可选择运行环境。

Sandbox 隔离级别由 `AGEWORK_RUNTIME_ALLOWED_ISOLATION_SCOPES` 控制：

- `user`：同一用户共享沙箱资源。
- `workspace`：每个工作空间使用独立沙箱资源。
- `user,workspace`：创建工作空间时可选择隔离级别。

如果 sandbox 工作空间指定用户自定义本地目录，需要允许并选择 `workspace` 隔离。

## 7. OpenSandbox

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

## 8. 桌面端

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

## 9. 项目结构

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
