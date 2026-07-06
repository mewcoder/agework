# Runtime

server 管理 agent CLI 运行环境的注册、存储与调度入口。Runtime 是 worker 运行的载体——local 直接 fork 进程，docker/opensandbox 起容器。这里 runtime 是主概念，worker 在它上面跑。

## Language

**Runtime**:
一个可运行 worker 的环境实例。builtin（本机 in-process，固定 id）或 registered（远程机器注册，配对 token 鉴权）。runtime 上报能力矩阵（隔离档）和环境配置（envConfig），server 负责存储和展示，不做本机检测。
_Avoid_: Carrier、engine、host

**EnvConfig**:
Runtime manager 启动时检测本机 agent CLI（路径/版本/认证状态）后上报的结果。server 只存不测。local 类型 run 启动时从此字段提取 CLI 路径写入 RunConfig；container 类型不经此链路（镜像固定路径）。
_Avoid_: CLI status（泛指时）、environment config

**EnvConfigOverride**:
管理员手动覆盖的 CLI 路径，与 EnvConfig 独立存储。per-runtime per-agent 粒度。解析优先级：override > detected > null。清空 override 自动回退到 detected。
_Avoid_: Custom config、manual path

**Source**:
resolved CLI path 的来源标记，实时派生不持久化。`"system"` = runtime 自动检测，`"custom"` = 管理员覆盖。resolvedPath 为 null 即没找到。与 `AgentProviderConfig.source`（凭证来源）同名不同义。
_Avoid_: Origin、provider

**CliResolver**:
Runtime manager 侧的检测能力（`apps/runtime`）：已知位置搜索 + `--version` 取版本 + 认证文件检查。注册时全量检测一次，之后 admin 可通过隧道 RPC 触发重检。
_Avoid_: CliDetector、CliFinder

**系统环境可用性**:
用户能否选"系统环境"模型选项。两层 AND：admin 全局开关 AND workspace 绑定 runtime 的 envConfig 里对应 agent 的 `executablePath != null && authAvailable`。server 不做本机检测。
_Avoid_: CLI availability、system status
