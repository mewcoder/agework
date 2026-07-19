# Server · Runtime Host · Worker 目标架构（理想态定案）

> 状态：已落地（2026-07-14）：三期迁移全部完成并通过出口判据验收（词汇 grep 清零、run/runtime 模块无 P0/P1）；registered Host 多 runtimeType 能力已收口（daemon `--runtime native,docker` 多值 + 启动时按类型探测可用性上报）。
> 本文是三层关系的重新设计：**server 只管业务事实，Runtime Host 独占执行面，worker 是唯一的执行代理概念**。
> 它有意推翻若干既有定案（见 §6 翻案清单），实施按 §7 三期迁移推进。

## 1. 一句话

Server 把 Runtime Host 当成一个黑盒执行服务：**提交 run 进去，事件流出来**。
Worker、容器、复用范围、池化、握手、心跳判死——这些全部是 Runtime Host 的内部实现，
server 的代码和数据库里不再出现。

## 2. 现状为什么乱（诊断摘要）

现状的依赖方向本身是干净的（`run → worker-manager → runtime → providers`，无环），
乱在四件事叠加：

1. **server 亲自管执行面状态机**。握手（`worker-manager/connection/worker-handshake.store.ts`）、
   心跳判死（`worker-liveness.sweeper.ts`）、命令信箱（`command-queue.ts`）、
   载体去重（`worker.provisioner.ts` 的 `(ownerId, runtimeId, scope)` 键）、
   Worker 表落库（`registry/`）——runtimeType × 载体形态 × 复用范围的组合矩阵全摊在业务代码旁边。
2. **网络拓扑是拧的**。控制面走 server → runtime 进程（隧道 RPC 起停载体），
   数据面却是 worker 绕过它直连 server HTTP 长轮询（`command.controller.ts`）。
   执行节点只管"生孩子"，孩子生下来归 server 养。
3. **实现细节被抬成了领域概念**。worker 和"runtime 载体"被当成两个并列概念，再用
   `WorkerInstance` 表把它们"1:1 融合"，再发明 stop（留壳）/destroy（删壳）区分收尾——
   全是在为"两个概念指向一个实体"打补丁。native 没有容器，还要在表里塞
   `scope` 占位值。
4. **一词三义**。"runtime" 同时指机器注册行、载体外壳、worker/runner 进程；
   两份 CONTEXT.md 对 runtime/worker 的主从关系定义相反
   （`runtime/CONTEXT.md:3` vs `worker-manager/CONTEXT.md:3`）。
   注册模型还在用"一类型一行"为同一台机器造三行假行
   （同一台 builtin Host 被拆成了多行）。

## 3. 理想概念模型

### 3.1 五个概念，一词一义

| 概念              | 定义                                                                                                                                                                                                                                                                                                                    | 归属                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **Run**           | 一次 agent 执行：有输入、有事件流输出、有终态。业务事实。                                                                                                                                                                                                                                                               | server                                                       |
| **Runtime Host**  | 部署在一台执行机器上的常驻执行节点。**一台机器 = 一个 Host = 一行注册 = 一条隧道**。builtin（server 本机、进程内）或 registered（远程注册）。上报能力矩阵。                                                                                                                                                             | 注册表在 server，执行面在 Host                               |
| **Worker**        | Host 上的一个**隔离执行代理**：一个常驻进程，接命令、fork runner、回事件。                                                                                                                                                                                                                                              | Host 内部                                                    |
| **Scope / Owner** | worker 的服务范围，一体两面：对用户是**独享/共享承诺**（`workspace`=项目独享环境，`user`=同用户项目共享），对 Host 是**复用粒度**（worker 池键的粗细）。owner 键 = `workspace:X` 或 `user:Y`。安全隔离强度只由 runtimeType 决定——native 下的"独享"是进程与复用边界、不是安全边界；"边界圈住谁"由 scope 决定，两者正交。 | workspace 上存 scope（创建时定死），owner 键由 Host 计算使用 |
| **Runner**        | worker 为每个 run fork 的执行子进程，内跑 adapter，run 结束即退出。                                                                                                                                                                                                                                                     | Host 内部                                                    |

