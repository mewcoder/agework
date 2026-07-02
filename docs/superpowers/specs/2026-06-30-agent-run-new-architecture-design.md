# Agent 运行新架构设计

> 状态:brainstorming 进行中,本文是阶段性共识的完整整理,合并了此前所有轮次的修正,不再保留迭代过程。

## 背景与动机

现状(已用 Explore agent 核实过代码):`apps/api` 里 `run → runtime → worker-host` 依赖方向已经是干净的单向图,`worker-host` 是零反向依赖的叶子模块。但这只是"内部模块边界干净",不等于"Runtime 和 Worker 可替换"——只有一个 `apps/worker` 二进制,`RuntimeProviderRegistry` 的候选项是代码里写死的,Worker 内部 Claude vs Codex 的选择是硬编码 if/else。`docs/architecture/run-runtime-worker.md` 里已经预留了 "Phase 5: Worker Backend / Agent Server 化" 但明确写着"暂缓,单独设计"。

目标:让 **Runtime**(Provider)和 **Worker** 都和平台(Run 层)彻底解耦——平台只依赖固定协议/接口,不关心具体实现。**Runtime 一侧是真正的多注册**:local/docker/opensandbox 现在就并存,未来还可能加新的放置机制(3.4 节远程裸进程验证过设计撑得住)。**Worker 一侧本轮按只有一种(平台自己的官方制品)设计**,不考虑第三方自托管或多种 Worker 并存——这不是机制上做不到,而是这轮明确不把它当作要解决的问题;Worker 自注册机制保留(用于发现"这个 workspace 现在绑定的活实例是谁"),但不为"多个不同来源的 Worker"设计信任/鉴权体系。

这是一次**面向理想目标状态的重新设计**,不是对现有代码的小修小补。

---

## 一、三层关系总览:谁调谁、谁注册在哪

> 本节记录的是审视过程中重新拍板的结论:`runtime` 与 `worker-host` 原计划各自独立、由 `run` 同时认识两边——现在改为 `worker-host` 吸收原属于 `runtime` 的 WorkerRegistry 数据与实例编排能力,`runtime` 收窄成纯粹的 Provider 引擎层,`run` 只依赖 `worker-host` 一个模块。

```
                    ┌─────────────────────────┐
                    │        平台 (Run)         │
                    └───────────┬─────────────┘
                                 │ 只依赖 worker-host 一个模块
                                 │ (启动解析入口是 resolveInstance,
                                 │  就绪后另有方法收发指令/事件,见第四节)
                                 ▼
                    ┌───────────────────────────────┐
                    │      worker-host 根 Service       │
                    │  resolveInstance(ownerCtx, agentType) │
                    ├───────────────────────────────┤
                    │  内部私活,平台不用管:             │
                    │  先查自己的 WorkerRegistry(DB),  │
                    │  没有就调 runtime 模块的            │
                    │  RuntimeService.launch()           │
                    └───────────────────────────────┘
```

平台(`RunService`/`RunLauncher` 这类真正想"跑起来"的调用方)现在**只依赖 `worker-host` 一个模块**——不是"只调一个方法"就完事:启动/取得实例这一步靠 `resolveInstance(ownerContext, agentType)`,拿到一个能用的实例句柄,外加这次 run 要用的 placement 信息(`runtimePath` 等,平台拼 `RunConfig` 要用);实例就绪之后,平台还要经 `worker-host` 的其他方法开 session、下发指令、接收事件(见第四节步骤 4),这些都不塞进 `resolveInstance` 里。`WorkerRegistry`、`RuntimeProviderRegistry`、要不要调 `runtime.launch()`,全部是 `worker-host` 内部的事,不摊在调用方面前——"只依赖一个模块"说的是模块数量,不是方法数量。

这跟最初设想的不一样:最初认为"先查有没有活实例、没有再决定要不要新建"这套判断必须收在 `run` 内部,因为怕挪进 Runtime 会让 `runtime → worker-host` 这条边重新出现。但现在 `runtime` 已经被收窄成纯粹的 Provider 引擎层(第三节),真正需要认识 WorkerRegistry、owner 复用规则这些业务语义的是 `worker-host`,而 `worker-host` 依赖 `runtime` 本来就是唯一合法的方向(`runtime` 全程不反过来依赖 `worker-host`)。所以这套判断逻辑完全可以就长在 `worker-host` 的根 Service 里——这属于 `.claude/rules/backend-architecture.md` 说的"Root Service 出现复杂状态机时拆 internal provider",`worker-host` 内部按需拆 internal provider(WorkerRegistry 查询、编排决策、通信协议各自成一块),但对外只暴露这一个 `resolveInstance` 方法。`run` 因此从"要同时认识 runtime 和 worker-host 两个模块"简化成"只认识 worker-host 一个",比最初设想的方案更干净。现有代码里 `run/launch/run-launcher.ts`(`RunLauncher`)已经在做"resolve placement + 组装 RunConfig + 拉起 worker"这类编排,以后只对接这一个 `resolveInstance` 方法,不需要自己再维护"先查、按需再 launch"的两步逻辑。

**查询顺序:workspace/owner 是主键,agentType 是对已绑定实例的次要兼容性检查,不是主查询条件。** 理由:一个 workspace 就是一个真实的文件夹,它的文件已经躺在某个具体位置(本机磁盘,或者某个具体容器的挂载点里)——这是物理事实,不是"选出来的"。workspace 一旦第一次跑起来选定了放置方式,这个绑定就是持久的,不会因为下一次 run 换了个 agentType 就重新决定放哪儿。所以查询要先按 workspace/owner 找到已经绑定的实例——这个实例支不支持这次要的 agentType,不在平台侧检查,由 Worker 自己执行时判断(见 2.3 节);查询本身不反过来先按 agentType 广撒网找"任意一个支持这个 agentType 的实例"。

这跟现有代码里 `WorkspaceRuntimeInstance` 表("workspace↔容器绑定,一对多")+ `isolationScope`(`"user" | "workspace"`,决定 `scopeKey`,即"这个 run 能复用谁的容器")是同一个机制——新设计延用这套已有的绑定逻辑,不是另起一套。`WorkerRegistry` 按 owner/workspace 查到绑定实例、确认它活着,就直接把任务发给它——agentType 支不支持是 Worker 自己执行时的判断,不是平台侧的查询条件(见 2.3 节)。

**这也是"官方 Worker 制品要把所有 Adapter 都打包进去,不要做单 agent 瘦身版"这个选择的另一条理由**:一个 workspace 绑定的是同一个 Worker 实例,这个实例要长期服务这个 workspace 后续所有的 run——不管用户这次选 Claude、下次换 Codex,都得是同一个实例来处理,不能因为切换 agent 类型就重新挪一次环境。如果绑定的实例只打包了单个 agent,用户在同一个 workspace 里切换 agent 类型就会撞上"实例不支持"的真实不匹配问题。

**核心结论:**

1. **Runtime(Provider)与 Worker 之间没有方法调用,只有生命周期绑定。** Provider 的职责是"把某个 Worker 变成一个活的实例"(fork 进程 / 起容器)并管理这个实例的生死;Provider 从不调用 Worker 的业务方法,Worker 也从不调用 Provider。
2. **持续通信(指令下发、事件上报)完全绕开 Provider,由 `worker-host` 统一负责。** 走固定协议通道,Provider 只负责"启动那一下"和后台的生死管理,不参与通信内容。
3. **`worker-host` 是平台唯一需要认识的对象,`runtime` 收窄为纯粹的 Provider 引擎层。** `runtime` 只知道怎么物理拉起/销毁一个实例、怎么算 placement,不认识 WorkerRegistry、不认识 owner 复用规则、不碰 DB——是真正意义上零依赖的模块;`worker-host` 是唯一调用 `runtime` 的一方,方向单一,不会成环。

两种"固定接口"性质不同:
- **Provider 侧**:方法契约,由 `worker-host` 主动调用——`launch/stop/cleanup/list`(详见第三节)。
- **Worker 侧**:协议契约,不是方法调用,是 Worker 主动发起的通信约定(注册、拉 config、拉 command、报 event、报心跳)。

### 1.1 `worker-host`:通信协议通道 + 实例登记簿 + 编排入口三合一

