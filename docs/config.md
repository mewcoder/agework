# 配置管理

AgeWork 配置按边界分为四类：

| 类别            | 存放位置                     | 用途                                                         | 生效方式                       |
| --------------- | ---------------------------- | ------------------------------------------------------------ | ------------------------------ |
| 部署/启动 ENV   | `apps/server/.env`、进程环境 | 进程启动前必须确定的部署、认证、网络、runtime 拓扑、诊断配置 | 修改后重启                     |
| 前端构建 ENV    | `apps/web/.env`、进程环境    | Vite base path 与 API context                                | 重新启动 dev server 或重新构建 |
| DB 系统设置     | `SystemSetting` 表           | 管理员可在线调整的运行时业务配置                             | API 写入后立即刷新内存缓存     |
| 内部 worker ENV | API 启动 worker 时注入       | API 与 worker 通信协议、runtime 元数据                       | 不暴露给用户维护               |

原则：

- 启动必需、密钥、网络拓扑、runtime 能力限制、诊断开关放 ENV。
- 运行期可改、适合后台管理的业务配置放 DB，并允许同名 ENV 作为 fallback。
- Worker 内部协议变量不要写进用户 `.env.example`。
- 模型 Provider 的系统环境变量单独归类，不属于 AgeWork 部署配置。

代码级默认配置集中在 `apps/server/src/config/defaults.ts`。如果 fork/私有部署想改变 AgeWork 的默认 App 名、端口、默认 runtime、默认镜像、OpenSandbox 默认值或固定本机目录，直接改这个文件；不要再为这些默认值额外增加 ENV。

---

## API ENV

这些变量由后端进程读取，主要配置文件是 `apps/server/.env`。

### 基础

| 变量                           | 默认值                               | 建议     | 说明                                                                                               |
| ------------------------------ | ------------------------------------ | -------- | -------------------------------------------------------------------------------------------------- |
| `PORT`                         | `3000`                               | 保留 ENV | 后端 HTTP 监听端口。                                                                               |
| `AGEWORK_CONTEXT`              | 空字符串                             | 保留 ENV | 应用上下文路径，例如 `/agent` 会让 API 挂载到 `/agent/api/v1`。                                    |
| `AGEWORK_SERVE_FRONTEND`       | `false`                              | 保留 ENV | 后端是否托管前端静态资源。按需开启。                                                               |
| `AGEWORK_BODY_LIMIT`           | `50mb`                               | 保留 ENV | API 请求体大小上限。                                                                               |
| `AGEWORK_LOG_LEVEL`            | dev: `debug`；prod: `error,warn,log` | 保留 ENV | 可选 `debug`、`verbose`、`warn`、`error`。                                                         |
| `AGEWORK_DATA_DIR`             | `~/.agework`                         | 保留 ENV | AgeWork 本机数据根目录。                                                                           |
| `AGEWORK_PRIVATE_DATABASE_URL` | `file:./dev.db`                      | 保留 ENV | Prisma 数据库连接。当前仅支持 SQLite；项目仍处于开发态。                                           |
| `AGEWORK_PRIVATE_JWT_SECRET`   | init 写入                            | 保留 ENV | JWT 签名密钥，由初始化流程生成并写入 `.env`；正常不需要手动配置。生产环境缺失会启动失败。          |
| `AGEWORK_DEV_AUTH_DISABLED`    | `false`                              | 保留 ENV | 仅在 `NODE_ENV` 为空或 `development` 时有效。为 `true` 时使用真实 admin 超级管理员并跳过登录验证。 |

`NODE_ENV` 不是 `.env.example` 配置项，由运行脚本设置（`pnpm dev`/`pnpm test` 等留空按开发处理，`pnpm start` 设为 `production`）。它决定 `AGEWORK_DEV_AUTH_DISABLED`/`AGEWORK_PRIVATE_JWT_SECRET` 校验是否生效，以及 `AGEWORK_LOG_LEVEL`、`AGEWORK_WORKER_LOG_LEVEL` 的默认级别。

### Runtime / Sandbox

