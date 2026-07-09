# Runtime / Worker 角色与通信顶层重设计

> 状态:初稿 v2(待确认)。本文件是 `runtime-redesign` effort 的核心设计文档。
> 立场演进:最初选「根本重设计」→ grilling 中定「路 A(完全对称,builtin 也起进程)」→ review 发现路 A 给最高频的 native 强加进程崩溃监控负担(B1),且为对称牺牲 wm-0005 已验证的直读性能。最终定调**混合方案**:managed native(本机非容器)留 server 进程内(直读,简单),managed docker/opensandbox + registered 起独立 runtime 进程(隧道 RPC)。不对称有物理根据(文件位置不同),不为对称性给 native 加负担。
> 与现有 ADR 的关系清单见文末。

## 0. 诉求与现状诊断

### 0.1 用户诉求

1. 多 runtime:本地(local / docker)+ 远程链接其他机器。
2. 能力:文件/目录查看、git diff 管理(含写操作)。
3. 痛点:能力归属不清(LocalRuntime 越权替 docker/opensandbox 干活)、一行一类型机器没抽象、注册机制不好、runtime worker 角色能力与通信要重新规划。

### 0.2 现状(基于 ADR + 代码探索)

| 维度 | 现状 | 出处 |
|---|---|---|
| 主概念 | worker 为主,runtime 无状态载体 | wm-0001 |
| 载体生命周期 | start/stop/destroy,stop 留载体/destroy 删载体 | wm-0002 |
| 防重 key | `Worker.ownerId @unique`(裸)→ 一 owner 一活跃 worker | wm-0003 |
| workspace 绑定 | `WorkerWorkspaceBinding.workspaceId @unique` → 一 workspace 一 worker | schema.prisma:274 |
| 文件预览 | builtin 直读 / registered 走 worker 代理 | wm-0004/0005 |
| git diff | builtin local 直读;**registered 未支持** | runtime.service.ts:326 |
| runtime provider | packages/providers 扩展点包,local/docker/opensandbox | providers-0001 |
| 进程拓扑(不对称) | builtin provider 在 server 进程内;registered 走 apps/runtime 进程 WS 连接 | main.ts:11-21 |
| builtin 多类型 | server 启动按 runtimeType upsert 多个 builtin 行,全路由到同一 LocalRuntime 实例 | runtime.service.ts:54-66 |
| 能力归属(裂缝) | listFiles/readFile/listChangedFiles/readFileDiff 硬编码调 this.localRuntime,不分 runtimeType | runtime.service.ts:291-346 |
| 隔离级别 | local: workspace 级;docker/opensandbox: user/workspace 两级 | runtime.service.ts:442, tunnel.ts:36 |
| 通信 | server↔worker HTTP 长轮询;server↔runtime 进程 WS 隧道 JSON-RPC | packages/shared/protocol |
| 同机多 agent | worker 内 fork 多 runner,按 runId 路由(已支持) | runner-manager.ts:51 |

### 0.3 真正的缺口

1. **能力归属不清**:LocalRuntime 越权替 docker/opensandbox 干文件/git 的活——因为 docker/opensandbox 没有独立执行点,能力无处归属只能塞进 LocalRuntime。
2. **跨 workspace 并行撑不住**:wm-0003 的「一 owner 一活跃 worker」+ 绑定唯一约束,使同一 owner 无法同时在两个 workspace 跑 agent。
3. **registered 能力不完整**:远程机器的 git diff 没做;文件能力走 worker 代理(慢,且要 worker 在线)。
4. **注册机制语义模糊**:「注册一台机器实例」vs「注册一种 provider 类型」没显式区分。

## 1. 设计立场:混合方案

核心决策:**按 runtimeType 分治进程拓扑**。

- **managed native**(本机 + 非容器 fork):**留 server 进程内**,server 直接 fork worker。无独立载体,无进程崩溃问题。文件/git 能力 server 直读本机硬盘(wm-0005 已验证,10-50ms)。
- **managed docker/opensandbox**(本机 + 容器):**起独立 runtime 进程**,管容器(docker run / 沙箱 API)。文件/git 能力经隧道 RPC(loopback)调该进程。
- **registered**(远程):**独立 runtime 进程**(现状),WS 连 server。文件/git 能力经隧道 RPC 调远程进程。