`apps/api/src/worker-host/` 现有的东西(`command-queue` 下发指令、`config-store` 存 config、poll 端点、post event 端点)本来就是"平台直接跟 Worker 通信的那条固定协议通道"的现成实现。这次重新设计,`worker-host` 在继续担任这条通道的同时,还要从 `runtime` 手里接过两样东西:

- **WorkerRegistry 数据**——现有 `RuntimeInstance`/`WorkspaceRuntimeInstance` 表的 repository 归属整体搬到 `worker-host`(详见 2.3 节)。这份数据记录"这个 owner 现在绑的是哪个活实例",查询和更新天然发生在 `worker-host` 自己的协议端点里(自注册、心跳)——继续留在 `runtime` 会导致 `worker-host` 反过来依赖 `runtime`,破坏 `runtime` 的零依赖身份。
- **实例编排、admin、idle 巡检**——原 `runtime/instances/`、`runtime/admin/` 的内容(现有代码里 `SandboxRuntimeInstanceService` 的 `IdleWatchdog`、`RuntimeInstanceLifecycleService` 的 workspace/user 删除级联)。这些逻辑本质上是"要不要新开一个实例、这个 owner 现在绑的实例还活不活"的编排决策,依据的数据也是 WorkerRegistry,搬过来正合适。

`runtime` 因此收窄成纯 Provider 引擎层(见第三节),依赖方向变成单一的一条边:

```
run → worker-host    —— 平台唯一依赖。resolveInstance 内部按需再调 runtime。

worker-host → runtime —— 唯一合法方向。worker-host 拿 placement 结果、
                          调物理 launch/stop/cleanup,全部经这条边调
                          runtime 的 RuntimeService;runtime 从不反过来
                          调 worker-host。
```

现状(已核实的问题点):`SandboxRunExecutor` 同时直接注入 `RuntimeService` 和 `WorkerHostService`,两者被糊在一起用,是这次讨论最初点出来要解决的耦合点(`apps/api/src/run/execution/sandbox.executor.ts`)。新设计把这个耦合完全收进 `worker-host` 内部——`run` 以后只认识 `worker-host` 一个依赖,不用自己同时攒着两个 Service 再决定先调哪个。

**local 场景的 channel 交接,现在走 `launch()` 的返回值,不是一次单独的跨模块调用。** IPC 通信必须靠 `fork()` 返回的 channel 对象收发消息(`child.send()`/`child.on('message')`),这个对象只有真正调用 `fork()` 的 `LocalRuntimeProvider`(在 `runtime` 里)拿得到。但因为 `runtime → worker-host` 这个方向不允许,`LocalRuntimeProvider` 不能主动调 `worker-host` 的方法把 channel 塞过去——channel 只能**随着 `launch()` 的返回值,顺着 `worker-host → runtime` 这条本来就合法的调用方向"捎带"回来**:`RuntimeProvider.launch()` 对 transport 为 IPC 的 Provider,返回的 `InstanceHandle` 额外带一个 `channel` 字段(非 IPC 的 Provider 没有这个字段,详见 3.5 节);`worker-host` 调用 `launch()` 拿到这个 channel 后,自己接手后续的 `child.send()`/`child.on('message')` 以及存活检测(监听 `child.on('exit')`,见 2.4 节),`LocalRuntimeProvider` 自己只留 PID(私有簿记,用于 `kill()`),不再持有 channel、不参与后续任何通信。这不是新增一次调用,只是同一次 `launch()` 调用的返回值里多带了一样东西,依赖方向没变。

**workspace/user 删除时的级联清理,也归 `worker-host`。** 这个用例要回答"这个 workspace/user 绑定的是哪个实例"(WorkerRegistry 数据,现在归 `worker-host`)、以及"把它物理销毁"(调 `runtime.shutdownRuntimeInstanceByOwnerId()`,方向仍是 `worker-host → runtime`,合法)。留在 `runtime` 里做不到——`runtime` 手上根本没有这份绑定数据,查询就得反过来调 `worker-host`,又会破坏零依赖。

---

## 二、Worker

### 2.1 Worker : Agent = 1 : N

一个 Worker 实现可以声明支持多个 `agentType`(今天的 `apps/worker` 本来就同时支持 Claude 和 Codex)。强制 1:1 会把已有能力人为拆开,是被抽象反推出来的额外工作量,不是真实需求。

**全新 workspace 还没绑定任何实例时,前端展示哪些 agentType 可选,读一份平台级别的固定配置/常量**(比如 `["claude_code", "codex"]`),不区分具体是哪个 Provider、哪种放置方式支持——这是这次部署整体支持哪些 agentType 的静态声明,跟 2.3 节"活实例支不支持"是两回事(那个是运行时判断,这个是纯粹给前端展示选项用的)。

### 2.2 Worker = 自带全部依赖的完整制品

Worker(镜像 / 自含式可执行包)必须自带运行时(Node)、自己需要的 SDK、自己的事件翻译逻辑。**Provider 不负责给 Worker 安装任何东西。**

理由:
- 如果 Provider 负责装东西,就必须认识 Worker 的依赖清单,直接破坏"互不知道对方内部"的解耦目标。
- 运行时装包意味着执行 agent 任务时容器需要联网,和沙箱"限制出网防止数据外泄"的安全前提冲突,而且慢、不确定。

**需要单独澄清的区分**:Worker 自己需要的 SDK(构建时定型、随 Worker 制品打包)和用户项目本身的依赖(agent 在用户 workspace 里执行 `npm install` 之类的操作)是两个完全不同的环境层。

**sandbox 场景下,Docker 镜像本身就是这个 Worker 的完整制品**:Node 运行时、Worker 代码、它要用的 SDK,全部在构建镜像那一步打进去,容器起来就是开箱即用、不依赖外部挂载/联网的实例。Worker 仓库自己拥有并维护自己的 Dockerfile(这是"配方",不是"制品")——配方需要经过**构建 + 推送到镜像仓库**这两步才变成 Provider 能引用的具体镜像 tag(见第三节 3.3)。

### 2.3 不存在"Worker 种类目录",只有统一的"活实例自注册表"(WorkerRegistry)

一旦 Worker = worker-kit(共享通信壳)+ Adapter(可插拔差异化部分,见 2.5),"Worker 种类"这个概念就不成立了——不存在"claude-worker"和"codex-worker"两种东西,只存在同一个 worker-kit 进程装了哪些 Adapter。

```
WorkerRegistry(平台侧):
  Worker 进程启动后向平台报到 → { instanceId, transport }

  worker-host 内部按 workspace/owner 查这张表,拿到的是"这个 workspace 现在绑定的活实例是哪个"
```

**本轮范围:平台只注册一种 Worker(官方制品),不考虑第三方自托管或多种 Worker 并存。** 这不是机制做不到——自注册流程(Worker 启动后主动上报)本身不关心是谁构建的,天然支持多来源;只是这轮明确不把"多个不同来源的 Worker"当作要解决的问题,不为它设计信任/鉴权体系(呼应背景与动机)。"Worker 种类目录"这个概念不成立(不存在"claude-worker"和"codex-worker"两种东西)这条结论依然成立,只是现在"平台只有一种 Worker"这件事更进一步、更明确了:不只是"不需要种类目录",而是"压根只有一种"。

**WorkerRegistry 是 DB 持久化的,不是纯内存态。** 理由:`apps/api` 自己重启(部署新版本、崩溃恢复)不应该丢失"现在有哪些实例正在跑"这份记录——内存态的话,一次重启就清空,平台会暂时"看不见"实际还活着的 sandbox 容器,直到它们下次心跳才能重新发现。入库后重启不丢数据。这跟现有代码里 `RuntimeInstance` 表本来就是持久化的(sandbox 实例专用)是同一个诉求,新设计只是把这个诉求从"只管 sandbox"扩展到"管所有 Worker 实例"(2.3 节下文详述)。(不是为多副本部署考虑——本项目不打算跑多个 `apps/api` 副本。)

入库后,"异常恢复"那条推理要相应调整:不再是"重启后表是空的,靠下一次心跳自动填上"(内存态才有这个问题),而是标准的**心跳时间戳 + 过期阈值**判断——每次心跳更新 `lastHeartbeatAt`,超过阈值没更新就判定为不再存活(不管这条记录是不是还在表里)。

