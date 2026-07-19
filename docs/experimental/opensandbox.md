# OpenSandbox（实验性）

> 状态：默认关闭、按需维护。该 provider 保留给确有额外沙箱管理需求的个人或团队，
> 不属于当前主要维护方向，也不承诺随每次主线改动持续验证。常规本地隔离优先使用 Docker runtime。

实现以独立插件包 `@agework/runtime-opensandbox` 接入。公共契约由 `@agework/runtime-sdk`
提供，`@agework/runtime-host` 只内建 Native；Docker 与 OpenSandbox 都通过同一个 `providerPlugins`
契约装配它。通用代码示例见 [`packages/runtime-opensandbox/README.md`](../../packages/runtime-opensandbox/README.md)。

记录使用 OpenSandbox 运行时（runtime type `opensandbox`，需将 `opensandbox` 加入
`AGEWORK_RUNTIME_ALLOWED_TYPES`）时涉及的文件、启动方式和常见报错排查。历史设计文档见
`docs/archive/superpowers/specs/`。

## 相关文件

- `infra/opensandbox/docker-compose.yml` — 定义 `opensandbox-server` 容器，挂载同目录下的
  `config.toml`、Docker socket 和 `~/.agework/workspaces`。
- `infra/opensandbox/config.toml` — OpenSandbox Server 配置：runtime 类型（docker）、
  `execd`/`egress` 镜像版本、存储白名单路径等。
- `scripts/opensandbox.mjs` — 统一入口（CLI + 可复用模块）：
  - `ensureWorkerImage()`：检查/构建 `agework/worker:latest`（execd 容器运行的 worker 镜像）
  - `pullRuntimeImages()`：从 `config.toml` 读取并拉取 `execd`/`egress` 镜像
  - `composeUp/Down/Logs/Restart()`：操作 `infra/opensandbox/docker-compose.yml`
  - `waitForHealth()` / `healthCheck()`：健康检查
  - `isWorkerImageStale()`：比较 worker 镜像构建时间与 `apps/runtime`/`packages/worker`/
    `packages/shared`/`packages/adapters` 源码 mtime
- `packages/runtime-opensandbox` — OpenSandbox RuntimeProvider 插件、SDK 适配和插件私有配置
- `packages/runtime-sdk` — 第三方插件公共 SDK、manifest 和生命周期契约
- `apps/runtime/src/providers` — Runtime Host 的 Native 内建实现
- `packages/runtime-docker` — 默认随发行版装配的 Docker Runtime Plugin
- `apps/server/.env` 中的 `OPENSANDBOX_*`（DOMAIN/PROTOCOL/API_KEY/IMAGE/...）

## 常用命令

```bash
pnpm opensandbox:up      # 一键：构建/检查 worker 镜像、拉取 execd/egress 镜像、启动容器、等待健康检查
pnpm opensandbox:down    # 停止容器
pnpm opensandbox:logs    # 看日志
pnpm opensandbox:health  # 健康检查（GET /health）
pnpm opensandbox:rebuild # 重新构建 worker 镜像并重启 opensandbox-server
```

修改 `apps/runtime`、`packages/worker`、`packages/shared`、`packages/adapters` 源码后，再次执行
`pnpm opensandbox:up` 会提示 worker 镜像是否过期；过期时执行 `pnpm opensandbox:rebuild`
重新构建并让新 sandbox 使用新镜像。

## Runtime Host 装配方式

### builtin Host

server 的 `AGEWORK_RUNTIME_ALLOWED_TYPES` 包含 `opensandbox` 时，会从可选依赖
清单 `AGEWORK_RUNTIME_PLUGINS=@agework/runtime-opensandbox` 动态加载插件。通用 `pnpm boot` / `pnpm init:*` 不提供
OpenSandbox 选项；先执行 `pnpm opensandbox:up`，再手动将该 runtime type 写入 server 环境配置。

### registered Host

registered daemon 的 `--runtime` 包含 `opensandbox` 时也会动态加载同一个插件包。插件包需要与
`agework-runtime` 一起安装或部署：

```bash
export AGEWORK_SANDBOX_OPENSANDBOX_DOMAIN=localhost:8080
export AGEWORK_SANDBOX_OPENSANDBOX_PROTOCOL=http

agework-runtime \
  --server http://agework.example/api/v1 \
  --token <pair-token> \
  --runtime opensandbox \
  --plugins @agework/runtime-opensandbox \
  --worker-image agework/worker:latest
```

也可使用 `AGEWORK_SANDBOX_OPENSANDBOX_DOMAIN`、
`AGEWORK_SANDBOX_OPENSANDBOX_PROTOCOL`、`AGEWORK_PRIVATE_OPENSANDBOX_API_KEY` 和
`AGEWORK_SANDBOX_OPENSANDBOX_USE_SERVER_PROXY`。自定义 Host 可直接调用
`createOpenSandboxRuntimePlugin()`，将返回值传入 `RuntimeHostConfig.providerPlugins`。

## 常见问题

### 容器一直 Restarting，`/health` fetch failed

日志会显示：

```
API key startup confirmation failed: Startup blocked: server.api_key is empty in non-interactive mode.
Set OPENSANDBOX_INSECURE_SERVER=YES to acknowledge the risk.
```

OpenSandbox Server 在非交互模式下启动时，要求 `config.toml` 配置 `server.api_key` 或设置
`OPENSANDBOX_INSECURE_SERVER=YES`。本地开发已在 `infra/opensandbox/docker-compose.yml` 中设置
`OPENSANDBOX_INSECURE_SERVER: "YES"`（不要在生产环境启用）。

### 创建 sandbox 报 `Failed to pull image opensandbox/execd:v1.0.18: 404 ... No such image`

`config.toml` 中 `execd_image` / `egress.image` 指定的镜像（如 `opensandbox/execd:v1.0.18`、
`opensandbox/egress:v1.1.0`）不是由本项目构建的，而是 OpenSandbox Server 在创建 sandbox 时按需
从 Docker Hub 拉取。`pnpm opensandbox:up` 会先尝试 `docker pull` 这两个镜像；如果拉取失败（仅打印
警告），可以手动重试：

```bash
docker pull opensandbox/execd:v1.0.18
docker pull opensandbox/egress:v1.1.0
```

镜像版本号需与 `infra/opensandbox/config.toml` 中的 tag 保持一致。

### `pnpm opensandbox:up` 报 `Conflict. The container name "/agework-opensandbox-server" is already in use`

旧版 `docker-compose.opensandbox.yml`（仓库根目录）启动过的 `agework-opensandbox-server` 容器
仍在运行时会出现该冲突，因为新的 compose 文件 `infra/opensandbox/docker-compose.yml` 的
compose project 名称变了，但容器名固定不变。一次性手动清理旧容器即可：

```bash
docker rm -f agework-opensandbox-server
pnpm opensandbox:up
```
