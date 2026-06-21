# OpenSandbox 本地环境一键搞定 + 文件整理设计

## 背景

`RUNTIME_PROVIDER=opensandbox` 相关的文件和操作目前比较分散：

- `docker-compose.opensandbox.yml` 在仓库根目录，但配置文件 `infra/opensandbox/config.toml` 在子目录。
- `scripts/init.mjs` 中有 `ensureDockerImage` / `ensureOpenSandboxServer` 等逻辑，
  `scripts/check-opensandbox.mjs` 是单独的健康检查脚本，二者部分逻辑重复（健康检查轮询）。
- `agework/worker:latest` worker 镜像的构建/重建需要手动 `docker build`，没有统一入口；
  代码改动后镜像是否过期也没有提示。
- execd/egress 运行时镜像需要手动 `docker pull`，文档里单独列了一段排障说明。

目标：

1. 把分散的文件归并到 `infra/opensandbox/` 目录。
2. 提供一个统一脚本 `scripts/opensandbox.mjs`，既可作为 CLI 使用，也被 `scripts/init.mjs` 复用，
   去掉重复实现。
3. 提供"一键"命令 `pnpm opensandbox:up`：检查/构建 worker 镜像、拉取 execd/egress 镜像、
   启动 opensandbox-server、等待健康检查、提示 worker 镜像是否过期。
4. 提供 `pnpm opensandbox:rebuild`：强制重建 worker 镜像并重启 opensandbox-server。

## 目标文件结构

```
infra/opensandbox/
  ├── docker-compose.yml   # 原根目录 docker-compose.opensandbox.yml 移到这里
  └── config.toml          # 不变（位置不变，内容不变）

scripts/
  ├── opensandbox.mjs       # 新增：统一入口（CLI + 可复用模块）
  └── init.mjs               # 复用 opensandbox.mjs 导出的函数，删除重复实现
```

删除 `scripts/check-opensandbox.mjs`（功能并入 `opensandbox.mjs health`）。

### `infra/opensandbox/docker-compose.yml`

内容与现有 `docker-compose.opensandbox.yml` 基本一致，仅需调整：

- `config.toml` 的挂载路径从 `./infra/opensandbox/config.toml` 改为 `./config.toml`
  （因为 compose 文件本身现在就在 `infra/opensandbox/` 目录下）。
- 其余卷挂载（Docker socket、`~/.agework/workspaces`、`opensandbox-data`）、
  `OPENSANDBOX_INSECURE_SERVER` 等保持不变。

## `scripts/opensandbox.mjs` 设计

### 导出的可复用函数（供 `init.mjs` import）

- `WORKER_IMAGE_TAG`（`"agework/worker:latest"`）
- `checkWorkerImageExists()` — `docker image inspect` 是否成功
- `buildWorkerImage()` — `docker build -t agework/worker:latest -f apps/worker/Dockerfile .`
- `ensureWorkerImage({ interactive, shouldReset })` — 与现有 `init.mjs` 中
  `ensureDockerImage` 行为一致（不存在则构建；存在时根据 interactive/--reset 决定是否重建）
- `pullRuntimeImages()` — 从 `infra/opensandbox/config.toml` 中正则提取
  `execd_image` 和 `egress.image` 的 tag，逐个 `docker pull`；单个 pull 失败仅打印警告，
  不抛出（创建 sandbox 时 OpenSandbox Server 会按需重试拉取）
- `composeUp()` / `composeDown()` / `composeLogs()` / `composeRestart()` —
  对 `infra/opensandbox/docker-compose.yml` 执行对应 `docker compose` 命令
- `waitForHealth()` — 轮询 `http://127.0.0.1:8080/health`，30s 超时（行为与现有
  `waitForOpenSandboxHealth` 一致）
- `healthCheck()` — 一次性请求 `/health`，失败时打印错误并 `process.exit(1)`
  （行为与现有 `check-opensandbox.mjs` 一致）