**"WorkerRegistry" 指的是访问这份数据的服务/仓储层,不是表名本身——数据(DB 表)继续叫 `RuntimeInstance`,不改名。** 这张表存的字段(`status` 那一整套状态机)本质上是容器/进程的生命周期数据,是"实例"这个概念,不是凭空多出来一个"Worker"概念的数据。`WorkerRegistry` 是包在这份数据外面的服务层——Worker 自注册、`worker-host` 内部按 owner 查绑定实例(供 `resolveInstance` 用,详见第一节),都是在跟这一层打交道,它内部读写 `RuntimeInstance` 表,对外暴露的是"Worker 发现"这个语义。**这份数据的 repository 归属整体在 `worker-host` 模块,`runtime` 不持有、不直接读写这张表**(详见 1.1 节)——这跟 3.6 节 `RuntimeService`(`runtime` 模块的门面,包了一层 `RuntimeProviderRegistry` + 具体 Provider)是同一个分层模式,只是两个门面分属两个不同模块:**数据叫 `RuntimeInstance`,门面叫 `WorkerRegistry`,归 `worker-host`**。

**`WorkerRegistry` 就是现有 `RuntimeInstance` 表,扩展出来的,不是另建一张平行的表。** 对 sandbox 场景来说,两者记录的是同一个物理实体(同一个持久容器/session)、同一套生命周期(starting/running/stopped/心跳/清理)。扩展点:
- 加一个新字段:`transport`(这个概念是本次重新设计才出现的,现有表没有)。
- 覆盖范围扩大:现有表现在明确排除 local(local 不入库,只记内存,见现有架构文档);WorkerRegistry 要覆盖 local,local 也要开始写这张表(2.4 节)。

**完整字段:**

| 字段 | 类型 | 干什么用 |
|---|---|---|
| `instanceId` | string,主键 | 实例唯一标识。**不是容器 ID 或进程 ID**——是 Run(或 Provider 代 Run)在启动这个实例之前就预先生成好的逻辑身份,当启动参数传给 Provider/Worker(见下方"instanceId 的身份") |
| `ownerId` | string | 这个实例绑定的 workspace 或 user,具体是哪种由同一行的 `isolationScope` 字段决定。**查询主键**——**`isolationScope=user` 只对 sandbox 类 Provider 有意义,local 强制只能是 `workspaceId`**,见 2.4 节 |
| `isolationScope` | `"user"` \| `"workspace"` | 沿用现有 Prisma 字段名,不新造 `ownerType`。决定 `ownerId` 存的是 userId 还是 workspaceId——admin 展示、workspace/user 删除级联清理都需要靠它分清楚 `ownerId` 的语义,光有一个裸字符串不够稳。**不参与 3.7 节并发防重的 active 唯一约束**——那条约束只建在 `ownerId` 上,理由见 3.7 节(userId/workspaceId 碰撞概率可忽略) |
| `runtimeType` | string | `"local"` \| `"docker"` \| `"opensandbox"` \| `"remote"` \| ...(3.0a 节,平级注册的放置机制) |
| `transport` | `"ipc"` \| `"http"` | 跟它通信走哪种方式 |
| `status` | enum | `starting/running/stopped/missing/error`。现有表的取值是 `running/stopped/error/stale`——`starting`/`missing` 是本次新加的状态,不是沿用。**现有的 `stale` 不带入新设计**:核实过整个仓库从初始提交到现在都没有任何代码真正把一行数据的 status 写成 `stale`,只有读侧(admin 筛选、一个从不会命中的清理函数)——是个只写了一半、从未接上游的死状态,不必继续背。`missing` 不设计自愈回 `running` 的路径;`missing` 之后要不要转成别的终态、要不要硬删除,归入"仍待讨论"的边界问题,不在这轮设计范围 |
| `lastHeartbeatAt` | timestamp | 最近一次心跳时间,过期判断用 |
| `registeredAt` | timestamp | 首次注册时间 |
| `metadata` | JSON | 诊断信息(沿用现有 `RuntimeInstance` 诊断字段) |

**表里不存 `supportedAgentTypes`,agentType 兼容性由 Worker 自己在真正执行时判断,不做平台侧预检查。** 平台按 workspace/owner 查到绑定实例、确认它活着,就直接把任务发过去;这个实例支不支持这次请求的 agentType,是 Worker 自己内部 AgentAdapterRegistry(2.5 节)的判断——找不到对应 Adapter 就自己报错,平台把这个错误往上抛给调用方。这跟提前查一个存储字段再决定要不要发,最终结果一样(都是报错),但省掉了维护这个字段、以及"发送前先查一次兼容性"这一步。

**`instanceId` 的身份:逻辑标识,不是基础设施标识。** Provider 执行 `launch()` 时,内部实际会用到 PID(local)或容器 ID(sandbox)去做 `kill`/`docker stop` 这类操作——但这些是 Provider **私有的内部簿记**(比如 `Map<instanceId, pid>` / `Map<instanceId, containerId>`),从不暴露给 `run` 或 `worker-host`。`WorkerRegistry` 和 3.5 节 `launch()` 返回的 `InstanceHandle`,统一只认这个逻辑 `instanceId`——一个进程或一个容器(带它 entrypoint 里的那一个 Worker 进程)是同一个物理实体,`instanceId` 只是这一层(通信/路由)看它的身份,PID/容器 ID 是 Runtime 内部看它的身份,两者不互通、不泄漏。

三个身份不要混用:`RuntimeInstance` 表自己的 DB 主键(`id`,纯数据库行标识,谁都不关心具体值是什么)、`instanceId`(逻辑身份,`WorkerRegistry`/`run`/`worker-host` 统一认这个)、PID 或容器 ID(物理身份,Provider 私有)。一行数据同时有这三种不同用途的标识,各自只在自己的层面上有意义。

**心跳复用现有的长轮询请求,不单开心跳接口——这条只适用于 HTTP transport(sandbox/remote)。** 2.4 节已确认 Worker 持续长轮询 worker-host 拉指令(hanging GET)——这个轮询请求本身,不管这次有没有拉到指令,都能证明"这个实例现在还活着",worker-host 收到任意一次来自这个 `instanceId` 的请求就顺手更新 `lastHeartbeatAt`,不需要 Worker 另外发一条独立的心跳消息,不多占一条网络请求。

**local(IPC transport)不适用心跳超时判断死活,也不需要。** IPC 是推送式的,没有"轮询请求本身证明存活"这个信号;但 Node 的 `fork()` 提供了比心跳更直接、零延迟的信号——`child.on("exit", ...)`,进程真死的那一刻立即触发(现有代码 `local.executor.ts` 现在就在用这个模式)。`worker-host` 拿到 `launch()` 返回的 channel 后,监听这个事件,一旦触发就立即把这个 instance 标记为 stopped/missing,不需要等超时、也不需要额外的心跳消息。进程没退出但卡死不响应的情况不在这轮设计范围内,留到以后按需处理。

**DB 是权威数据源,这一点不妥协;缓存是后期可选的性能优化,不是现在就要做的事。** 热路径上"先查 WorkerRegistry"这一步(第四节)如果查询压力大,后续可以在 DB 前面加一层缓存(Redis 或进程内缓存)减少直接查库次数——但缓存只能是 DB 数据的加速层,不能反过来成为权威数据源,不然会出现缓存数据和 DB 实际状态不一致、平台按过期缓存做错误调度决策的问题。这条优化顺序放到"仍待讨论"里,不在这轮设计范围内展开。

### 2.4 通信 Transport:按放置方式分化,由启动方显式指定

- **local 放置**:Provider fork 出 Worker 子进程,用 **IPC** 通信(父子进程直连)。
- **sandbox / 远程**:用 **HTTP long-poll**。已核实现有实现(`worker-host/command/command-queue.ts` 的 `waitForOwnerId`)是真正的 hanging GET,延迟已接近 WebSocket,没必要为了延迟换成 WS。
- Worker 内部同时具备 IPC 与 HTTP 两种通信实现,**由启动时传入的参数显式指定用哪种**,Worker 自己不探测/不关心"我在哪"。
- 推论:IPC 只在"平台亲自 fork 出这个 Worker 子进程"时才可能存在(依赖父子进程关系)。跨进程边界(容器、远程)一律用 HTTP。这条规则天然覆盖未来任何新增放置方式(比如"远程裸进程执行"——不管叫什么名字,只要不是同机器 fork 出来的,就是 HTTP,不需要为新放置方式单独加规则)。