| 变量                                           | 默认值                  | 建议     | 说明                                                                                                                                          |
| ---------------------------------------------- | ----------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGEWORK_RUNTIME_ALLOWED_TYPES`                | `native`                | 保留 ENV | 当前部署允许创建的 workspace runtimeType，可选 `native`、`docker`、`opensandbox`（可逗号组合）。非法值启动失败。                              |
| `AGEWORK_RUNTIME_ALLOWED_SCOPES`               | `user`                  | 保留 ENV | 当前部署允许创建的 sandbox 运行范围，可选 `user`、`workspace` 或 `user,workspace`；第一项作为默认值。沙箱指定本地目录时必须使用 `workspace`。 |
| `AGEWORK_SANDBOX_OPENSANDBOX_DOMAIN`           | `localhost:8080`        | 保留 ENV | OpenSandbox 服务地址，格式为 host:port。仅 `AGEWORK_RUNTIME_ALLOWED_TYPES` 包含 `opensandbox` 时需要关注。                                    |
| `AGEWORK_SANDBOX_OPENSANDBOX_PROTOCOL`         | `http`                  | 保留 ENV | 可选 `http`、`https`。                                                                                                                        |
| `AGEWORK_PRIVATE_OPENSANDBOX_API_KEY`          | 空                      | 保留 ENV | OpenSandbox API key，属于部署密钥。                                                                                                           |
| `AGEWORK_SANDBOX_OPENSANDBOX_IMAGE`            | `agework/worker:latest` | 保留 ENV | OpenSandbox 创建 sandbox 使用的镜像。                                                                                                         |
| `AGEWORK_SANDBOX_OPENSANDBOX_TIMEOUT_SECONDS`  | `3600`                  | 保留 ENV | sandbox 生命周期超时秒数。                                                                                                                    |
| `AGEWORK_SANDBOX_OPENSANDBOX_USE_SERVER_PROXY` | `false`                 | 保留 ENV | 是否通过 OpenSandbox 服务代理访问。                                                                                                           |

### 诊断与日志

| 变量                                    | 默认值                     | 建议     | 说明                                                                                      |
| --------------------------------------- | -------------------------- | -------- | ----------------------------------------------------------------------------------------- |
| `AGEWORK_AGENT_EVENT_TRACE_ENABLED`     | `false`                    | 保留 ENV | 开启后写入 agent 事件 trace 文件（`*.raw.jsonl`、`*.agui.jsonl`）。当前代码直接读取 ENV。 |
| `AGEWORK_AGENT_EVENT_TRACE_MAX_FILE_MB` | `50`                       | 保留 ENV | 单个 agent 事件 trace 文件大小上限，超过后写入 truncated 标记并停止继续写入。             |
| `AGEWORK_WORKER_LOG_LEVEL`              | dev: `debug`；prod: `info` | 保留 ENV | worker 诊断日志（`*.worker.log`）级别：`debug`、`info`、`warn`、`error`。                 |
| `AGEWORK_WORKER_LOG_MAX_FILE_MB`        | `50`                       | 保留 ENV | 单个 worker 诊断日志文件大小上限，超过后写入 truncated 标记并停止继续写入。               |

---

## Web ENV

这些变量由 Vite 读取，主要配置文件是 `apps/web/.env`。

| 变量                   | 默认值                                              | 建议           | 说明                                                          |
| ---------------------- | --------------------------------------------------- | -------------- | ------------------------------------------------------------- |
| `VITE_APP_BASE_PATH`   | fallback 到 `apps/server/.env` 的 `AGEWORK_CONTEXT` | 保留为高级覆盖 | 前端页面、路由、静态资源 base path。                          |
| `VITE_APP_API_CONTEXT` | fallback 到 `apps/server/.env` 的 `AGEWORK_CONTEXT` | 保留为高级覆盖 | 前端请求 API 的 context，最终 API 前缀为 `<context>/api/v1`。 |

通常只设置 `AGEWORK_CONTEXT` 即可；只有前端部署路径和后端 API context 不一致时才单独设置这两个变量。

---

## DB 系统设置

当前实现使用 `SystemSetting` 表：

```prisma
model SystemSetting {
  key       String   @id
  value     String
  updatedAt DateTime @updatedAt
  updatedBy String?
}
```

读取优先级：**DB 覆盖值 > 同名 ENV > 代码默认值**。

| key                                    | 默认值    | 类型   | 建议                     | 说明                                   |
| -------------------------------------- | --------- | ------ | ------------------------ | -------------------------------------- |
| `AGEWORK_APP_NAME`                     | `AgeWork` | string | 放 DB，允许 ENV fallback | 应用名称，展示在登录页、侧边栏等位置。 |
| `AGEWORK_RUNTIME_IDLE_TIMEOUT_SECONDS` | `1800`    | number | 放 DB，允许 ENV fallback | Runtime 空闲超时秒数。                 |

Admin API 当前为 RPC 风格：

```text
GET  /api/v1/admin/config/list
POST /api/v1/admin/config/set      body: { key, value }
POST /api/v1/admin/config/reset    body: { key }
```

---

## 内部 Worker ENV

以下变量由 Runtime Host 或 Worker 在启动子进程时注入，不应让用户手动维护，也不应放进 `.env.example`。

| 变量                                   | 来源        | 说明                                            |
| -------------------------------------- | ----------- | ----------------------------------------------- |
| `AGEWORK_WORKER_ROLE`                  | Host/Worker | 进程角色，取值 `worker` 或 `runner`。           |
| `AGEWORK_WORKER_ID`                    | Host        | Host 内的 Worker 标识。                         |
| `AGEWORK_WORKER_OWNER_ID`              | Host        | 从 owner key 解析出的业务 owner id。            |
| `AGEWORK_WORKER_START_TOKEN`           | Host        | Worker 向 Host 注册时使用的一次性凭据。         |
| `AGEWORK_WORKER_API_BASE`              | Host        | Worker 所属 Host 的 HTTP 端点。                 |
| `AGEWORK_WORKER_RUNTIME_TYPE`          | Host        | 执行方式：`native`、`docker` 或 `opensandbox`。 |
| `AGEWORK_WORKER_SCOPE`                 | Host        | Worker 复用范围：`user` 或 `workspace`。        |
| `AGEWORK_WORKER_WORKSPACE_PATH`        | Host        | Worker 在执行环境内看到的 workspace 路径。      |
| `AGEWORK_WORKER_RUNTIME_RESOURCE_NAME` | Provider    | provider 内部资源名，仅用于诊断。               |
| `AGEWORK_WORKER_LOG_DIR`               | Provider    | 执行环境内的日志目录。                          |
| `AGEWORK_WORKER_LOG_FILE`              | Host/Worker | 当前 Worker 或 Runner 的日志文件。              |
| `AGEWORK_WORKER_RUN_ID`                | Worker      | Runner 对应的全链路 runId。                     |

---

## 模型 Provider 系统环境

这些变量不是 AgeWork 部署配置，而是"模型服务使用系统环境"的来源。它们由模型配置页面的"系统环境"信息展示和 agent 子进程安全透传逻辑使用。

| Agent  | 变量                   | 说明                                        |
| ------ | ---------------------- | ------------------------------------------- |
| Claude | `ANTHROPIC_AUTH_TOKEN` | Claude 认证 token。当前主用字段。           |
| Claude | `ANTHROPIC_BASE_URL`   | Claude API base URL。                       |
| Claude | `ANTHROPIC_MODEL`      | Claude 模型名。                             |
| Claude | `CLAUDE_CONFIG_DIR`    | Claude CLI 配置目录，仅系统环境透传时使用。 |
| Codex  | `OPENAI_API_KEY`       | OpenAI/Codex API key。                      |
| Codex  | `CODEX_API_KEY`        | Codex API key fallback。                    |

---

## Codex Backend 配置

Codex adapter 支持两种 backend，经 `AGEWORK_CODEX_BACKEND` 环境变量切换：

| 变量                                           | 默认值       | 说明                                                                                                                                                                           |
| ---------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AGEWORK_CODEX_BACKEND`                        | `app-server` | Codex adapter 后端选择。`app-server`（默认）使用 `codex app-server` 双向 JSON-RPC 协议，支持用户级命令/文件/权限审批。`sdk` 回退到旧 `@openai/codex-sdk`（单向，仅自动审批）。 |
| `AGEWORK_CODEX_APP_SERVER_REQUEST_TIMEOUT_MS`  | `30000`      | app-server JSON-RPC 请求超时（毫秒）。超时后清 pending 并报错。                                                                                                                |
| `AGEWORK_CODEX_APP_SERVER_SHUTDOWN_TIMEOUT_MS` | `5000`       | app-server 子进程关闭超时（毫秒）。超时后 SIGKILL。                                                                                                                            |

这些变量由 worker 进程读取，经 `runner-manager.ts` 白名单传递给 runner 子进程。详见 [`packages/adapters/src/codex/factory.ts`](packages/adapters/src/codex/factory.ts) 和 ADR [`packages/adapters/src/codex/docs/adr/0001-codex-app-server-first-class-backend.md`](packages/adapters/src/codex/docs/adr/0001-codex-app-server-first-class-backend.md)。