配置维度（不是实体）：**runtimeType（运行方式）**，值如 `native` / `docker` / `opensandbox`。
它是 workspace 创建时从 Host 能力列表里选的一项配置；裸词 "runtime" 只用于
Runtime Host，不再指代机器、载体和 worker 等多个概念。

### 3.2 不变量

1. **1 个 worker = 1 个隔离边界 = 1 个常驻进程，永远。**
   不存在一个容器两个 worker，也不存在一个 worker 跨两个容器。
2. **同一个 `(owner, runtimeType)` 同时至多一个活跃 worker；该键下所有 run 都路由给它。**
   这一条是"复用"的全部——workspace-scope 下多个并行 run 共享 worker、
   user-scope 下多个 workspace 共享 worker，都是同一条规则在不同 scope 值下的推论。
   scope 承诺的是复用上限而非硬凑一个 worker：不同 runtimeType 的 run 边界实现不同、
   物理上不可共享，所以池键带 runtimeType 段（同一用户可以同时有一个 docker worker
   和一个 opensandbox worker，互不干扰）。
3. **worker 只说 Host 协议、只由 Host 的代码接待，永不进入 server 业务面。**
   registered 下对端是远程 Host daemon；builtin 下 Host 库借宿 server 进程的 HTTP 监听
   （路由/鉴权/协议全归 Host 库所有），worker 侧只是 URL 不同。谁终结 worker 连接，
   谁拥有 worker 状态机——所以连接必须终结在 Host 代码里。
4. **server 只见 Run 和 Runtime Host 两个执行相关概念**；Worker/Runner/隔离实现的运行细节对 server 不可见。
   Server 永远不知道：container id、worker pid、runner pid、docker 命令、镜像名。
   契约里出现其中任何一个，即为设计回退。
5. **每个 Host 声明能力矩阵**：提供哪些 runtimeType、各支持哪些 scope、当前是否可用。
   native 只支持 `workspace`（裸进程无安全边界）不是特例，是矩阵里的一格。
6. **runId 是全链路路由键**（server → Host → worker → runner 一路用它寻址）；
   每个 run 一条**逻辑信道**，复用物理连接（一 Host 一条隧道，按 runId 多路复用），
   runner 不独占物理连接。
7. **Host 不理解 Workspace 的业务语义。** `workspaceId` 对 Host 只是不透明的
   路由/复用/收尾键（placement 与 releaseWorkspace 携带），Host 永远不会也不能
   拿它解引用任何业务数据——与"server 不知道 container id"是对称的两句话。

### 3.3 从领域语言里删除的词

| 被删除的词                                      | 去向                                                                                    |
| ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| 容器 / 载体 / carrier / environment（领域语境） | provider 实现内部词汇。领域层只说 worker。                                              |
| stop / destroy 两种收尾语义                     | 降级为 provider 缓存策略（"要不要留容器以便下次快启动"）。领域层只有 worker 存活/消失。 |
| placement 中并列的 `scope` + `ownerId`          | 合并为 owner 键（`scope:id`）。Workspace 上只保留有业务意义的 `scope`。                 |
| native 的占位 scope                             | 删除占位语义；`workspace` 是能力矩阵约束下的真实复用范围。                              |
| `runtimeType`                                   | 保留，表示运行方式，从 Host 能力列表中选。                                              |
| 裸词 "runtime" 的其余各义                       | 只保留 Runtime Host 一个名字。                                                          |

### 3.4 层级图

```
业务面(server):  User → Workspace(绑 host + runtimeType + scope) → Conversation → Run
                          │
                          ▼  窄契约: submitRun/command ↓ ; 事件流 ↑
执行面(Host):   Runtime Host ─→ Worker(owner = workspace:X | user:Y)
                                  ├─ 隔离实现: native / docker / opensandbox  ← provider 细节
                                  └─ Runner(每 run 一个) → Adapter(claude/codex/…)
```

### 3.5 场景验证