**local 也按 owner 长期复用,不是一次 run 一个新进程。** 之前沿用旧架构文档"local ~= one run ~= one process"的说法,这跟第一节"workspace 是查询主键,一个 workspace 绑定同一个实例长期服务它"这条规则不一致——那条规则没有为 local 开例外,应该统一适用。没有技术理由要求 local 必须一次性:Worker 自己的内部循环(启动→注册→循环等任务)不关心自己会被复用几次,这是外部(Provider)决定的。修正为:LocalRuntimeProvider 内部维护 `{ ownerId → 进程 }` 的映射,跟 SandboxRuntimeProvider 内部维护 `{ ownerId → 容器 }`(3.1 节)是同一个模式,只是 local 的"实例"物理上是一个 fork 出来的进程。同一台机器上可以同时存在多个 local 进程,一个 workspace 一个,互相隔离。

**local 强制 `isolationScope=workspace`,不接受 `isolationScope=user`。** sandbox 场景允许 `isolationScope=user`(一个用户的多个 workspace 共用一个容器,容器里挂载多个 workspace 目录,靠 run 级别的路径参数区分)是因为容器有真实开销,值得为复用而承担"一个容器伺候多个 workspace"这层复杂度。**local 场景这个动机不成立**:fork 一个进程很轻量,不值得为了省资源去共用;而且 local 没有容器文件系统隔离这层保护,把多个 workspace 塞进同一个进程风险更高、收益更小。所以放置策略(第四节步骤 b)解析出 `runtimeType=local` 时,`ownerId` 只能是 `workspaceId`——这是策略层面直接避免这个组合出现,不是指望 `LocalRuntimeProvider` 自己拒绝一个不该出现的输入。

**local 的 IPC channel 从 Provider 转到 worker-host,走 `launch()` 的返回值,不是 Provider 主动调 worker-host。** IPC 通信必须靠 `fork()` 返回的 channel 对象收发消息(`child.send()`/`child.on('message')`),这个对象只有真正调用 `fork()` 的 `LocalRuntimeProvider` 拿得到——但持续通信(下发指令、收事件)要绕开 Provider、由 worker-host 负责(第一节结论 2)。两者要对得上,必须有个交接动作,但 `runtime → worker-host` 这个方向不允许(见 1.1 节),所以这个交接不能是 Provider 主动调 worker-host 的方法,只能顺着 `worker-host → runtime` 这条本来就合法的调用方向,随 `launch()` 的返回值捎带回去:

```
LocalRuntimeProvider.launch(input):
  1. child = fork(workerExecutablePath, { env: { instanceId: input.instanceId, ... } })
  2. 返回 InstanceHandle { instanceId: input.instanceId, channel: child }
     —— channel 字段只有 transport=ipc 的 Provider 才带,worker-host(launch() 的
        调用方)拿到这个 handle 后自己接手 channel 收发消息,角色跟它拿着 HTTP
        连接收发消息完全一样
  3. LocalRuntimeProvider 自己只留 PID(私有簿记,用于 kill()/stop()/cleanup()),
     不再持有 channel、不参与后续任何通信
```

这是**启动那一瞬间的单次交接,不是持续依赖**——交接完成后 Provider 彻底退出通信链路,不会因为这次交接就需要理解 worker-host 的业务语义(WorkerRegistry、agentType 兼容性依然跟 Runtime 无关)。

### 2.5 Worker 内部结构(对平台是黑盒,细节仅供参考)

Worker 内部具体怎么实现,对平台来说是黑盒,不影响本设计的核心关系。仅记录已讨论过的内部分层供后续参考:

- **两条独立的内部多态轴**,触发时机不同:
  1. **Transport 多样性**(IPC/HTTP):由启动参数决定,**实例级别**选择,启动后不变。
  2. **AgentAdapterRegistry 多样性**(Claude/Codex/...):由每次 run 请求的 agentType 决定,**单次 run 级别**选择,同一个长期存活的实例可能这次用 Claude Adapter、下次用 Codex Adapter。AgentAdapterRegistry 构建时定型,不运行时安装(同 2.2 的理由)。
- **worker-kit**:基础设施壳(transport、协议语义、注册/心跳)与 Adapter(SDK 差异化翻译逻辑)分层,前者封装成可复用共享包。任何 Worker 实现 = worker-kit(依赖)+ 自己写的 Adapter。范围限定:现阶段只考虑 Node/TS 生态,worker-kit 直接作为事实上的协议实现,不单独维护语言无关的协议规范文档。
- 建议的四层内部划分(Transport / Session-Protocol / Execution / AgentAdapterRegistry+Adapter)已讨论过——这属于 Worker 自己的实现细节,平台不需要关心。

---

## 三、Runtime(Provider)

### 3.0 Runtime/Provider 不是独立包,是 `apps/api` 内的 feature module

跟 Worker 性质不一样——**Worker 是独立部署的进程**(fork 出来或者放进容器跑),所以它必须是能独立构建的东西(`apps/worker` + `packages/adapters` 各自是独立 package);**Runtime/Provider 是跑在 API 进程内部的业务逻辑**,`fork()`/`docker run` 是 API 进程自己发起的系统调用,Runtime 本身从来不是一个单独跑起来的东西。所以它继续待在 `apps/api/src/runtime/` 这个 NestJS feature module 里,不做成 `packages/` 下的独立 npm 包。

**审视后收窄的范围**:`runtime` 只保留 Provider 引擎 + placement 计算,原有的 `instances/`(WorkerRegistry 数据、实例编排)、`admin/`(管理端查询)整体搬去 `worker-host`(详见第一节 1.1)。`runtime` 因此没有自己的 DB 表,也不依赖 `worker-host`——是零依赖模块,唯一的调用方是 `worker-host`。

现有结构(已核实,`runtime.module.ts`,搬迁后收窄为):

```
apps/api/src/runtime/
  providers/    —— RuntimeProvider 契约 + RuntimeProviderRegistry
  sandbox/      —— sandbox 专属的 engine 实现(Docker/OpenSandbox)
  placement/    —— 放置策略
```

**"以后扩展放个文件夹就行"——文件夹放置对,但不会自动生效,注册是显式的,不是扫描文件夹自动发现。** 现有代码用 NestJS DI token 多重注入:

```ts
{
  provide: RUNTIME_PROVIDERS,
  useFactory: (...providers: RuntimeProvider[]) => providers,
  inject: [SandboxRuntimeInstanceManager /* 未来新 Provider 加在这里 */],
}
```

新增一种放置方式(比如 3.4 节的"远程裸进程"),具体步骤:①在 `runtime/` 下新建文件夹放实现,实现 `RuntimeProvider` 契约;②在 `runtime.module.ts` 的 `providers` 数组里注册;③加进 `RUNTIME_PROVIDERS` factory 的 `inject` 列表。文件夹只决定代码放哪,真正生效靠这三步显式接线——跟 2.5/仍待讨论第 10 条"AgentAdapterRegistry 也不是文件夹扫描,是显式注册表"是同一个仓库惯例,不搞运行时文件发现。

### 3.0a 拆平"本地/沙箱"二级分类,只留一份平级 registry

现状(已核实)是两层结构:先分 `runtimeType`(local / sandbox),**只有 sandbox 内部**才有第二层 `sandboxEngineType`(docker / opensandbox)。local 和"sandbox 下的某个 engine"不是同一个层级的东西,这个二级结构本身没必要。

**拆平之后:local、docker、opensandbox、未来任何新的(比如 3.4 节的远程裸进程),全都是同一个 `RuntimeProviderRegistry` 里的平级条目**,不再有"local 是一类、sandbox 下面又分几种"这种母子关系。