**为什么不追求完全对称(否定路 A)**:路 A 让 managed native 也起独立进程,但 native 本质是 fork 子进程,没有容器/环境要管,起独立进程纯为对称,还要付进程崩溃监控代价(B1:进程崩了孤儿 worker 没人杀)。native 是最高频类型,不该为对称性强加负担。

**为什么不对称可接受**:不对称的根源是**文件物理位置不同**——native 的文件就在 server 本机硬盘,直读最快;容器/远程的文件 server 碰不到,必须走 RPC。这是物理事实,不是设计缺陷。硬对称等于给 native 强加它不需要的间接层,推翻 wm-0005 已验证的快路径。

## 2. 主概念与职责归属

### 2.0 术语定义(钉死歧义)

本设计用以下术语,后文统一引用,不再混用:

| 术语 | 定义 | 标识 |
|---|---|---|
| **runtime** | 一台机器 + 一种 runtime 类型,Runtime 表一行。按 `source` 分 managed(本机)/ registered(远程)。 | `Runtime.id` |
| **worker** | server 管理的常驻执行单元,Worker 表一行,被 server 观测存活(心跳/fence)。一个 worker = 一个物理形态(native=进程 / docker=容器 / opensandbox=沙箱)。**不叫「worker 实例」**(「实例」二字多余,worker 就是 worker)。 | `Worker.id` = **workerId**(协议身份) |
| **runner** | worker 内 fork 的 run-scoped 子进程,跑一个 agent adapter。跑完即退。一个 worker 可同时多个 runner(按 runId 路由)。 | — |
| **instanceId** | **物理载体标识**,provider.start 返回(进程 pid / 容器 id / 沙箱 id)。**不当 worker 身份用**——worker 的逻辑身份是 `Worker.id`(workerId),instanceId 只是物理形态的运行时句柄,供 provider 内部 stop/destroy 用。 | `Worker.instanceId` |

**砍掉的词**:
- ~~「worker 实例」~~ → 统一叫 **worker**(Worker 表一行就是 worker,不分「worker」和「worker 实例」两层)。
- ~~「载体」~~ → 不用这个中间词。直接说 worker 的**物理形态**(native=进程 / docker=容器 / opensandbox=沙箱)。wm-0001 的「runtime 无状态载体」在本设计里不再作为独立概念——worker 就是物理形态本身,worker 死即拆(native 杀进程 / docker 删容器 / opensandbox 删沙箱)。

**三层关系**:
```
runtime(机器 + 类型,Runtime 表行)
  └─ 可跑多个 worker(按 ownerId + isolationScope 区分)
       └─ 一个 worker = 一个物理形态(进程/容器/沙箱)
            └─ fork 多个 runner(run-scoped,跑 agent)
```

### 2.1 主概念

| 概念 | 定义 | 状态 |
|---|---|---|
| **Runtime** | 一台机器 + 一种 runtime 类型,按 `source` 分 managed(本机)/ registered(远程)。managed native 留 server 进程内;managed docker/opensandbox + registered 起独立 runtime 进程。 | 沿用现状 runtime 行,**进程拓扑按 runtimeType 分治** |
| **Worker** | server 管理的常驻执行单元,被 server 观测存活。一个 worker 可 fork 多个 runner。 | 主概念,沿用 wm-0001 |
| **Runner** | worker 内 fork 的子进程,跑一个 agent adapter | 沿用 |
| **RuntimeProvider** | packages/providers 扩展点,native/docker/opensandbox 的 start/stop/destroy 实现 | 沿用 providers-0001。native provider 留 server 进程内;docker/opensandbox provider 迁到 runtime 进程 |

**命名说明**:不引入 `host`/`manager`/`machine` 概念——runtime 自己表达机器+类型。`LocalRuntime` 类保留,但职责收窄到「只服务 managed native」(直读本机 fs/git),不再越权替 docker/opensandbox 干活。

