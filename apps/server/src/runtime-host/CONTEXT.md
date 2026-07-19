# Runtime Host

server 侧 RuntimeHost 域的唯一模块:**节点资源**(注册行、配对、隧道、判死、envConfig、目录浏览)+ **下发面**(contract 实现与 Host 路由、builtin 装配、admin worker 观测)。RuntimeHost 是 worker 运行的载体——builtin（本机 in-process）或 registered（远程机器注册）。

worker 数据面由每个 Host 自管的 `WorkerHttpServer` 承接;worker 池由 Host 进程内自治,server 只经契约下发与观测。owner 生命周期清理(workspace 删除 / user 禁用删除 / 重连对账)不在本模块——workspace、user 模块各自的 `owner-release/` listener 监听事件后向下调 owner reconciliation token。该端口只暴露 Host + OwnerKey，不向业务模块泄漏 Worker 快照。

控制隧道只承载 `host.*` 契约；旧 `LocalRuntime` / `RemoteRuntime`、`runtime.*` RPC
和 registered `Launcher` 已删除。worker 生命周期由 `RuntimeHost` 内部按 `runtimeType`
选择 provider。

Host 隧道与 Host↔Worker HTTP 数据面各自声明独立的线协议版本，不拿应用版本
`AGEWORK_VERSION` 充当兼容性判断。当前是开发态的一次性协议升级，不保留旧协议
兼容分支；协议版本缺失或不一致时，必须在注册绑定/消耗启动令牌之前拒绝。

## Language

**Runtime（执行环境形态）**:
"runtime" 单独出现时只指 worker 的执行环境形态，即 `runtimeType` 的取值（native / docker / opensandbox），类比容器界的 container runtime。它是 RuntimeHost 上报能力矩阵的维度，不是实体、不是进程。
_Avoid_: 用 runtime 指代 RuntimeHost 节点或 `apps/runtime` 程序（后者是执行面程序的包名，不承载领域语义）

**RuntimeHost**:
一个可运行 worker 的执行节点，读作「承载多种 runtime（执行环境）的宿主」。builtin（本机 in-process，固定 id `"builtin"`）或 registered（远程机器注册，配对 token 鉴权）。RuntimeHost 上报能力矩阵（`capabilities` JSON，以 `runtimeType` 为 key，值包含 `available` 和 `scopes`）和环境配置（`envConfig`），server 负责存储和展示。领域内简称 **host**（`host.*` 隧道契约、Builtin Host 等用法即此简称）。
_Avoid_: Runtime（旧模型名，Phase 3 改名 RuntimeHost）、Carrier、engine、Daemon（描述进程形态而非角色，builtin 形态不成立）

**EnvConfig**:
RuntimeHost 启动时检测本机 agent CLI（路径/版本/认证状态）后上报的结果。registered Host 由自身检测，builtin Host 在 server 进程内检测。native 类型 run 启动时从此字段提取 CLI 路径写入 RunConfig；container 类型不经此链路（镜像固定路径）。
_Avoid_: CLI status（泛指时）、environment config

**EnvConfigOverride**:
管理员手动覆盖的 CLI 路径，与 EnvConfig 独立存储。per-host per-agent 粒度。解析优先级：override > detected > null。清空 override 自动回退到 detected。
_Avoid_: Custom config、manual path

**Source**:
resolved CLI path 的来源标记，实时派生不持久化。`"system"` = RuntimeHost 自动检测，`"custom"` = 管理员覆盖。resolvedPath 为 null 即没找到。与 `AgentProviderConfig.source`（凭证来源）同名不同义。
_Avoid_: Origin、provider

**CliResolver**:
RuntimeHost daemon 侧的检测能力（`apps/runtime`）：已知位置搜索 + `--version` 取版本 + 认证文件检查。注册时全量检测一次，之后 admin 可通过隧道 RPC 触发重检。
_Avoid_: CliDetector、CliFinder

**系统环境可用性**:
用户能否选"系统环境"模型选项。两层 AND：admin 全局开关 AND workspace 绑定 RuntimeHost 的 envConfig 里对应 agent 的 `executablePath != null && authAvailable`。server 不做本机检测。
_Avoid_: CLI availability、system status

**Builtin Host**:
server 进程内的 RuntimeHost 实例（`@agework/runtime/host`,与 registered daemon 同构）。固定 id `"builtin"`，`source: "builtin"`。自管 WorkerHttpServer，worker 数据面不再连 server 旧端点。所有 runtimeType 共用一行，能力矩阵在 `capabilities` JSON 里。

**RuntimeHostContract**:
server 与 Host 的执行面契约接口。`submitRun` / `command` / `releaseOwner` / `releaseRun` / `listWorkers` / `stopWorker` / `detectEnv` / `installCli` + 文件操作。寻址单位是 run / owner / host,没有 workerId——worker 是 Host 内部现场。按 execution / upstream-binding / owner-lifecycle / environment / workspace-data / diagnostics 角色 token 注入；`setUpstream` 只属于启动期 binding，消费者不能越面调用。
_Avoid_: WorkerManagerService（已删）、Runtime 接口（旧名）

**RuntimeHostAdapter**:
`RuntimeHostContract` 的 server 侧实现（internal provider,不 export）。builtin Host 走进程内调用；registered Host 经隧道 RPC 转发。按 `runtimeHostId` 路由到正确的 Host。

**执行边界**:
`RuntimeHostService` 是模块根门面，负责鉴权、注册数据和用例编排；CLI/环境统一下调 environment，目录/文件/Git 统一下调 workspace-data，run 与 worker 动作分别经 execution / diagnostics 角色 token。`RuntimeHostAdapter` 是 builtin / registered 的唯一分流点，Service 不直接访问本机执行资源，也不自行拼 `host.*` RPC。

**WorkerKey**:
worker 池的唯一键：`${OwnerKey}#${runtimeType}`。同一 (owner, runtimeType) 至多一个活跃 worker。stopWorker / fence 全部用它。
_Avoid_: WorkerInstance（旧词）、ownerId 裸用（多 runtimeType 下撞车）

**OwnerKey**:
worker 复用的 owner 键：`workspace:${workspaceId}`（workspace scope）或 `user:${userId}`（user scope）。releaseOwner 据此清理 worker。
_Avoid_: Tenant、account

**Admin 观测面**:
`AdminWorkerController`（`/admin/runtime-hosts/workers/*`）——contract 现场查询（`listWorkers` / `stopWorker`），不读库。
_Avoid_: Managed Runtime（旧词）、managed-native/managed-docker/managed-opensandbox（旧假行，已合并）