**注意"拆平"拆掉的是分层,不是类型标识本身**——每个 Provider 依然要有自己独立的类型 key,复用现有代码里的 `runtimeType` 字段名(取值范围从原来只有 `"local" | "sandbox"` 两种,自然扩展成 `"local" | "docker" | "opensandbox" | "remote" | ...` 这些平级的具体类型——拆平是"分类"和"具体引擎"两个概念合并成一个的自然结果,字段名不用新造)。`RuntimeProviderRegistry` 靠 `runtimeType` 注册/查找,admin 界面也靠它显示"这个实例用的是哪种"。变化只是这些取值不再有谁包含谁(不再是"local 是一类、docker/opensandbox 嵌套在 sandbox 类下面"),而是全部平起平坐、各自独立注册。

**transport(IPC/HTTP)不从 `runtimeType` 字符串推导,是每个 Provider 自己声明的独立字段,跟 `runtimeType` 平级:**

```
{ runtimeType: "local",       transport: "ipc"  }
{ runtimeType: "docker",      transport: "http" }
{ runtimeType: "opensandbox", transport: "http" }
{ runtimeType: "remote",      transport: "http" }   // 未来新增的
```

如果靠"判断 runtimeType === 'local'"去推 transport,等于在某处写死一张"runtimeType → transport"映射表,谁维护这张表就要认识所有当前和未来的 runtimeType 名字——这正是想通过注册机制避免的隐藏耦合。让每个 Provider 自己声明 transport,任何地方(admin 展示、日志)要读直接取字段,不用字符串匹配,也经得住未来出现"不叫 local 但也是同机父子进程"的新机制。

("Transport" 这个词本身沿用,不改成别的——它是这个概念在业界的标准叫法,MCP 自己的 SDK 就有 `Transport` 接口,跟表达消息语义的"协议"分得很清楚。)

**为什么拆平之后,之前定的规则都还成立**:transport 规则(local=IPC,其余=HTTP)、复用/隔离粒度(isolationScope)这些,从来就不需要平台知道"这是本地还是沙箱"才能生效——本来就是**每个 Provider 自己内部**的决定(LocalRuntimeProvider 自己知道用 fork 所以自己选 IPC;DockerRuntimeProvider/OpenSandboxRuntimeProvider/RemoteRuntimeProvider 自己知道跨进程所以自己选 HTTP)。平台从头到尾不需要一个"家族分类"去协调这件事,拆不拆平都一样成立。

Docker 和 OpenSandbox 之间确实有真实差异(不同底层 API、不同 session 语义)——但这个差异被各自的 Provider 实现自己吃掉了,不是平台要维护的分类。它们俩碰巧共享一些特征(可持久复用、走 HTTP),是因为底层技术类似,不是因为被平台归了类;未来第四种机制(比如远程裸进程)碰巧也持久化+HTTP,同样只是恰好相似,不需要被塞进"沙箱"这个概念里。

**"local/docker 内置,opensandbox 放外边"是部署配置层面的事,不是注册机制的差异**:三者在注册机制上完全一样(都是 3.2 节"第一种注册"——写代码实现 `RuntimeProvider` 契约,走部署)。区别只在于要不要默认激活:local/docker 默认注册;opensandbox 可以做成"配了连接信息才注册进 registry,没配就不注册"的条件注册,不是更动态的注册方式,只是激活条件不同。

### 3.1 Provider = 一种放置机制的资源管理者,不是单个实例

一个 Provider 对象注册一次、长期存活,内部管理**很多个**实例(不是 1:1)。这跟现有代码里 `SandboxRuntimeProvider`/`LocalRuntimeProvider` 已经是单例、内部管理所有 owner 的运行时状态的模式一致。

```
SandboxRuntimeProvider(注册一次,长期存活的一个对象)
  ├─ 内部维护:{ owner1 → instanceA, owner2 → instanceB, owner3 → instanceC, ... }
  ├─ launch(input) 被调用很多次,每次可能命中已有的、也可能新建一个
  └─ list() 返回它当前管着的这一整批实例的状态
```

命名:沿用现有代码的 `Provider`(不改成 `Driver`)——虽然 `backend-naming.md` 第 4 条明确不建议 `Provider` 作为类名后缀,但改名影响面大,现阶段不动,留作已知的命名债务。

### 3.2 两种不同粒度的 Runtime 注册

1. **注册一种新的放置机制(新的 Provider 类型)**——比如新增 Kubernetes 放置方式。**必须是代码**,不可能靠运行时注册解决:需要实现新的 Provider 类,走部署发布。这类注册频率低(部署时偶尔发生),跟"创建一个实例"(每天可能几十上百次)完全不是一回事,不能混为一谈。
2. **注册同一种机制的新实例(同机制,不同目标制品)**——比如同样是 Docker,但换成另一个版本/环境的镜像(灰度发布、多环境部署)。这是纯参数化,不涉及新代码。

信任级别的差异:Provider 本质上是"在宿主基础设施上执行任意代码的能力",新增一种放置机制风险不低,不能轻易开放动态注册。

**不需要引入 RuntimeProfile / 制品选择这类概念。** 本轮 Worker 只有一种(背景与动机、2.3 节已确认),不存在"同一种机制下需要在多个不同制品之间路由选择"的场景——`RuntimeService.launch(runtimeType, input)` 传 `runtimeType` 就能唯一确定用哪个 Provider、进而唯一确定用哪个制品(Provider 静态配置只有一份,见 3.3 节)。如果未来真的要支持"同一种机制、同时并存多个不同制品"(比如多种 Worker 并存的场景重新拿上台面),那时候再引入选择机制,现在不为这个不存在的需求预留设计。

### 3.3 注册一个 Runtime = 注册"(放置机制, 制品引用)"绑定

平台调用 Provider 时不传"这次用哪个 Worker"——因为不存在 workerId 这个参数了(2.3 已经取消了 Worker 种类目录)。制品引用(镜像 tag / 可执行文件路径)是 **Provider 自己的静态配置**,在 Provider 被配置/注册的那一刻就定好,不是每次调用传入的参数。

```
SandboxRuntimeProvider 自己的配置(部署/注册时定好,不是每次调用传入):
  官方 Worker 镜像 = "agework/worker:1.0"

LocalRuntimeProvider 自己的配置(同理):
  官方 Worker 可执行文件路径 = "/opt/agework/worker/dist/main.js"
```

**镜像/可执行文件必须先构建好,Provider 才能引用它**——这不是"运行时现拼装",构建和运行是完全分离的两个阶段:

```
Worker 仓库(源码 + Dockerfile,"配方")
      │  构建(docker build)
      ▼
一个具体的、打好 tag 的镜像("agework/worker:1.0","制品")
      │  推送到可访问的镜像仓库
      ▼
Provider 的静态配置里填这个 tag
      │
      ▼
Provider 才能 `docker run agework/worker:1.0`
```

**现状核实**(已用 Explore/grep 确认,这个模式在代码里已经存在雏形,不是凭空发明):
- `apps/worker/Dockerfile` 已存在,注释里写明构建流程:先 `pnpm --filter @agework/worker build`(esbuild 打包出 `dist/main.js`,SDK 依赖如 `@anthropic-ai/claude-agent-sdk` 标记为 external,构建时通过 `package.docker.json` 装进镜像),再 `docker build`。
- `scripts/build-worker.mjs` 是现成的构建脚本,产出固定 tag `agework/worker:latest`。
- `apps/api/src/runtime/sandbox/sandbox-instance.service.ts:406` 的 `DEFAULT_WORKER_IMAGE` 直接引用这个 tag——这正是"Provider 静态配置指向具体镜像 tag"这一环的现成实现。

**已知缺口**:这个构建流程目前是本地手动跑,没有接入 CI(仓库里没有 `.github/workflows`),也没有推送到镜像仓库这一步(只在本地 Docker daemon 里),`:latest` 也不是版本化 tag。要支持"变更自动生效、多机部署"这些目标,需要补:CI 触发构建、推送到可访问仓库、按 git sha/semver 打版本化 tag。这个缺口记入"仍待讨论"。

### 3.4 新放置方式的验证:远程裸进程执行

压力测试:如果要支持"远程机器上跑一个裸进程(不是容器)"这种放置方式,设计撑得住吗?