### 2.2 runtime 字段定义(命名定稿)

runtime 行两个正交字段:

| 字段 | 取值 | 编码什么 |
|---|---|---|
| `source` | `managed` / `registered` | 进程谁管(managed=server 管,兼本机;registered=外部自部署,兼远程) |
| `runtimeType` | `native` / `docker` / `opensandbox` | 隔离机制(native=非容器 fork;docker=容器;opensandbox=沙箱) |

**去重**:现状 `local` 一词重载(非容器化 vs 本机)。定稿后非容器化叫 `native`;「本机」由 `source=managed` 兼带。`local/remote` 只在口语描述位置时用,不进数据模型。

**迁移对照**(新环境,不处理历史数据):
- `source: "builtin"` → `source: "managed"`
- `runtimeType: "local"` → `runtimeType: "native"`
- `runtimeType: "docker"` / `"opensandbox"` → 不变
- builtin 行固定 id `builtin-local` → `managed-native`(新环境直接用新 id,无历史外键悬空问题)

**② 预留**(本期不做也不留字段):`source=managed` 但机器在远程(server 经 SSH/agent 管远程进程生死)。本期 `source=managed` 隐含本机;真做 ② 时加 `location` 字段拆位置。

### 2.3 职责归属表

| 职责 | 归属 | 说明 |
|---|---|---|
| 机器注册与发现 | Runtime + RuntimeService | managed native/docker:server 启动 upsert;registered:进程 WS 连接上报 |
| 执行环境拉起与拆除 | native: server 进程内 provider;docker/opensandbox/registered: runtime 进程内 provider | native 直接 fork;其余经隧道 RPC 触发 |
| agent 运行单元 | Worker → Runner | worker 常驻,每个 run fork 一个 runner 跑 adapter |
| 机器级能力(文件/git/环境) | native: server 直读;docker/opensandbox/registered: runtime 进程经隧道 RPC | native 文件在本机硬盘直读;其余文件在容器/远程,走 RPC |
| agent 级能力(run/AG-UI) | Worker(经 Runner) | 命令按 runId 路由到 runner |
| 通信端点(命令/事件) | Worker | HTTP 长轮询下行 + POST 上行(沿用) |
| 通信端点(机器级能力 RPC + lifecycle) | docker/opensandbox/registered 的 runtime 进程 | WS 隧道 JSON-RPC(native 不需要,留进程内) |

**关键变化**:LocalRuntime 职责收窄到只服务 native(直读);docker/opensandbox 的能力从「塞进 LocalRuntime」改为「各自 runtime 进程执行」。LocalRuntime 越权问题解决,但 LocalRuntime 类不消失。

## 3. 并行与载体模型

> 本节区分「沿用现状」(机制本身没问题,不改)与「改动」(本次重设计的增量)。并行/隔离机制沿用现状;唯一改动是破 wm-0003 让跨 workspace 并行能跑。

### 3.1 沿用现状:同 workspace 多 agent

一个 worker 进程内 fork 多个 runner,每个 runner 跑一个 agent,命令按 runId 路由给对应 runner。**现状已支持,不改。**(runner-manager.ts:51)

### 3.2 沿用现状:隔离级别

沙箱两种隔离级别,每种一个 worker:

- **workspace 级**:每个 workspace 一个 worker(isolationScope = workspaceId)
- **user 级**:同一个用户共享一个 worker(isolationScope = userId)

native 只有 workspace 级;docker/opensandbox 有 user/workspace 两级(runtime.service.ts:442)。**现状如此,不改。** 不引入 isolationMode 等新维度(v1 曾误造,已砍)。

### 3.3 改动:破 wm-0003,让跨 workspace 并行能跑

**现状问题**:wm-0003 的 `Worker.ownerId @unique`(裸)+ `WorkerWorkspaceBinding.workspaceId @unique`,使同一 owner 无法同时在两个 workspace 跑 agent——防重 key 是裸 ownerId,一个 owner 只能有一个活跃 worker。