1. **docker + workspace-scope，同一 workspace 连发两个 run**：
   run① 到达 → owner=`workspace:A` 无活跃 worker → provider 起 docker 隔离的 worker →
   fork runner①。run② 到达 → owner 命中 → 同一 worker fork runner②。两 runner 并行。
2. **opensandbox + user-scope，同一用户两个 workspace 各跑一个 run**：
   两个 run 的 owner 都是 `user:Y` → 共享一个 worker，两个 runner 在同一隔离边界内
   各自 workspace 目录下跑。
3. **native**：workspace 创建时 scope 可选项只有 `workspace`（能力矩阵约束，UI 不给别的选项）→
   provider 起裸进程 worker。与场景 1 完全同一代码路径，仅隔离实现不同。
4. **删除 workspace / 注销 user**：server 编排两步——先 cancel 目标名下活跃 run，
   再 `releaseOwner(ownerKey)`（两步均幂等、可重试；删除后的新 submit 由 placement
   校验直接拒绝）。workspace 删除调 `releaseOwner("workspace:X")`：workspace-scope
   有 worker 则收掉；user-scope 下该键无 worker，调用是幂等空操作，**共享 worker
   继续活着服务同用户其他 workspace**。user 注销/禁用调 `releaseOwner("user:Y")`
   收掉共享 worker。Host 离线时无需补偿——其 worker 走孤儿清理路径消亡。
   载体销不销毁是 provider 缓存策略。owner 模型天然覆盖全部分支，无需特判。

四个场景没有任何 if-native / if-container 的领域级分叉——分叉全部压进 provider。

## 4. 目标拓扑与契约

### 4.1 职责清单

**Server 保留：**

- Workspace / Conversation / Message / 模型凭证 / 鉴权。
- Run 行与状态**投影**：从事件流抄写状态、SSE 推前端、断线恢复。执行状态的真相在 Host。
- Runtime Host 注册表：机器列表（一机一行）、配对 token、能力矩阵、Host 级心跳与判死
  （Host 死 → 其上所有 run 判败，这是 server 仅剩的执行相关兜底）。
- 放置决策：run 提交到 workspace 绑定的那个 Host（一次查表，不是状态机），
  提交前按能力矩阵校验目标 runtimeType 当前可用。
- 选择层拍平：注册层一机一行多能力（数据对机器诚实），但 workspace 创建 UI 把
  host × 可用 runtimeType 拍平成确定条目（"我的电脑 · Docker"），**用户面前的每个
  选项都是一种明确的运行方式**，选完即锁定 `(runtimeHostId, runtimeType)`
  （产品对用户诚实）。单/多是两层各自的答案，不互相迁就。

**Server 明确不做（否定清单）：**
不起容器、不管载体、不管 worker/runner 生命周期、不调 agent SDK、不做执行机文件系统操作；
不知道 container id / worker pid / runner pid / docker 命令 / 镜像名。

**Runtime Host 独占：**

- worker 池（内存 `Map<WorkerKey, Worker>`，`WorkerKey = owner # runtimeType`，见不变量 2）、
  去重、scope 落实。池、观测、stopWorker、fence 全部用同一个 WorkerKey，不出现裸 ownerKey。
- worker 生命周期：拉起（provider 选隔离实现）、握手、心跳判死（fence）、空闲回收。
- 命令信箱与事件转发：worker 长轮询自己的 Host，事件经它回流 server。
- provider 缓存策略（留不留容器）、CLI 环境检测、能力矩阵上报。
- 执行机侧文件/Git 数据面（这些操作必须发生在执行环境所在机器）。

**Worker / Runner / Adapter：不变。**
worker 收 `user_message` fork runner，runner 跑 adapter，事件经 IPC → worker →
Host → server。唯一变化：worker 的 HTTP 对端从 server 换成 Host。
worker 不理解 User / Workspace / Conversation 等业务概念，不许演变成第二个控制平面。

### 4.2 契约草案（`packages/shared`）

