# Worker Runtime (packages/worker)

worker 常驻进程与 runner 单次执行单元之间的边界:谁跟 Host 通信、谁跑 agent、谁有自己的入口。

## Language

**Worker**:
常驻进程,注册后长期存活,持有与所属 Runtime Host 的全部数据面通信(register、command 长轮询、心跳)与 runner 的生死管理(spawn / IPC 桥接 / 退出回收)。不直连 server 控制面,不跑 agent 本身。
_Avoid_: Runner、agent process

**Runner**:
单次 run 的独立执行单元,由 worker fork 出、跑完一次 agent 就退出。有自己的物理入口文件,不与 worker(或 apps/runtime 里的 manager)共享入口——不靠运行时环境变量在同一份入口代码里分派角色。全程只经 IPC channel 和父进程(worker)通信,不直连 Host 或 server。
_Avoid_: Worker instance、agent process、runner script（弱化了它是独立入口这件事）

**Runner env allowlist**:
fork runner 时显式传入的环境变量集合:OS 基础环境(`PATH`/`HOME` 等,供 runner 内部 fork 的 agent CLI 子进程使用)+ runner 真正读取的少数 `AGEWORK_WORKER_*` 变量(`AGEWORK_WORKER_RUN_ID`、日志相关几个)+显式插件清单 `AGEWORK_AGENT_PLUGINS`。明确排除 worker 自己连接 Host 的地址与认证凭据(`AGEWORK_WORKER_API_BASE`、`AGEWORK_WORKER_START_TOKEN`)——runner 不需要也不应该拿到。取代此前 fork 时整份 spread `process.env` 的做法。
_Avoid_: 全量继承、`...process.env`

**Agent plugin boundary**:
Worker/Runner 只依赖 `@agework/agent-sdk` 的 `AgentDriver` 与 `AgentPlugin` 契约。Claude/Codex 由 `@agework/adapters/plugin` 聚合，ACP 由 `@agework/agent-acp` 提供；两者都是随发行版携带、经标准注册表装配的 bundled plugin。外部插件通过 `AGEWORK_AGENT_PLUGINS` 显式加载，不做隐式扫描。
_Avoid_: Worker 直接 import 具体 Adapter class、按 `agentType` 写实现分支