**改动**:防重 key 从裸 `ownerId` 升级为 **`(ownerId, runtimeId, isolationScope) @@unique`**。

- 不同 workspace → isolationScope(workspaceId)不同 → 不撞,允许跨 workspace 并行
- 跨机器 → runtimeId 不同 → 不撞,允许跨多台机器
- 同一 (owner, runtime, isolationScope) → 仍唯一

**协议级代价**:wm-0003 原文警告「整条控制面协议 key 都用裸 ownerId」。但见 §5.3——协议身份改用 workerId 后,协议层不再用复合 key 路由(用 workerId),复合 key 只在 DB 防重 + 复用缓存,改动可控,不需要把所有端点路径改成三列复合。

## 4. runtime 模型与注册机制

### 4.1 runtime 进程定位(按 runtimeType 分治)

- **managed native**:留 server 进程内,server 直接 fork worker。不起独立 runtime 进程。文件/git server 直读。
- **managed docker/opensandbox**:server 启动时 fork 独立 runtime 进程(跑 apps/runtime),管容器。注入 loopback 地址 + managed token。文件/git 经 loopback 隧道 RPC。
- **registered**:远程机器跑 apps/runtime 进程,配置 server 地址 + token,WS 连接。文件/git 经远程隧道 RPC。

对称性:managed docker/opensandbox 与 registered 完全同构(都是独立 runtime 进程 + 隧道 RPC);managed native 是特例(留进程内,因为无容器)。

### 4.2 注册机制

显式区分两个概念:

| 概念 | 是什么 | 在哪 |
|---|---|---|
| **provider 类型** | native/docker/opensandbox,编译期扩展点 | packages/providers(`SUPPORTED_RUNTIME_TYPES`) |
| **runtime** | 一个 runtime(一种类型、一台机器) | Runtime 表一行 |

注册流程:
- **managed**:server 启动时按 allowedRuntimeTypes upsert runtime 行。native 不需要 token(留进程内);docker/opensandbox fork runtime 进程时注入 managed token(预生成存库,runtime 行 tokenHash 非空)。
- **registered**:admin `POST /runtimes/create` → 生成 runtime 行 + 配对 token(sha256 存库)→ 远程部署 apps/runtime → WS 连 `/runtimes/tunnel` → Bearer 鉴权 → 发 `register` 上报 runtimeType/capabilities/envConfig → `markRegistered` + status=online。

### 4.3 隧道粒度与判死

- **managed native**:无隧道(留进程内),worker exit 由 server 进程内 onWorkerExit 回调直接处理(现状,无崩溃问题)。
- **managed docker/opensandbox**:一条 loopback WS 隧道 = 一个 runtime 进程。隧道健康 = runtime 进程健康。**进程崩溃处理(B1)**:server fork 时记 runtime 进程 pid,监听 exit;崩了自动重启,重启后重连 + 清理孤儿 worker(见 §5.7)。
- **registered**:一条远程 WS 隧道 = 一个 runtime 进程。隧道断连 = 判死(进失联宽限,后 fence 收尾)——远程机器可能真没了,判死合理。

**断连语义分治**(修正 v1 的 B2):managed docker/opensandbox 的隧道断连,优先视为「进程重启中」(等重连,不立刻判死);registered 的隧道断连,视为「机器可能失联」(进宽限判死)。两种 source 断连语义不同,因为进程归属不同。

## 5. 通信协议

### 5.1 两层通道

| 通道 | 传输 | 对象 | 用途 |
|---|---|---|
| 控制面 | WS 隧道(JSON-RPC) | docker/opensandbox/registered 的 runtime 进程 | launch/stop/destroy + register/heartbeat + 机器级能力 RPC |
| 数据面 | HTTP 长轮询 + POST | worker(所有类型) | 命令下行 + 事件上行 |
| 进程内直调 | 同进程函数调用 | managed native | server 直接调 LocalRuntime(provider + 文件/git) |

managed native 不经隧道,走进程内直调(最快);其余走隧道 RPC。

### 5.2 机器级能力归属(精确化 wm-0005)