一条通道，builtin 与 registered 同构——builtin 是进程内实现，registered 经既有隧道
（`packages/shared/src/protocol/runtime-tunnel.ts` 收编扩展），server 侧代码不感知差别。

```ts
/** server → Runtime Host。方向永远向下；实现方: builtin 进程内 / registered 隧道代理。 */
interface RuntimeHostContract {
  // —— 执行 ——
  /** 幂等，runId 为键。placement 由 server 按 workspace 配置算好传入。 */
  submitRun(input: SubmitRunInput): Promise<void>;
  /** cancel / resume(含答题、审批 decision) 等 run 级命令。 */
  command(runId: string, payload: RunCommandPayload): Promise<void>;

  // —— 业务级收尾（只有业务动词，没有 stopContainer 之类的基础设施动词） ——
  /** owner 级释放：workspace 删除传 workspace:X，user 注销/禁用传 user:Y。
      幂等、可重试；目标键无 worker 时为空操作（见 §3.5 场景 4）。 */
  releaseOwner(owner: OwnerKey): Promise<void>;

  // —— 环境 ——
  /** 每种 runtimeType 的可用性 + CLI 检测结果，构成能力矩阵的动态部分。 */
  detectEnv(): Promise<HostCapabilityStatus>;
  installCli(input: InstallCliInput): Promise<InstallCliResult>;

  // —— 工作空间文件（数据面统一入口，合并现状双通道） ——
  listDirectory(input: ListDirectoryInput): Promise<DirectoryListing>;
  createDirectory(input: CreateDirectoryInput): Promise<void>;
  listFiles(input: WorkspaceFileQuery): Promise<FileEntry[]>;
  readFile(input: ReadFileInput): Promise<FileContent>;
  readFileDiff(input: ReadFileDiffInput): Promise<FileDiff>;
  searchFiles(input: SearchFilesInput): Promise<FileEntry[]>;
  listChangedFiles(input: WorkspaceFileQuery): Promise<ChangedFile[]>;

  // —— 观测（admin 诊断面，显式例外，见下方要点；现场查询，不落库） ——
  listWorkers(): Promise<WorkerSnapshot[]>;
  stopWorker(key: WorkerKey): Promise<void>;
}

/** Runtime Host → server 的唯一上行流（收编现状 UpstreamMessage）。 */
interface RuntimeHostUpstream {
  emit(runId: string, message: AgUiEventMessage | RunStatusMessage): void;
  heartbeat(status: HostHeartbeat): void;
}

type OwnerKey = `workspace:${string}` | `user:${string}`;
type RuntimeType = string; // "native" | "docker" | "opensandbox"，providers 扩展点决定取值
/** 池、观测、stopWorker、fence 统一用它（不变量 2），杜绝裸 ownerKey 撞车/误停。 */
type WorkerKey = `${OwnerKey}#${RuntimeType}`;

interface SubmitRunInput {
  runId: string;
  runConfig: RunConfig; // 现有结构收编
  placement: {
    owner: OwnerKey;
    runtimeType: RuntimeType; // workspace 创建时从 Host 能力列表选定
    workspaceId: string;
    workspacePath: string;
  };
}

/** 注册/心跳上报的能力矩阵：一机多能力，可用性按 runtimeType 独立变化。 */
type HostCapabilityStatus = Record<
  RuntimeType,
  {
    available: boolean;
    reason?: string; // 如 "docker daemon not running"
    scopes: Array<"workspace" | "user">;
    cli?: AgentCliStatus; // native 才有：claude/codex 路径、版本、认证
  }
