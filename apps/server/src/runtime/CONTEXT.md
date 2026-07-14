# Runtime

server 管理 RuntimeHost 的注册、存储与调度入口。RuntimeHost 是 worker 运行的载体——builtin（本机 in-process）或 registered（远程机器注册）。

控制隧道只承载 `host.*` 契约；旧 `LocalRuntime` / `RemoteRuntime`、`runtime.*` RPC
和 registered `Launcher` 已删除。worker 生命周期由 `RuntimeHost` 内部按 `runtimeType`
选择 provider。

## Language

**RuntimeHost**:
一个可运行 worker 的执行节点。builtin（本机 in-process，固定 id `"builtin"`）或 registered（远程机器注册，配对 token 鉴权）。RuntimeHost 上报能力矩阵（`capabilities` JSON，以 `runtimeType` 为 key，值包含 `available` 和 `scopes`）和环境配置（`envConfig`），server 负责存储和展示。
_Avoid_: Runtime（旧模型名，Phase 3 改名 RuntimeHost）、Carrier、engine

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
server 进程内的 RuntimeHost 实例。固定 id `"builtin"`，`source: "builtin"`。自管 WorkerHttpServer，worker 数据面不再连 server 旧端点。所有 runtimeType（native/docker/opensandbox）共用一行，能力矩阵在 `capabilities` JSON 里。
_Avoid_: Managed Runtime（旧词）、managed-native/managed-docker/managed-opensandbox（旧假行，已合并）