| runtime | 文件/git/环境能力 | 通道 |
|---|---|---|
| managed native | server 直读本机硬盘 | 进程内直调(LocalRuntime) |
| managed docker/opensandbox | runtime 进程在容器/本机执行 | loopback 隧道 RPC |
| registered | runtime 进程在远程机执行 | 远程隧道 RPC |

**与 wm-0005 关系**:wm-0005 原本「builtin 直读 / registered 走 worker」,精确化为「managed native 直读 / 容器+registered 走隧道 RPC」。native 直读保留(wm-0005 已验证 10-50ms);registered 从「走 worker 代理」改为「走隧道 RPC」(不用拉起 worker,manager 在线即可);docker/opensandbox 新增隧道 RPC(原本塞进 LocalRuntime,现归各自进程)。

**wm-0004 的文件通道**:registered 文件能力从「worker 独立 owner-scoped 通道」改为「隧道 RPC」。wm-0004 的 seq/expiresAt/去重机制在隧道 RPC 侧是否需要,见 §5.4。

### 5.3 协议身份:用 workerId(破 wm-0003)

**现状问题**:ownerId 是为「同 owner 复用容器」而生(`WorkerProvisioner.owners = Map<ownerId, OwnerInstance>`,provisioner.ts:37),身兼复用 key + 协议路由 key,逼出 wm-0003。

**改用 workerId**:协议身份用 `Worker.id` 主键(launch 时预生成,worker 回连携带)。三层 key 分工:

| 层 | key | 用途 |
|---|---|---|
| 协议身份(端点/Store) | workerId | poll/心跳/握手/命令路由 |
| 复用缓存(provisioner.owners) | (ownerId, runtimeId, isolationScope) | 同组合复用同一 worker |
| DB 防重 | (ownerId, runtimeId, isolationScope) @@unique | 防重复 launch |

ownerId 退回纯业务字段。wm-0003「一 owner 一活跃 worker」自然推翻——协议层不再有此限制,防重靠 DB 复合约束。

**workerId 来源**:launch 时 server 预生成 workerId 写入 `Worker.id`(provisioner.ts:82 现状已 `randomUUID()` 传给 insertStarting,路 A 后明确为 Worker.id),worker 回连时携带。`instanceId`(provider 侧运行实例标识:pid/容器id)保留给 provider 内部,不进协议层。

### 5.4 推翻 wm-0004 后的投递语义

文件能力改走隧道 RPC(registered/docker/opensandbox)后,wm-0004 的 owner-scoped 文件通道(`WorkspaceFileCommandStore`/`sendFileCommand`/`waitForFileCommandResult`)退役。隧道 RPC 是同步 request/response,无队列重放,故 wm-0004 的 seq 计数器/expiresAt/processedCommands 去重在文件能力侧不再需要。

**但写操作幂等性仍需回答**:discard_file_change 等写操作,隧道 RPC 同步执行,runtime 进程崩在执行中途时是否有半完成状态。落地时定:写操作需幂等(同一 discard 重复执行安全)或带状态确认。native 的写操作走进程内直调,无重放问题。

**数据面 run 命令通道**(cancel/interrupt 等)的 seq 计数器:身份改 workerId 后,owner 级 seq 改 worker 级 seq。冷启动重放语义沿用 wm-0004(processedCommands 去重 Set 挡同进程内重复,跨重启靠 expiresAt)。

### 5.5 隧道 RPC 方法集(docker/opensandbox/registered 的 runtime 进程侧)

| 方法 | 用途 |
|---|---|
| `launch` / `stop` / `destroy` | worker 载体生命周期 |
| `detect-env` | 检测 CLI 环境 |
| `list-files` / `read-file` | 文件预览 |
| `list-changed-files` / `read-file-diff` | git diff |
| `list-directory` / `create-directory` | 目录浏览/新建 |

现状 tunnel.ts 已有 launch/stop/destroy/detect-env/list-dir/create-dir;新增 list-files/read-file/list-changed-files/read-file-diff。managed docker/opensandbox 与 registered 同集同语义。native 不经隧道(进程内直调)。