- `isWorkerImageStale()` — 比较 worker 镜像 `docker image inspect -f '{{.Created}}'`
  时间与 `apps/worker`、`packages/shared`、`packages/adapters` 三个目录下所有文件的最新
  mtime；源码更新时间晚于镜像构建时间则返回 `true`。镜像不存在时返回 `false`
  （不存在的情况由 `ensureWorkerImage` 处理，不在此重复提示）。

### CLI 子命令（`node scripts/opensandbox.mjs <cmd>`）

- `up`（默认，"一键"）：
  1. `ensureWorkerImage({ interactive: false, shouldReset: false })`
     —— 镜像不存在则构建，存在则跳过
  2. `pullRuntimeImages()`
  3. `composeUp()`
  4. `waitForHealth()`
  5. 若 `isWorkerImageStale()` 为 true，打印提示：
     `⚠️ apps/worker 源码比 agework/worker:latest 镜像新，建议执行 pnpm opensandbox:rebuild`
- `down`：`composeDown()`
- `logs`：`composeLogs()`
- `health`：`healthCheck()`
- `rebuild`：`buildWorkerImage()`（强制重建，不检查是否存在）→ `composeRestart()`

## `scripts/init.mjs` 改动

- 删除：`ensureDockerImage`、`checkDockerImageExists`、`buildDockerImage`、
  `runDockerCompose`、`waitForOpenSandboxHealth`、`ensureOpenSandboxServer`、
  `WORKER_IMAGE_TAG`、`WORKER_DOCKERFILE` 常量定义。
- 改为 `import { ensureWorkerImage, pullRuntimeImages, composeUp, waitForHealth } from "./opensandbox.mjs"`。
- 在选择 `docker` / `opensandbox` runtime 时调用 `ensureWorkerImage({ interactive, shouldReset })`
  （与现状一致）。
- 在选择 `opensandbox` runtime 时，依次调用 `pullRuntimeImages()` → `composeUp()` → `waitForHealth()`
  （与现状的 `ensureOpenSandboxServer` 等价，但去重了实现）。

## `package.json` 改动

```jsonc
"opensandbox:up":      "node scripts/opensandbox.mjs up",
"opensandbox:down":    "node scripts/opensandbox.mjs down",
"opensandbox:logs":    "node scripts/opensandbox.mjs logs",
"opensandbox:health":  "node scripts/opensandbox.mjs health",
"opensandbox:rebuild": "node scripts/opensandbox.mjs rebuild",
```

`opensandbox:up` 中 `docker compose -f` 的路径改为 `infra/opensandbox/docker-compose.yml`。

## 文档改动

重写 `docs/opensandbox-setup.md`：

- "相关文件"一节更新为新的 `infra/opensandbox/{docker-compose.yml,config.toml}` +
  `scripts/opensandbox.mjs` 结构。
- "常用命令"一节以 `pnpm opensandbox:up`（一键启动/刷新）为主入口，新增
  `pnpm opensandbox:rebuild` 说明。
- "常见问题"中 execd/egress 镜像拉取失败的排障说明保留，但补充说明
  `pnpm opensandbox:up` 已会自动尝试拉取，手动 `docker pull` 仅作为兜底。
- 设计背景引用本文件。

## 测试

- 现有 `scripts/init.mjs` 暂无针对 opensandbox 分支的单测；本次改动为脚本重构，
  不新增自动化测试，以手动验证为准：
  - `pnpm opensandbox:up` 在镜像不存在、存在两种情况下均可正常完成
  - `pnpm opensandbox:rebuild` 重建镜像并重启容器
  - `pnpm opensandbox:down` / `logs` / `health` 行为与之前一致
  - `pnpm init:dev`（选择 opensandbox）流程行为与之前一致

## 范围之外

- 不改动 `apps/worker/Dockerfile`、`apps/api/src/runtime/providers/opensandbox-runtime-provider.ts`
  及 `.env` 中的 `OPENSANDBOX_*` 变量。
- 不引入 TOML 解析依赖，`pullRuntimeImages` 用正则从 `config.toml` 中提取两行
  `execd_image = "..."` / `image = "..."`（在 `[egress]` 节下）。