>;
```

要点：

- `run.status` / `agui.event` 已经是 provider 无关的上行模型（`run/upstream/` 现有处理保留），
  seq 去重闸门照旧——契约是**现有协议的收编，不是新发明**。
- 文件操作统一走契约，废除"RemoteRuntime 隧道文件 RPC"与"worker owner-command 文件命令"
  双通道并存（推翻 worker-manager ADR-0004/0005 的通道划分，语义保留、通道合一）。
- 审批/答题不设独立 RPC，统一走 `command` 的 resume payload（run/adr/0002 泛化定案不变）。
- `listWorkers` 是 admin 观测入口：现场问 Host，不再读 Worker 表。
- **能力不可用 ≠ Host 死**：docker daemon 停了但 native 还好使时，Host 在线、
  仅 `docker` 能力 `available: false`——只拦新 run 的放置校验，不触发判死。
- **可靠性协议**：per-run 单调 seq + **ACK 高水位** + 幂等 + 补发。ACK 的精确语义：
  上行通道回发 `ack{runId, seq}`，表示 **RunEvent 已落库的连续前缀**——有 gap 不推进
  （现状内存 seq 闸门"跳 gap 继续"的行为不能沿用为 ACK 依据）；cursor 不单独持久化，
  server 重启后从 RunEvent 表最大连续 seq 派生；落库去重靠 `(runId, seq)` 唯一索引。
  Host 只裁剪 ≤ ACK 的缓冲，重连后从 ACK+1 补发。`submitRun` 以 runId 幂等，
  受理即返回，进度全走 `run.status` 事件流（冷启动几十秒不挂 RPC）。
- **Host epoch fencing（防脑裂）**：每次隧道会话握手分配单调递增 epoch，上行消息携带之。
  run 终态一旦写入，该 run 的事件流即关闭——迟到事件不论 epoch 一律丢弃（只进 raw
  诊断日志）；被判死的旧 epoch 连接重连无效，必须以新 epoch 重新握手。
- **观测面是显式例外**：`listWorkers`/`stopWorker` 是 admin 诊断通道，WorkerSnapshot
  允许携带执行细节供排障，但只许 admin 展示消费——server 业务代码（run/workspace 编排）
  禁止读它做决策。不变量 4 约束的是业务面，不禁诊断面。
- 契约不感知底下有几条物理连接（Transport 层接缝）：当前一 Host 一条 WebSocket，
  将来控制/事件连接分离、大文件走独立 HTTP 通道都只动 transport，不动契约。

字段级决策（2026-07-12 grilling 定）：

- **RunConfig 只装业务输入**：prompt / resume payload / agent 类型与配置 / 模型凭证。
  placement 只存在于 `SubmitRunInput` 顶层，不重复进 RunConfig。log 目录、mount 路径、
  cwd、trace 配置等执行机细节全部由 Host 派生，不进契约——契约第一版就干净，
  Phase 2 搬家时不再改协议。
- **CLI 路径由 Host 合成**：server 只存并下发 admin 的 override 配置；Host 用自己
  detectEnv 的结果 + override 算出 resolved 路径，拉起 runner 时注入。现状四处摊派
  （agent.service 取 → RunConfig 塞 → worker env 拷 → runner 重解析）收敛为 Host 一处。
- **模型凭证随 submitRun 一次性下发**：作为 RunConfig 业务输入的一部分随命令流下行，
  Host/worker 内存短暂驻留、不落盘。不做回查协议；LLM 流量经 server 代理留作
  未来企业版选项，不在本设计。

### 4.3 数据归属

| 数据                                                               | 归属                                            |
| ------------------------------------------------------------------ | ----------------------------------------------- |
| RuntimeHost 注册表（**一机一行**：配对 token、能力矩阵、心跳）     | server DB                                       |
| Workspace（`runtimeHostId` + `runtimeType` + `scope`，创建时定死） | server DB                                       |
| Run / Conversation / Message                                       | server DB                                       |
| Worker 池、握手、心跳、信箱                                        | Host **内存**（不入库）                         |
| ~~Worker 表~~、~~WorkerWorkspaceBinding 表~~                       | **删除**                                        |
| ~~按类型的三行 builtin 假行~~                                      | **合并为一行** `builtin` Host，能力矩阵表达差异 |

Worker 本就是"停了就删"的瞬态台账，它入库的全部理由（ownerId 防重、startToken 握手、
admin 资源列表）都是 server 亲自管协议才需要的；协议下沉后这些是执行面的内存状态。

### 4.4 物理落点

Runtime 的实现统一住 `apps/runtime`（`@agework/runtime`），公共插件契约位于
`packages/runtime-sdk`（`@agework/runtime-sdk`），Host 暴露两个入口：

- **库入口**：builtin 场景，server 进程内直接 `new` 出 `RuntimeHostContract` 实现（进程内调用）。
- **daemon 入口**：registered 场景，远程机器跑同一套代码，主动外连 server 建隧道
  （远程部署只要求 Host → server 单向可达，容器内 worker 永不要求直连 server）。

同一实现、两种宿主。`@agework/runtime-sdk` 提供插件契约，Host 只内建 Native，Docker 作为官方 bundled plugin，
Runtime 内部 `apps/runtime/src/worker` 维持现状（只改连接对端）。
不新建 `packages/runtime-core` 之类的包（"core" 是禁用词，且没有第三个消费者）。

### 4.5 崩溃与恢复语义

- **server 重启**：**对 registered Host 完全无感**——Host 与 worker 继续跑，隧道重连后
  从 ACK 水位续传，run 状态由投影自然追平。**builtin Host 与 server 同生共死**（进程内库，
  无法幸免）：其 worker/容器成为孤儿，由重启后的 builtin Host 按 provider 标记清理——
  语义等同"Host 重启"。"重启无感"只对 registered 承诺，builtin 不承诺（代价：builtin
  容器不再跨 server 重启复用，接受，换取执行面零持久化）。现状"startToken 入库→重启
  复用"机制两种场景下都作废。
- **Host 重启**（registered 机器上）：内存 worker 池丢失。
  策略：启动时按 provider 标记（容器 label）发现孤儿并**一律 destroy**——
  孤儿 worker 关联的 run 必已被 server 的 Host 判死路径终结，没有续接价值，
  重发现-续管的复杂度不值得买。
- **worker 判死（fence）**：留在 Host，超时即判死不变；上行表现为该 worker
  名下所有 run 收到 `run.status: error(worker lost)`。server 不再持有 runId↔workerId
  索引（`owner-run.store.ts` 随协议下沉）。
- **Host 判死**：server 的 Host 级心跳 watchdog 保留，Host 超时 →
  其上所有 run 判败。这是两级判死：server 判 Host，Host 判 worker。
  合成判败是"真相与投影分离"（§5 理念一）的**唯一权威例外**——server 可产生的执行状态
  只有这一种，且一旦写入即关闭该 run 的事件流；旧执行者的迟到补发由 epoch fencing
  （§4.2 要点）拒收，防网络分区/Host 快速重启造成的脑裂。

## 5. 设计理念（本设计遵循的四条判断标准）

后续实施中遇到摇摆时，按这四条裁决：

1. **真相与投影分离。** 每类状态只有一个产生者：执行状态的真相在 Host，
   server 只做事件流的投影（抄写、展示、恢复）。任何"server 主动改执行状态"的设计都是错的；
   反过来，任何"Host 持久化业务事实"的设计也是错的。
2. **概念检验：删掉这个词，系统还能描述吗？** 能描述 = 它是实现细节，压进实现层
   （容器、environment、stop/destroy 都没通过这个检验）。不能描述 = 它是领域概念，
   必须一词一义、写进 CONTEXT.md（Run/RuntimeHost/Worker/Scope/Runner 五个词通过检验）。
3. **同构优先于特判。** builtin 和 registered 走同一契约同一实现，差别只在 transport
   （进程内 vs 隧道）；native 和容器走同一 worker 生命周期，差别只在 provider。
   出现 `if (isNative)` / `if (isBuiltin)` 的领域级分叉即视为设计回退。
4. **组合矩阵住在声明里，不住在代码里。** runtimeType × scope 的合法组合由 Host 能力矩阵声明，
   UI 和放置逻辑读矩阵做约束；不允许在流程代码里散写组合判断。

## 6. 翻案清单（本设计明确推翻的既有定案）

| 被推翻的定案                                                                                    | 替代                                                                                                                                          |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/design/runtime-workspace-worker-schema.md` 的 Worker + WorkerWorkspaceBinding 两表        | 出库，成为执行面内存状态。schema 只剩 RuntimeHost + Workspace。该文档中"防重键只能是裸 ownerId"的论证随协议整体下沉后依然成立，只是换了住址。 |
| 同文档的 Runtime "一类型一行"模型（builtin 固定三行、registered 每机每类型一行）                | **一机一行** RuntimeHost + capabilities 能力矩阵；Workspace 绑定从单个 `runtimeId` 改为 `runtimeHostId` + `runtimeType` 两字段。              |
| worker-manager ADR-0001「worker 是主概念，runtime 是载体」                                      | server 视角不再看见 worker；Host 内部 worker 仍是主概念。两份 CONTEXT.md 的主从矛盾随之消失。                                                 |
| worker-manager ADR-0002「runtime 载体收尾分 stop/destroy」                                      | 降级为 provider 缓存策略，领域层只有 worker 存活/消失。                                                                                       |
| worker-manager ADR-0004「工作空间文件命令走独立通道」/ ADR-0005「builtin 文件预览 server 直读」 | 文件操作统一收进 RuntimeHostContract 单通道；builtin 的"直读"即库入口的进程内实现，不再是特例。                                               |
| startToken 入库 → server 重启复用 sandbox 载体                                                  | server 重启不再影响执行面，机制整体作废。                                                                                                     |
| worker 直连 server 的 HTTP 数据面（`/worker/*` 端点族）                                         | worker 只连自己的 Runtime Host。远程机器不再要求能直连 server（NAT 后可注册）。                                                               |