- **Worker 制品**:远程主机上需要一份可执行的 Worker 制品,跟"完整制品"原则兼容,只是这次制品要出现在远程主机文件系统上——这是新 Provider 自己要解决的"怎么把制品送到那台机器"的问题。
- **Transport**:这种放置方式没有父子进程关系(跨机器),按 2.4 的规则天然归类为 HTTP,不需要为它单独加规则。
- **Provider 契约**:新写一个 `RemoteRuntimeProvider`,实现跟 Local/Sandbox 一样的契约(3.5)。属于 3.2 第一种注册(新机制),需要代码。
- **接入平台**:跑起来的 Worker 实例做的事跟 local/sandbox 起的实例完全一样——向 WorkerRegistry 自注册,平台不需要知道它在哪台机器上。

**结论:原生支持,不需要为"远程"改任何已经定下的东西**,改动被完全限制在"写一个新 Provider"这一件事上——这也验证了整个"Runtime 可插拔"设计的价值。

### 3.5 Provider 方法契约(最终版)

```
RuntimeProvider {
  launch(input: RuntimeLaunchInput): InstanceHandle
    // 内部吸收"创建 + 启动"两步(可能全新创建,也可能恢复一个已停止的实例)
    // 只证明"基础设施(进程/容器)已经起来了",不证明 Worker 协议层 ready——
    //   Provider 不该、也没法证明这一点(那是 Worker 自己的自注册决定的)。
    //   调用方要等 WorkerRegistry 里这个 instanceId 变成 running 才能真正使用,
    //   见 3.7 节"启动握手状态机"
    // InstanceHandle 携带的是逻辑 instanceId,不是 PID/容器 ID——
    //   后两者是 Provider 私有簿记,详见 2.3 节"instanceId 的身份"
    // transport 为 ipc 的 Provider(local),返回的 InstanceHandle 额外带一个
    //   channel 字段(fork() 返回的 ChildProcess 对象)——这是 worker-host 接手
    //   后续通信唯一的途径,因为 runtime 不能反过来主动调 worker-host(见 1.1 节
    //   "local 场景的 channel 交接"),只能顺着这次调用的返回值捎带回去。
    //   非 ipc 的 Provider 没有这个字段。

  stop(handle): void
    // 停止运行,但保留记录/资源,之后可能被 launch() 复用恢复
    // 对 local 这种"停了就没有恢复意义"的 Provider,内部可以直接等价于 cleanup

  cleanup(handle): void
    // 彻底销毁、释放所有资源,不可恢复

  list(): InstanceInfo[]
    // admin/可观测性查询,不在热路径调用链里,范围仅限这一个 Provider 自己管的实例
    // 不是全局视图——系统里同时注册了多个 Provider(local/docker/opensandbox),
    //   每个的 list() 只看得到自己管的那部分
    // admin 要看全局视图,直接查 WorkerRegistry(2.3 节的门面服务),不经过 Provider.list() 聚合
}

RuntimeLaunchInput {
  instanceId           // Run 生成、传入,不是 Provider 自己生成再报回来(配合下方"启动握手状态机")
  ownerId              // 隔离/复用粒度(sandbox 场景可能是 user 也可能是 workspace,
                       //   local 场景强制是 workspace,见 2.4 节),
                       //   这个信息只有平台知道,Provider 拿到后自己决定复用还是新建
  workspaceMountPath   // 挂载路径——sandbox 下 isolationScope=user 时这个路径
                       //   实际是整个用户根目录(见 runtime-resource.ts 现有实现),
                       //   不总是单个 workspace 自己的目录,字段名沿用现有叫法,
                       //   但含义是"ownerId 对应粒度的根挂载路径"
}
```

**`RuntimeLaunchInput` 明确不包含的字段**(容易被想加进去,但都已经在别处决定了,不该重复):
- `transport`——Provider 自己声明的静态属性(3.0a 节),不是调用方传入的参数。
- worker-host 地址——Provider 自己部署时的静态配置(类比 3.3 节的镜像 tag),不是每次变化的调用参数。
- `isolationScope`——`ownerId` 本身已经是隔离策略解析完的结果(userId 还是 workspaceId 由上层策略决定好了才传给 Provider),重复传是信息冗余。
- `registrationToken`——**本轮不做鉴权(见"仍待讨论"第 1 条),契约里不放这个字段,避免"契约要求、实现不做"的自相矛盾。** 以后要加自注册鉴权时,再作为新字段加回来,连同 `RuntimeInstance` 字段表要不要加 token hash 一起设计。

**推导过程,为什么没有更多方法:**
- 没有 `cancel`/`sendControl`:任务级别的控制指令(取消、批准、用户消息)走 平台↔Worker 的通信通道直接下发,不经过 Provider(见第一节结论 2)。
- 没有外部可调的 `heartbeat`:Worker 自己上报心跳给 WorkerRegistry(应用层健康),Provider 自己内部监控它启动的进程/容器(基础设施层健康,比如监听子进程 exit 事件、查容器状态)——两者职责不同、都不需要暴露成外部方法。
- 没有"异常恢复"方法:如果 Worker 的心跳/轮询逻辑做成"每次心跳都带完整注册信息,不是只在启动时注册一次",WorkerRegistry 会在平台重启后随着还活着的实例下一次心跳自动重新填上,不需要 Provider 主动"发现"孤儿实例。孤儿资源的清理(没人用的残留容器)是 Provider 内部的后台巡检,自己决定何时调用自己的 `cleanup()`,不需要额外的外部方法。
- 没有单独的"创建"方法:平台永远只想要"一个能用的活实例",不存在"只创建不启动"的调用场景,这一步被 `launch()` 内部吸收。

### 3.6 RuntimeService:`runtime` 模块唯一对外门面,不是某个具体 Provider

按这个仓库自己的模块边界规则(`.claude/rules/backend-architecture.md`:"跨模块只调对方导出的 Service,不 reach 内部文件"),`worker-host` 不能直接注入 `RuntimeProviderRegistry` 或者某个具体 `RuntimeProvider`(这些都是 `runtime` 模块内部实现,不导出)。`worker-host` 只能调 `runtime` 模块唯一导出的根 Service——`RuntimeService`。`run` 不直接依赖 `runtime`,只经 `worker-host` 间接用到它(见第一节)。

```
worker-host(内部 resolveInstance 逻辑)
      │  只知道 RuntimeService,不知道 RuntimeProviderRegistry、
      │  也不知道具体是 LocalRuntimeProvider 还是 SandboxRuntimeProvider
      ▼
RuntimeService.launch(runtimeType, input: RuntimeLaunchInput)
      │  内部转发(外面看不到这一步):
      │  RuntimeProviderRegistry.resolve(runtimeType) → 拿到具体 Provider
      │  → Provider.launch(input)
      ▼
返回 InstanceHandle 给 worker-host
```

`RuntimeService` 的作用:
- `runtime` 模块唯一对外入口,暴露的方法概念上跟 3.5 节一样(launch/stop/cleanup/list),但多一个 `runtimeType` 参数(调用方要告诉它这次要哪种放置方式)。
- 内部只做一件事:按 `runtimeType` 找到对应 Provider,转发过去。不管具体怎么 fork、怎么 docker run,那是各个 Provider 自己的事。
- `list()` 范围仅限 Provider 自己管的实例(3.5 节),不做跨 Provider 汇总——admin 要看全局视图,直接查 `worker-host` 的 WorkerRegistry(2.3 节),不经过这一层聚合。

**"先查有没有活实例"这套判断,为什么不能收进 `RuntimeService`(`runtime` 模块),只能收在 `worker-host` 的根 Service 里**:`RuntimeService` 是门面,但**代码归属还是在 `runtime` 模块里**。如果让 `RuntimeService` 自己去查 WorkerRegistry,那就是 `runtime` 模块在依赖 `worker-host` 的数据,`runtime` 的零依赖身份(1.1 节)照样作废;`RuntimeService` 一旦要理解 WorkerRegistry/agentType 兼容性这些业务语义,`runtime` 模块整体也不再是"纯环境准备"。这套判断只能收在 `worker-host` 自己的根 Service 里——因为 WorkerRegistry 数据本来就是 `worker-host` 自己的,不存在"reach 别的模块内部"的问题;`worker-host` 需要 placement/物理 launch 时,再正向调 `runtime` 导出的 `RuntimeService`,方向依旧单一。

