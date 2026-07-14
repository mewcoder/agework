# Worker Manager

Phase 3 清尾后，worker-manager 模块只剩 **contract 实现 + admin 观测面**。

旧执行栈（connection/instance/registry）、旧 `/worker/*` 端点、`WorkerManagerService` 已全部删除。worker 数据面由 builtin Host 自管的 `WorkerHttpServer` 承接（registered Host 各自的 `WorkerHttpServer`）。

## Language

**RuntimeHost**:
一台执行机器的常驻执行节点。builtin（本机 in-process）或 registered（远程机器注册）。实现 `RuntimeHostContract`，内部管理 worker 池、命令信箱、握手、fence。一机一行一隧道。
_Avoid_: Worker、Carrier、Runtime instance（旧词，已删表）

**RuntimeHostContract**:
server 与 Host 的执行面契约接口。`submitRun` / `command` / `releaseOwner` / `releaseRun` / `listWorkers` / `stopWorker` / `detectEnv` / `installCli` + 文件操作。run 模块经 `RUNTIME_HOST_CONTRACT` token 注入，看不见实现类。
_Avoid_: WorkerManagerService（已删）、Runtime 接口（旧名）

**RuntimeHostAdapter**:
`RuntimeHostContract` 的 server 侧实现。builtin Host（进程内 `RuntimeHost` 实例）走进程内调用；registered Host 经隧道 RPC 转发。按 `runtimeHostId` 路由到正确的 Host。

**WorkerKey**:
worker 池的唯一键：`${OwnerKey}#${runtimeType}`。同一 (owner, runtimeType) 至多一个活跃 worker。stopWorker / fence 全部用它。
_Avoid_: WorkerInstance（旧词）、ownerId 裸用（多 runtimeType 下撞车）

**OwnerKey**:
worker 复用的 owner 键：`workspace:${workspaceId}`（workspace 隔离）或 `user:${userId}`（user 隔离）。releaseOwner 据此清理 worker。
_Avoid_: Tenant、account

**Builtin Host**:
server 进程内的 `RuntimeHost` 实例（`@agework/runtime/host`）。自管 `WorkerHttpServer`（与 registered daemon 同构），worker 数据面不再连 server 旧端点。固定 id `"builtin"`。

**Admin 观测面**:
`AdminWorkerController`——contract 现场查询（`listWorkers` / `stopWorker`），不读库。旧 admin 方法（`listResources`/`stopWorkerInstance`/`getWorkerStats` 走 Worker 表）已删。