## 7. 迁移路径（三期，每期结束系统可用）

### Phase 1 — 契约先行（只动 server 内部，不动协议）

1. 在 `packages/shared` 定死 `RuntimeHostContract` / `RuntimeHostUpstream` / `OwnerKey` /
   `HostCapabilityStatus` 类型。
2. server 内做一个契约实现，**住 worker-manager 模块**（internal provider，以 DI token
   导出契约接口给 run 注入；内部委托现有 `WorkerManagerService`/`RuntimeService`，
   代码不搬家、不改名）。**不能放 runtime 模块**——worker-manager 已依赖 runtime，
   放那边会成 `runtime → worker-manager → runtime` 环（2026-07-12 评审纠正原 grilling 结论）。
3. `run` 模块（launcher/driver/upstream）改为只依赖 `RuntimeHostContract`：
   - `resolveRuntimeSpec` 等透传链在此一并砍掉（owner 键、runtimeType 由 server 算好传入契约）。
   - `run-driver` 对 worker-manager 的直接注入全部收敛到契约后面。

**出口判据**：`apps/server/src/run/` 内无任何 `worker-manager` import；
`pnpm test:server` + e2e 冒烟绿。此时 server 业务代码已"看不见 worker"，但物理拓扑未变。

### Phase 2 — 执行面搬家（动协议与拓扑，expand 阶段）