### 3.7 启动握手状态机——解决 launch() 返回和 Worker 自注册之间的竞态

`Provider.launch()` 返回 `InstanceHandle` 只代表"基础设施(进程/容器)已经起来了",不代表 Worker 已经完成自注册(写入 WorkerRegistry)。中间有个时间差:进程/容器刚起来,到它自己跑完启动逻辑、真正调用注册接口,这段时间平台如果就认为"实例已经可用",可能对着一个还没准备好的实例发任务。

**完整流程:**

```
1. worker-host(resolveInstance 内部)先插入一条 status=starting 的记录
   —— 这一步要有并发保护(见下方"并发 launch 防重")
2. 调 runtime 模块的 RuntimeService.launch() → Provider 起基础设施(fork/docker run),
   把 RuntimeLaunchInput(instanceId 等,见 3.5 节)当启动参数传给新实例
   —— launch() 本身同步抛错(比如 Provider 内部创建基础设施失败),立即把这条
      starting 记录改成 error,向上抛错,不进入下一步等待
3. Worker 启动后自己完成自注册,把 status 改成 running
   (local/IPC 场景:launch() 同步返回 channel 后 worker-host 即可视为已接管通信,
    但 Worker 自身是否真正 ready 仍按同一套自注册语义处理,不因 transport 不同而破例)
4. worker-host 侧带超时等待这条记录变成 running
   超时 → 判定启动失败,调 Provider.cleanup() 清理基础设施,**同时必须把这条记录
   从 starting 改成 error**,再向上抛错——这一步不能省:starting 是下面"并发
   launch 防重"那条 active 唯一约束覆盖的非终态之一,超时后如果这条记录一直
   卡在 starting,这个 owner 就永远没法再触发新的 launch,后续所有请求都会被
   这条约束挡死(呼应"仍待讨论"关于重启后残留行的第 13 条)
5. 变成 running 后,直接打开指令通道,走第四节步骤 4
```

**并发 launch 防重**:多个请求同时 miss WorkerRegistry 查询(比如同一个 workspace 两次请求几乎同时到达),会各自触发上面流程,导致同一个 owner 起了两个实例——哪怕只有一个 `apps/api` 进程,Node 的异步 I/O 也会让两个并发请求都在"查表→发现没有→决定要起一个"这几步之间产生竞态窗口。**修正**:第 1 步"插入 starting 记录"要靠**唯一约束**做到防重,不能靠"先查再插"的代码逻辑(查和插是两个动作,中间一样有空隙)。

**具体实现**:用 SQLite 原生支持的 partial unique index,直接建在 `status` 列上,不额外加影子字段:

```sql
CREATE UNIQUE INDEX runtime_instance_active_owner_idx
ON RuntimeInstance (ownerId)
WHERE status IN ('starting', 'running');
```

这条索引只对非终态的行生效——终态行(`stopped`/`error`/`missing`)可以有任意多条、同一个 `ownerId` 也可以反复出现,但同一时刻只允许一条非终态记录,这正是要的语义,且直接从权威的 `status` 列派生,不需要另外维护一个"是否活跃"的标记字段。Prisma 的 `@@unique(...)` 语法表达不了"只对部分行生效",这条约束要靠手写 SQL migration 加(`prisma migrate dev --create-only` 生成骨架后手动补这条索引,再 apply),不是 schema 里加一行字段那么简单。约束键只用 `ownerId`,不需要叠 `runtimeType` 或 `isolationScope`——新设计下一个 owner 同一时刻只应该绑一种 `runtimeType`(第一节:一旦选定放置方式就是持久绑定,不会换),`ownerId` 自己就够唯一定位;`isolationScope` 只是用来解释 `ownerId` 这个字符串该按 userId 还是 workspaceId 去解读(字段表已说明),不代表 userId 和 workspaceId 会撞同一个值——两者都是 `generateId()`(UUID v7,122 位随机熵)生成的,碰撞概率跟这个仓库其他地方信任外键引用不会碰撞是同一个量级,不需要额外拿 `isolationScope` 去防一个实际上不存在的风险。

后到的请求插入时被这条索引拒绝,就知道已经有别的请求在处理这个 owner,不再自己触发 launch,转去等前面那条记录变成 running 后直接复用。

---

## 四、平台侧调度流程(完整闭环)

```
1. Worker 制品构建时:worker-kit(共享通信壳)+ 选定的 Adapter 集合打包成一个制品,
   构建产出具体的镜像 tag / 可执行文件,推送到 Provider 能引用的位置(3.3)

2. `run`(`RunService`/`RunLauncher` 之类)收到一次 run 请求(workspaceId、userId、
   agentType = X),只调 `worker-host` 一个模块的一个方法:`resolveInstance(...)`。
   `worker-host` 内部私活如下,`run` 不用管:

   a. **先算 placement**(调 `runtime` 模块的 `RuntimeService.resolveRuntimeTarget()`)
      → 得到 runtimeType、ownerId、runtimePath 等(local 场景下 ownerId 强制是
      workspaceId,见 2.4 节)。**这一步无论热路径还是冷路径都要做**,不是冷路径专属:
      ownerId 本身就是下一步查 WorkerRegistry 的查询键,runtimePath 也是 `run` 拼
      RunConfig 必需的信息(见第一节),就算命中热路径、Provider 全程不参与,这份
      placement 结果也要一起回给 `run`。

   **主流程 —— 用上一步算出的 ownerId 查找绑定的 Runtime 实例:**
   b. 按 ownerId 查自己的 WorkerRegistry —— 这个 owner 有没有已经绑定的活实例?
      (workspace 的放置方式是持久绑定的,不是每次 run 重新决定,见 1.1 节)
      有绑定实例 → 跳到第 4 步,把这个实例连同第 a 步算出的 placement 一起
        返回给 `run`,Provider 全程不参与这次请求
        (这个实例支不支持 agentType = X,不在这里检查,由 Worker 自己执行时判断,见 2.3 节)
      没有绑定实例 → 继续下一步(c,冷路径)

   **冷路径 —— 没有绑定实例时才调 runtime 起一个新的:**
   c. 组装 `RuntimeLaunchInput`(instanceId、第 a 步的 ownerId、workspaceMountPath,
      见 3.5 节),调用 `RuntimeService.launch(runtimeType, input)`
      (`runtime` 模块唯一对外门面,详见 3.6 节)→ RuntimeService 内部转发给
      `RuntimeProviderRegistry.resolve(runtimeType)` 找到的具体 Provider,由它按
      自己的静态配置去物化(fork 本地可执行文件,或 docker run 配置好的镜像),
      告知新实例这次用哪种 transport(local=IPC,其余=HTTP);
      这个实例从此绑定这个 ownerId
      (local 场景:launch() 返回值额外带 channel,见 1.1 节 "local 场景的 channel 交接")

   为什么这套判断收在 `worker-host` 内部、既不留在 `run` 里、也不下沉进 `runtime`(详见 1.1 节):
   ① `runtime` 的对外契约刻意收窄成 `launch/stop/cleanup/list` 四个方法(3.5 节),
      不该反过来要求它理解 WorkerRegistry/复用规则这些业务语义;
   ② WorkerRegistry 数据本来就归 `worker-host` 自己所有,判断逻辑收在这里不存在
      "reach 别的模块内部"的问题,`run` 因此只需要认识 `worker-host` 一个依赖;
   ③ "要不要开一个新环境"虽然是编排决策,但决策所需的两份依据(WorkerRegistry 数据、
      Provider 物理操作)分别归 `worker-host` 自己和它唯一合法能调用的 `runtime`,
      不需要再上提给 `run` 去跨两个模块拼。

3. 新实例启动后:向 WorkerRegistry 上报 { instanceId, transport }
   (local/IPC 场景:worker-host 通过 launch() 返回值同步拿到 channel,
    存活检测走 `child.on("exit")`,不走心跳超时,详见 2.4 节)

4. 平台直接通过该实例声明的 transport 通道和它通信——下发指令、接收事件,
   Provider 不再参与

5. **idle/孤儿判断的决策权在 `worker-host`,`runtime` 只执行物理动作**:`worker-host` 决定"这个 owner 的实例多久没用了、该不该回收",决定要回收时调 `RuntimeService.stop()`/`cleanup()`(worker-host→runtime,合法方向)让 Provider 去真正拆掉基础设施。`runtime`/Provider 自己不持有 idle 策略,只做两件低层次的事:(a) 执行 stop/cleanup 这类物理拆除动作,(b) 监听自己拉起的进程/容器的底层退出信号(比如 local 的 `child.on("exit")`,详见 2.4 节),把这个信号报给上层,不自己决定"要不要回收"
```

