# AgeWork

本地化部署的多 Agent 工作台，支持 Claude、Codex 等 AI Agent，数据完全自控。

## 环境要求

- Node.js `>=20`
- pnpm `10.33.4`

## 快速开始

```bash
pnpm boot
```

交互式向导，选择模式、配置选项，完成后可直接启动服务。

也可以直接用命令：

```bash
pnpm init:dev && pnpm dev    # 开发
pnpm init:prod && pnpm app:deploy  # 生产
```

启动后访问 http://localhost:5173。首次启用登录验证时，页面会引导设置固定 `admin` 管理员密码；进入系统后在「设置 → Agent 配置」添加 API Key，然后在首页创建项目开始使用。

## 初始化参数

`pnpm init:dev` / `pnpm init:prod` 支持以下参数：

- `--no-install` — 跳过 `pnpm install`
- `--no-auth` — 禁用登录验证（`init:dev` 默认启用，`init:prod` 默认关闭）
- `--reset` — 重写环境默认值并清空重建数据库，有数据时询问是否备份
- `--ctx <path>` — 设置部署子路径，同步写入前后端配置
- `--name <name>` — 修改应用名
- `--port <port>` — 修改后端端口
- `--runtime <local|sandbox|local,sandbox>` — 设置允许创建的工作空间运行环境
- `--isolation <user|workspace|user,workspace>` — 设置允许创建的沙箱隔离级别；沙箱工作空间指定本地目录时必须使用 `workspace`
- `--sandbox-engine <docker|opensandbox>` — 设置沙箱底层引擎；选择 `opensandbox` 时会启动本地 OpenSandbox Server 并确保 worker 镜像存在

一个 AgeWork 服务实例可以通过 `AGEWORK_RUNTIME_ALLOWED_TYPES` 限制可用能力；workspace 创建时选择 `local` 或 `sandbox`，后续 run 按 workspace 记录的运行环境执行。
Sandbox workspace 的隔离级别由 `AGEWORK_RUNTIME_ALLOWED_ISOLATION_SCOPES` 限制，第一项作为默认值；选择用户自定义本地目录时只能使用工作空间级隔离。

## 环境变量

init 会自动从 `.env.example` 创建 `.env`，通常不需要手动配置。

`apps/api/.env` 必配项：

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `AGEWORK_PRIVATE_DATABASE_URL` | 数据库连接 | `file:./dev.db` |

管理员账号不使用环境变量初始密码。首次启用登录验证时，通过 Web 初始化页面设置固定 `admin` 密码。其余配置（`PORT`、`AGEWORK_APP_NAME`、`AGEWORK_CONTEXT` 等）均有代码默认值，按需修改即可；`AGEWORK_PRIVATE_JWT_SECRET` 由 init 自动生成并写入 `.env`。

## 生产部署

```bash
pnpm init:prod     # 安装依赖、初始化环境
pnpm app:deploy    # 构建并启动
```

部署到子路径时：

```bash
pnpm init:prod --ctx /agent
pnpm app:deploy
```

Nginx 转发：

```nginx
location /agent/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_buffering off;
    proxy_read_timeout 3600s;
}
```

更新部署：

```bash
git pull && pnpm init:prod && pnpm app:deploy
```

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm boot` | 交互式初始化向导 |
| `pnpm init:dev` | 开发环境初始化 |
| `pnpm init:prod` | 生产环境初始化 |
| `pnpm dev` | 启动开发服务 |
| `pnpm dev:reset` | 重置数据库并启动开发服务 |
| `pnpm build` | 构建生产产物 |
| `pnpm start` | 启动已有构建 |
| `pnpm app:deploy` | 构建并启动生产服务 |
| `pnpm opensandbox:up` | 启动本地 OpenSandbox Server（Docker runtime，监听 8080） |
| `pnpm opensandbox:down` | 停止本地 OpenSandbox Server |
| `pnpm opensandbox:health` | 检查 OpenSandbox Server 健康状态 |
| `pnpm opensandbox:logs` | 查看 OpenSandbox Server 日志 |
| `pnpm db:studio` | 打开 Prisma Studio |
| `pnpm kill-port <port>` | 清理指定端口 |
| `pnpm typecheck` | 类型检查 |
| `pnpm test:api` | 后端单测 |
| `pnpm test:web` | 前端单测 |