1. **schema expand 前移**（评审纠正：本期出口判据依赖新列，不能等 Phase 3）：新增
   `Workspace.runtimeType` 列、RuntimeHost 一机一行所需的
   新列/新行；旧列旧表保留、双读兼容。dev-only 阶段回填可用 `db push --force-reset`
   简化，但结构上仍按 expand → contract 走。
2. worker-manager 的 `connection/`、`instance/` 逻辑迁入 `apps/runtime`，
   组装成 `RuntimeHostContract` 的真正实现（worker 池 + 信箱 + 握手 + fence + epoch）。
3. **双栈切流**：Host 与 server 先同时支持新旧两条链路（隧道握手协商版本/能力；
   server 暂留 `/worker/*` 旧端点），按 Host 粒度切流——registered Host 是独立部署的
   二进制，必须容忍升级时间差。全部 Host 切完并稳定后再删旧端点。
   回滚 = 把该 Host 切回旧链路，不涉及数据回滚。
4. registered 链路：隧道协议扩展承载 submitRun / command / 事件流 / ACK / epoch
   （收编现状 UpstreamMessage），注册协议从上报单个 runtimeType 改为上报 capabilities。
   Runtime 内部 Worker 的 `WorkerHttpTransport` 对端从 server 换成 Host。
5. Worker 表停写（保留表结构以便回滚，读路径全部切走）。
6. admin"运行资源"改走 `listWorkers` 现场查询。