---

## 五、仍待讨论 / 未决问题

1. **自注册接口的鉴权:本轮不做,推迟到以后。** "注册 token 必须绑定 owner/workspace""所有协议消息都要带 instance token 校验"这些安全底线,这轮明确不实现——Worker 自注册、拉 config、拉 command、报 event 暂时都不做 token 校验,`RuntimeLaunchInput`(3.5 节)、`RuntimeInstance` 字段表都不加 token 相关字段。后续要加鉴权时,`registrationToken` 作为新字段加回 `RuntimeLaunchInput`,再设计具体字段(token hash 怎么存、要不要过期/轮换)。
2. **注册动作的具体协议字段**:instanceId 怎么生成、鉴权怎么做。
3. **同一个 agentType 同时有多个活实例时的调度策略**(负载均衡/优先级/用户指定)。
4. **具体协议契约字段**:config 拉取、command 下发、event 上报、心跳的 payload 结构。
5. **worker-kit 落地到现有代码的位置**:放 `packages/` 下(类似 `packages/adapters`)。WorkerRegistry 落地位置已确认(1.1 节:扩展 `worker-host`;2.3 节:扩展现有 `RuntimeInstance` 表,不是另建新表),具体字段设计(哪些字段加到 Prisma schema、迁移方式)留到实现阶段。
6. **`command-queue.ts:88-90` 的既有限制**:现有实现假设"每个 ownerId 只有一个 worker 轮询",多 worker 并发轮询同一来源会导致后到的 worker 漏消息。任何"多 worker 实例共享一个任务来源"的场景都要先解决这个问题,需要 lease/ack 机制或按消费者切片。
7. **Worker 镜像的 CI/发布流水线**:当前 `scripts/build-worker.mjs` 是本地手动跑,没有 CI 触发、没有推送到镜像仓库、没有版本化 tag(只有 `:latest`)。要支持多机部署,需要补齐这条流水线。用户已确认"后期优化",不影响核心架构设计。
8. **Worker 内部四层划分**(Transport/Session/Execution/AgentAdapterRegistry)的具体边界——已标记为对平台是黑盒、优先级较低,如果后续要落地实现再深挖。
9. **`apps/worker/src/agent/index.ts` 的 `createAgentDriver()` 现在是硬编码 if/else**(`agentType === "claude"` 分支),不是 registry。需要改成显式注册表(`AGENT_ADAPTER_REGISTRY: Record<AgentType, AdapterFactory>`),对应 2.5 节的 AgentAdapterRegistry。这份列表本身决定了一次构建打进 `dist/main.js` 的是哪些 Adapter,也决定了对应 `package.docker.json` 该装哪些 SDK。用户已确认"后面实现",本条只做记录。
10. **WorkerRegistry 查询的缓存策略**:DB 是权威数据源(已在 2.3 节确认),热路径查询压力大时可以加缓存层,但缓存不能反客为主变成权威数据源。具体加不加、什么时候加,后续按实际压力决定。
~~11. workspace 绑定的实例不支持这次请求的 agentType 时怎么办~~ ——**已解决**:不做平台侧预检查(2.3 节已去掉 `supportedAgentTypes` 存储字段),平台直接把任务发给绑定的实例,不支持由 Worker 自己执行时报错,平台把错误往上抛。前端展示的是 2.1 节那份平台级别静态 agentType 列表,不针对某个具体实例做过滤(没有存 `supportedAgentTypes` 这类字段可以过滤);这个报错路径之所以几乎不会触发,是因为 2.2 节"官方 Worker 制品要把所有 Adapter 都打包进去"这个选择——正常情况下每个实例本来就支持平台声明的全部 agentType,不匹配是例外情况,不是靠前端过滤规避出来的。不设计自动换绑/恢复流程——换绑意味着环境/文件要重新挂载,代价跟这个场景的发生概率不成比例,不值得为此设计。
~~12. API 重启时,中断的 run 要不要顺手拆掉它绑定的底层实例~~ ——**已解决**:不拆。现有 `run-recovery.service.ts` 里"run 中断就 `cleanupInterruptedExecution` 拆实例"这段逻辑去掉,改成:run 照样标记为 `error`(前端该知道这次请求断了),但改为向这个 run 绑定的实例下发一条 `cancel` 命令(复用 `SandboxRunExecutor.cancel()`/`LocalRunExecutor.cancel()` 现成的命令类型),让 Worker 自己收尾这个 run,不碰实例本身的生死。实例还活着就正常处理这条 cancel,继续服务其他 run;实例已经不在了,这条命令发出去没人收,无副作用。理由:新设计下实例长期存活、服务很多个 run,"这一个 run 中断"不代表实例本身有问题,不该因为一次中断就销毁一个可能还在正常服务其他 run 的资源。

**以下几条是这轮审视中明确识别、但按"边界问题,先留白,最后处理"原则搁置的重启/恢复类问题,本版文档不给出具体设计,实现阶段视情况处理:**

13. **API 重启后,DB 里残留的 `running`/`starting` 行要不要主动恢复或清理**:现有 `RuntimeService.recoverOrphanRuntimeInstances()` 那种"重启就把所有非 user 级共享的 running 行当孤儿、直接物理拆除"的 blanket 清理逻辑,不带入新设计(理由:新设计下 HTTP 类型的实例只要还活着,重启后自己会继续心跳/轮询,不需要平台主动介入;心跳超时机制本身就足够覆盖"实例真的死了"的情况)。**不设计具体的替代方案**,但**这一条不是可以无限期搁置的边界问题,实现落地前必须处理**:3.7 节的 active 唯一约束(同一 `ownerId` 只能有一条非终态记录)会因此被卡住——local 实例重启后必然断(见第 15 条),如果那条 `running`/`starting` 行没人转成终态,这个 owner 就永远没法再 launch 新实例,workspace 直接卡死不可用。心跳超时机制能覆盖 HTTP 类型的自然恢复,但不覆盖"本来就没有心跳来源"的 local——这部分必须在实现前给出方案,不能真空着上线。
14. **同一个 owner 的实例被替换后,worker-host 内存指令队列(`WorkerCommandQueue`,按 ownerId 分区)里遗留的旧指令怎么防止被新实例误收**:现状(`sandbox-instance.service.ts:176`)靠拆除时显式调用 `cleanupByOwnerId` 清空队列来防这个问题,新设计里这个显式清理调用被拿掉了(详见第一节),替代方案不设计,接受这个边界风险,不处理。
15. **local 实例在 API 重启后,DB 里残留行的具体处理方式**:local 走 IPC、`fork()` 的父子进程关系在 API 重启后必然断,不存在"重连"这回事;但具体这些行在重启时要不要主动标记、什么时候标记,不在本轮设计范围,留空。
16. **`missing` 状态之后的去向**:要不要在 `missing` 保持一段时间后转成别的终态、要不要硬删除对应的行,这轮不处理,`missing` 也不设计自愈回 `running` 的路径。

## 参考

- `docs/architecture/run-runtime-worker.md` —— 现有 Run/Runtime/Worker 边界文档,Phase 5 "Worker Backend / Agent Server 化" 是本次讨论的前身。
- `docs/todo/agent-run-runtime-layering-review.md` —— 另一份分层整理方案,低风险路线 Y。
- `docs/research/codeg-and-aionui-inspiration.md` —— Codeg/AionUi 跨项目研究。
- `apps/worker/Dockerfile`、`scripts/build-worker.mjs`、`apps/api/src/runtime/sandbox/sandbox-instance.service.ts` —— 现有代码里已经存在的镜像构建/引用雏形。
