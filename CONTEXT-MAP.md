# Context Map

This is a multi-context monorepo. Each context owns its domain language and architectural decisions independently. Read this map first, then dive into the context(s) relevant to your topic.

There is no global `docs/adr/` — ADRs live per-context. If a context has no `CONTEXT.md` yet, `/domain-modeling` creates one lazily when terms get resolved.

## Contexts

### `apps/runtime` — runtime manager

Runtime manager (local + container). Decides how `claude`/`codex` binaries are provided.

- ADRs: [`apps/runtime/docs/adr/`](apps/runtime/docs/adr/)
  - `0001-sdk-external-plus-real-npm-install.md` — SDK 保持 external，靠真实 npm install 提供二进制，不靠 bundle inline

### `apps/server` → runtime module — server-side runtime orchestration

Runtime 的软删除策略、EnvConfig 两层分离、CLI 检测归属、容器 CLI 路径传播。

- ADRs: [`apps/server/src/runtime/docs/adr/`](apps/server/src/runtime/docs/adr/)
  - `0001-runtime-soft-delete-required-fk.md` — Runtime 只软删除，Workspace/Worker 的 runtimeId 必填
  - `0002-envconfig-two-layer-detected-vs-override.md` — EnvConfig 两层分离：detected 与 override 独立存储
  - `0003-cli-resolver-in-runtime-not-server.md` — CliResolver 放 apps/runtime，server 不做 CLI 检测
  - `0004-container-cli-path-via-env-not-envconfig.md` — Container CLI 路径不经 envConfig，直接 env 注入

### `apps/server` → run module — run 生命周期编排

问答中断 terminal model(AG-UI interrupt outcome + resume[]),SDK 侧保持 pause model。

- ADRs: [`apps/server/src/run/docs/adr/`](apps/server/src/run/docs/adr/)
  - `0001-question-interrupt-terminal-model.md` — 问答走 AG-UI interrupt terminal model,worker/SDK 保持 pause model
  - `0002-resume-payload-generalization.md` — resume 契约泛化为 provider 无关 payload + 接受 cancelled(为 Codex 审批 decision/decline,顺带解锁 Claude 权限拒绝)

### `apps/server` → worker-manager module — worker lifecycle & channels

Worker 为主概念、runtime 载体收尾 stop/destroy、并发防重键、工作空间文件命令独立通道、builtin 文件预览直读。

- ADRs: [`apps/server/src/worker-manager/docs/adr/`](apps/server/src/worker-manager/docs/adr/)
  - `0001-worker-is-primary-runtime-is-instrumental.md` — Worker 为主概念，runtime 是无状态运行载体
  - `0002-runtime-lifecycle-stop-vs-destroy.md` — Runtime 载体收尾分 stop(留)与 destroy(删)
  - `0003-worker-concurrency-key-stays-owner-id.md` — Worker 防重键维持裸 ownerId
  - `0004-workspace-file-commands-independent-channel.md` — 工作空间文件命令走独立通道
  - `0005-builtin-file-preview-server-direct-read.md` — builtin runtime 文件预览走 server 直读

### `apps/web` — 前端

RunSession(run 生命周期前端唯一归属,不碰 aui)、resume 数据流、runStatus 唯一写入面、aui 接线层。

- 词汇表:[`apps/web/CONTEXT.md`](apps/web/CONTEXT.md)
- ADRs: [`apps/web/docs/adr/`](apps/web/docs/adr/)
  - `0001-stop-optimistic-status-delayed-revalidate.md` — stop 后乐观写 + 延迟单次校准,不立即 invalidate

### `packages/providers` — runtime provider extension point

Runtime provider 抽为扩展点包，与 agent adapter 对称。

- ADRs: [`packages/providers/docs/adr/`](packages/providers/docs/adr/)
  - `0001-runtime-as-extension-point-package.md` — runtime provider 抽为 `packages/runtime` 扩展点包

### `packages/worker` — worker runner entry

Runner 独立入口 + 显式 env 白名单。

- ADRs: [`packages/worker/docs/adr/`](packages/worker/docs/adr/)
  - `0001-runner-independent-entry.md` — Runner 独立入口 + 显式 env 白名单

### `packages/adapters` → codex adapter — Codex 接入后端

Codex First-class 后端从单向 SDK 迁到双向 `codex app-server`(为拿到用户级命令/文件/权限审批)。默认 backend 为 app-server,SDK 保留为回退。

- 执行文档:[`docs/agework-codex-app-server-migration.md`](docs/agework-codex-app-server-migration.md);协议源真相:[`docs/codex-app-server.md`](docs/codex-app-server.md)
- ADRs: [`packages/adapters/src/codex/docs/adr/`](packages/adapters/src/codex/docs/adr/)
  - `0001-codex-app-server-first-class-backend.md` — 迁 app-server;每 Runner 一个 app-server;锁 Managed 版本+握手 gate+capability 降级;保留 SDK 回退

## How to use this map

- **Before working in a context**: read its `docs/adr/` entries that touch the area you're about to change.
- **When naming a domain concept** (issue title, refactor proposal, test name): use the term as defined in that context's `CONTEXT.md` if it exists; otherwise prefer the vocabulary already established in the ADRs above.
- **If your output contradicts an ADR**: surface it explicitly — _"Contradicts ADR-0002 (runtime lifecycle stop vs destroy) — but worth reopening because…"_
- **Adding a new context**: append a section here and create its `docs/adr/` directory. New ADRs follow the numbering scheme already in use per context.