**出口判据**：三种 runtimeType（native/docker/opensandbox）× 两档 scope 的组合各跑通一次
完整 run（含 cancel、resume 答题、fence 判死注入测试）；server 重启后 registered Host
上进行中的 run 从 ACK 水位续传成功、builtin 孤儿清理正确；一台 Host 同时上报多能力
并被两个不同 runtimeType 的 workspace 使用（依赖第 1 步 expand 列）。

### Phase 3 — 清尾（删除与正名）

1. 删 Worker / WorkerWorkspaceBinding 表与 `registry/`；删除 Phase 2 双栈期的
   旧端点与旧链路残留。
2. schema **contract** 收尾（expand 部分已在 Phase 2 落）：保留 `runtimeType`，
   Workspace 复用范围字段统一为 `scope`、`runtimeId` 改名 `runtimeHostId`，builtin 假行清并。
3. 全量统一 `runtimeType` 命名，清除 `Isolation` / `WorkerInstance` 等旧词。
4. 合并文件双通道，删除被取代的 owner-command 文件命令；补 `releaseWorkspace` 收尾链路
   （删 workspace 流程见 §3.5 场景 4）。
5. 词汇表落 CONTEXT.md（Host 一份、server 侧引用），废止被推翻的 ADR
   （各 ADR 文件头部加 superseded 指向本文），更新 `CONTEXT-MAP.md`。

**出口判据**：仓库内 grep 不到领域语境的"载体/carrier/WorkerInstance/Isolation"；
`/check-module` 对 run、runtime 两模块无 P0/P1 违规。

### 迁移纪律

- 每期一个 PR 系列，期间 main 始终可发布；Phase 2 是唯一动协议的窗口，
  `packages/shared` 的协议类型改动集中在该期首个 PR。
- 现存"上下文窗口检测""审批 resume 泛化"等在飞特性以事件流为契约，不受影响——
  它们本就走 `agui.event`/`run.status`，正是 §4.2 契约的既有部分。

## 8. 开放问题（实施期决策，不阻塞定案）

1. worker 空闲 TTL 与 provider 缓存策略的默认值（留容器多久）——Phase 2 实施时定。
2. registered Host 的 daemon 升级策略（server 与 Host 版本偏差容忍度）
   ——沿用现状握手版本校验，Phase 2 验证是否够用。
3. admin 观测是否需要 worker 生命周期事件推送（现场查询之外）——先只做 `listWorkers`，
   有真实需求再加。
4. 同一用户在**多台 Host**上各有 user-scope worker 时 owner 键是否需要带 hostId
   ——现状协议整体下沉后约束随之下沉到单 Host 内（owner 在单 Host 内唯一天然成立），
   跨 Host 唯一性不再需要，原 schema 文档的"裸 ownerId"全局约束自动放宽。Phase 2 验证。
5. registered Host 永久消失后其名下 workspace 的命运（能否重绑到新 Host）——**特意待定**
   （2026-07-12 grilling 决定）。实施护栏：Phase 3 改表时 `runtimeHostId` 做普通列，
   "不可改"只做应用层校验、不做 DB 约束，给未来重绑留路，不用再动表。
6. 事件缓冲窗口（ACK 水位之上）也溢出时的策略——倾向：丢弃最旧的 agui 中间事件、
   永远保留 `run.status` 终态（聊天流可断档、run 生死真相不丢，断档可由 runner
   raw jsonl 日志事后补查），不做 Host 落盘、不做背压暂停 runner。Phase 2 实施时定。
7. Transport 演进：控制连接与事件连接分离、大文件走独立 HTTP 通道——
   当前一条 WebSocket 够用，接缝已留在 transport 层（见 §4.2 要点），有性能证据再做。
