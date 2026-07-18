# ADR-0005: managed 容器 runtime 起独立进程 + supervisor（已废弃）

> 状态:superseded（2026-07-14）
> 日期:2026-07-09
> 上下文:runtime 模块

已由 `docs/design/server-runtime-worker-target-architecture.md` 取代。builtin
现在是一台进程内 RuntimeHost，以 capabilities 同时声明多个 runtimeType；
`ManagedRuntimeSupervisor` 及其独立容器 runtime 进程已删除。下文仅保留为历史记录。

## 背景

design.md §1 定调混合方案:managed native 留 server 进程内(直读 fs/git),
managed docker/opensandbox + registered 起独立 runtime 进程(经隧道 RPC)。

Ticket 04 之前,所有 managed runtime(native/docker/opensandbox)都留在 server
进程内,由 `LocalRuntime` 经 Runtime Host 内建的 provider resolver 统一分发。
docker/opensandbox 的 start/stop/destroy 在 server 进程内直接调 provider,
文件/git 能力也由 `LocalRuntime` 越权代理(直读本机硬盘)。

问题:

1. docker/opensandbox 的容器管理逻辑跑在 server 进程内,server 崩即全崩。
2. `LocalRuntime` 越权替 docker/opensandbox 干文件/git 的活,能力归属不清。
3. 与 registered 的隧道 RPC 模式不对称,无物理依据(见 design.md §1)。

## 决策

managed docker/opensandbox 起独立 runtime 进程(跑 apps/runtime),与 registered
完全同构(同一产物、同一隧道协议),只是连 loopback 而非远程。

### 1. 进程拓扑

| runtime                    | 进程拓扑                      | start/stop/destroy 通道  | 文件/git 通道                |
| -------------------------- | ----------------------------- | ------------------------ | ---------------------------- |
| managed native             | server 进程内                 | 进程内直调(LocalRuntime) | 进程内直读                   |
| managed docker/opensandbox | server fork 独立 runtime 进程 | loopback 隧道 RPC        | loopback 隧道 RPC(Ticket 05) |
| registered                 | 远程独立 runtime 进程         | 远程隧道 RPC             | 远程隧道 RPC                 |

`RuntimeService.runtimeFor()` 改为:

- `managed-native` → `LocalRuntime`(进程内)
- `managed-docker`/`managed-opensandbox` → `RemoteRuntime`(隧道 RPC)
- registered → `RemoteRuntime`(隧道 RPC)

新增 `isManagedNativeRuntimeId()` 区分「进程内 native」与「隧道 docker/opensandbox」。
`isManagedRuntimeId()` 保留(所有 `managed-*` 前缀),供 workspace 等判断「是否本机」。

### 2. Supervisor(`ManagedRuntimeSupervisor`)

位置:`apps/server/src/runtime/managed/supervisor.ts`(runtime 模块 internal provider)。

职责:

- `onApplicationBootstrap` 时,为 docker/opensandbox 各 fork 一个 apps/runtime 进程。
- 注入 env:`AGEWORK_SERVER_BASE_URL`(loopback)、`AGEWORK_RUNTIME_TOKEN`(managed token)、
  `AGEWORK_RUNTIME_TYPE`、`AGEWORK_RUNTIME_WORKER_IMAGE`、`AGEWORK_RUNTIME_LOG_DIR`。
- 监听进程 exit:首次崩溃立即重启,后续指数退避(1s → 2s → 4s → … → 30s 封顶)。
- `onApplicationShutdown` 时 SIGTERM 所有子进程,取消待重启定时器。
- 进程重启后自动重连 server(loopback 隧道),register 消息刷新 envConfig。

### 3. Token 管理

- server 启动时为 docker/opensandbox 各生成一个 managed token(randomBytes 64 hex)。
- tokenHash(sha256)存入 Runtime 行(覆盖旧值——旧进程已死,旧 token 自然失效)。
- 明文 token 保存在 supervisor 内存中,重启子进程时复用(不变)。

`RuntimeRepository.upsertManaged` 新增 `tokenHash` 参数:

- native: `null`(留进程内,不经隧道)
- docker/opensandbox: sha256(managed token)

### 4. 断连语义分治(design.md §4.3)

`RuntimeTunnelHandler` 的 `close` 事件处理:

- **managed**(`isManagedRuntimeId(runtimeId)` 为 true):不立刻 `markOffline`——
  supervisor 会重启进程,重启后重新连 server。心跳超时由 `RuntimeLivenessWatchdog` 兜底。
- **registered**:立即 `markOffline`——远程机器可能失联。

### 5. 孤儿 worker 清理(design.md §5.7)

runtime 进程崩时它 fork 的 worker 成孤儿。决策:**runtime 进程自清理,server 不持 pid**。

- 重启后的 runtime 进程负责清理自己的孤儿(provider.start 的容器名冲突恢复机制兜底)。
- server 不保留按 pid 杀孤儿的能力(destroy 的孤儿清理不完全迁出 server)。

## 影响

- `RuntimeService.onApplicationBootstrap`:native 走原路径(upsert + local detectEnv);
  docker/opensandbox 走新路径(generate token → upsert with tokenHash → supervisor fork)。
- `RuntimeService.runtimeFor`:只有 `managed-native` 返回 `LocalRuntime`。
- `RuntimeService.detectEnv` / `assertRuntimeReachable`:用 `isManagedNativeRuntimeId`
  替代 `isManagedRuntimeId` 判断「是否需要隧道连接」。
- `RuntimeTunnelHandler`:managed 断连不 `markOffline`。
- `RuntimeModule`:注册 `ManagedRuntimeSupervisor` 为 internal provider。
- `RuntimeRepository.upsertManaged`:新增 `tokenHash` 必填参数。
- `RuntimeInstanceRefRpcParams`(shared/protocol):新增 `workerId` 字段(Ticket 03 遗留修复)。

## 不做

- 不碰 managed native(留 server 进程内,现状)。
- 不补能力 RPC(list-files 等,那是 Ticket 05)。
- 不实现 ②(远程但 server 管进程生死)。
- 不改 `LocalRuntime` 职责收窄(那是 Ticket 06)。