### 5.6 远程执行拓扑

**registered 现状(已是目标拓扑)**:runtime 进程收到 `runtime.launch` RPC → 调 provider.start fork worker → worker fork runner 跑 agent(tunnel.ts:174 → launcher.ts:45 → local-runtime.provider.ts:36)。拓扑:`runtime 进程 → fork worker → fork runner`。

**managed docker/opensandbox**:同 registered 拓扑,只是连本机 loopback。同一份 apps/runtime 产物。

**managed native**:留 server 进程内,server 直接 fork worker → fork runner。无中间 runtime 进程。

**产物**:managed docker/opensandbox 与 registered 用同一份 apps/runtime 产物;native 用 server 进程内 provider(现状)。

### 5.7 managed 容器 runtime 进程的崩溃恢复(B1)

managed docker/opensandbox 的 runtime 进程是 server fork 的独立进程,会崩。处理:

- **supervisor**:server fork 时记 runtime 进程 pid,监听 exit 事件。崩了自动重启 runtime 进程,重启后它重新连 server(loopback 隧道)。
- **孤儿 worker**:runtime 进程崩时它 fork 的 worker 可能成孤儿。重启后的 runtime 进程负责清理(它知道自己的 worker pid);或 server 保留按 pid 兜底杀孤儿的能力(destroy 的孤儿清理不完全迁出 server)。
- **不立刻判死**:隧道断连时,优先视为「进程重启中」,等重连宽限;超时未重连才判死(与 registered 的「断连即判死」区分,见 §4.3)。

registered 不需要 supervisor(远程机器不是 server 管的),断连走判死 + fence。

## 6. 能力归属通用判据

### 6.1 判据:按「文件物理位置 + 是否需要 agent 运行时」分

| 能力类型 | 判据 | 归属 | 例子 |
|---|---|---|---|
| 机器级能力(文件在 server 本机) | native,文件在 server 硬盘 | server 直读(LocalRuntime) | managed native 的文件/git |
| 机器级能力(文件在容器/远程) | docker/opensandbox/registered,server 碰不到 | runtime 进程经隧道 RPC | 容器/远程的文件/git |
| agent 级能力 | 需要 agent 运行时 | Worker(经 Runner) | run 执行、AG-UI 事件 |

### 6.2 这精确化了 wm-0005

wm-0005「builtin 直读 / registered 走 worker」→「managed native 直读 / 容器+registered 走隧道 RPC」。native 直读保留(快);registered 从 worker 代理改隧道 RPC(不用拉起 worker);docker/opensandbox 新增隧道 RPC(归各自进程)。

### 6.3 写操作

discard_file_change 等写操作,按文件位置同上归属。安全校验(路径越界/symlink/大小)提取到 `@agework/shared/filesystem`,native 直读与 runtime 进程 RPC 共用。写操作幂等性见 §5.4。

## 7. 数据模型变更

| 表 | 变更 | 理由 |
|---|---|---|
| `Worker` | `ownerId @unique` → `(ownerId, runtimeId, isolationScope) @@unique` | 破 wm-0003,支持跨 workspace/跨机并行 |
| `Runtime` | source 值 builtin→managed;runtimeType 值 local→native;docker/opensandbox 的 managed 行加 tokenHash(非空) | 命名 + docker/opensandbox 走隧道需 token |
| `WorkerWorkspaceBinding` | 不变(workspaceId @unique 保留) | 不引入 isolationMode,同 workspace 仍一 worker |
| `Run` | runtimeInstanceId 语义不变 | — |

新环境部署,不处理历史数据迁移(builtin-local → managed-native 等 id 改名无悬空外键问题)。

## 8. 模块边界变更

| 模块 | 变更 |
|---|---|
| `apps/server/src/runtime` | RuntimeService 按 runtimeType 分治:native 走进程内 LocalRuntime;docker/opensandbox/registered 走隧道 RPC。LocalRuntime 保留但收窄到 native。 |
| `apps/server/src/worker-manager` | 协议身份 ownerId→workerId(Store/端点/Dispatcher);provisioner.owners 复用 key 改复合;registered/docker 文件通道(sendFileCommand 等)退役改隧道 RPC;native 文件仍可走进程内直读(不经 worker) |
| `packages/providers` | 契约不变;native provider 留 server 进程内;docker/opensandbox provider 迁到 runtime 进程。包仍是叶子,不 import @agework/worker,worker 入口经 config 注入(launcher.ts:92 现状即此模式) |
| `packages/worker` | WorkspaceFileCommandHandler 仅 registered/docker 文件走 worker 时需要——但 §5.2 改隧道 RPC 后退役。runner 入口不变 |
| `apps/runtime` | 补全机器级能力 RPC(list-files/read-file/list-changed-files/read-file-diff);managed docker/opensandbox 复用同一产物,由 server fork + loopback |
| `packages/shared` | workerId 协议身份类型;机器级能力 RPC 方法集类型;filesystem 安全纯函数(native 直读与 runtime 进程共用) |
| `apps/server` 新增 | managed 容器 runtime 进程的 supervisor(fork + 监听 exit + 重启),见 §5.7 |

## 9. 与现有 ADR 的关系

| ADR | 关系 | 说明 |
|---|---|---|
| wm-0001(worker 为主 / 载荷不变量) | **保留** | 不预热空闲池,worker 死即拆载体。主概念不变。 |
| wm-0002(start/stop/destroy) | **保留** | provider 契约不变。native 的 stop=destroy=杀进程(无独立载体,wm-0002 已述);docker/opensandbox 的 stop 留容器归 runtime 进程管。 |
| wm-0003(防重键维持裸 ownerId) | **推翻** | 协议身份改 workerId;复用 key 改 (ownerId, runtimeId, isolationScope);DB 防重改复合 @@unique。ownerId 退回业务字段。 |
| wm-0004(文件命令走独立 owner-scoped 通道) | **部分推翻** | registered/docker 文件能力改走隧道 RPC,wm-0004 的 worker 文件通道退役;但数据面 run 命令通道 + seq/expiresAt 语义保留(身份改 workerId)。 |
| wm-0005(builtin 直读 / registered 走 worker) | **保留+精确化** | builtin→managed native 直读(保留);registered 从 worker 代理改隧道 RPC;docker/opensandbox 新增隧道 RPC。 |
| runtime-0001(只软删除 + runtimeId 必填) | **保留** | runtimeId 必填支撑复用 key/防重的 runtimeId 维度。 |
| runtime-0002(envConfig 两层分离) | **保留** | — |
| runtime-0003(CliResolver 放 apps/runtime) | **保留** | runtime 进程即 apps/runtime,docker/opensandbox 检测归它;native 留 server 进程内(现状 LocalRuntime.detectEnv)。 |
| runtime-0004(container CLI 路径走 env) | **保留** | — |
| providers-0001(runtime provider 扩展点包) | **保留** | 包仍是叶子,消费者从 server 部分迁到 runtime 进程(docker/opensandbox),config 注入路径不变。 |
| apps/runtime-0001(SDK external + npm install) | **保留** | managed docker/opensandbox 与 registered 共用同一产物。 |
| packages/worker-0001(runner 独立入口) | **保留** | — |

**命名迁移**:`source: builtin→managed`、`runtimeType: local→native`。`location` 字段本期不引入,② 真做时再加。

## 10. 未决(留待后续 ticket)

- **managed 容器 runtime 进程 supervisor 细节**:fork 监听 exit 的具体实现、重启策略(立即/退避)、孤儿 worker 清理的 pid 兜底边界。机制已定(§5.7),实现细节留落地。
- **写操作幂等性**:discard_file_change 等写操作在隧道 RPC 中途崩溃的幂等设计。归属已定,幂等方案留落地。
- **能力 RPC 协议类型细化**:机器级能力 RPC 的请求/响应类型、错误码。方法集已定(§5.5),类型细节留落地。
- **worker 侧改动面**:协议身份改 workerId 后,worker 侧 poll/register/handshake 读 env 的代码改动量评估。