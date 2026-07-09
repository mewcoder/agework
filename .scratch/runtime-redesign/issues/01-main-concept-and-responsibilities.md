# 01 — 重设计后谁是主概念:runtime、worker、载体的职责与状态归属

- Type: grilling
- Status: resolved
- Blocked by: (none)

## Question

本 map 的立场是「根本重设计角色」——允许推翻 wm-0001 的「worker 为主、runtime 是无状态运行载体」载荷不变量。那么重设计之后:

1. **主概念是谁?** 当前模型里 `worker`(server 管理的常驻执行单元)是主概念,`runtime`(容器/fork 进程)是为 worker 服务的无状态载体。重设计后,主概念是 `runtime`(一台机器/一个执行环境,有独立状态)、还是 `worker`(一个被 server 观测的执行单元)、还是引入新的主概念(如「执行目标 execution target」「机器 machine」「会话 session」)?主概念的命名与定义是什么?

2. **谁有持久化状态?** 当前只有 `WorkerInstance.status`(starting/running/stopped/error)被持久化,runtime 无独立状态。重设计后,哪些实体有持久化状态(存活、健康、负载、预热状态等)?是否存在「先于 / 独立于 worker 的载体」(如预热空闲容器池)?若存在,runtime 是否必须升为有独立状态的实体(即打破 wm-0001 载荷不变量)?

3. **职责边界如何重划?** 以下职责在新模型里分别挂在谁身上:
   - 机器注册与发现(谁代表「一台可用的机器」)
   - 执行环境拉起与拆除(谁 start / stop / destroy 载体)
   - agent 运行单元(谁 fork/拉起 runner,谁持有 agent 进程)
   - 能力执行(文件/目录查看、git diff 等能力,谁承接 server 的请求)
   - 命令/事件/文件通道的端点(谁是通信的主体)

4. **与现有 ADR 的关系?** 你的重设计是否推翻 wm-0001(载荷不变量)、wm-0002(start/stop/destroy 三方法契约)、wm-0003(防重键维持裸 ownerId)?若推翻,逐条说明为什么值得重开、新不变量是什么;若保留,说明在新模型下这些不变量如何继续成立。

## 背景(供解 ticket 时参考,非约束)

- 现状结构(Explore 结论):`RuntimeService` 门面下有 `LocalRuntime`(builtin,in-process)与 `RemoteRuntime`(registered,经 WS 隧道 JSON-RPC 转发);`RuntimeProvider`(packages/providers)有 local/docker/opensandbox 三实现,契约是 `start/stop/destroy`;`packages/worker` 是常驻进程,每个 run fork 一个 runner 子进程跑 agent adapter;server↔worker 走 HTTP 长轮询(命令下行)+ POST(事件/文件结果上行),server↔runtime manager 走 WS 隧道。
- 数据模型:`Runtime` 表(source=builtin|registered、runtimeType、ownerId、status、capabilities、envConfig…),`Worker` 表(ownerId @unique、runtimeId 必填、instanceId、status),`WorkerWorkspaceBinding`(workspaceId @unique → workerId)。
- wm-0001 原文的关键约束:「每个 runtime 载体恰好对应一个 worker;不存在没有 worker 的载体;worker 死即载体被拆」。这条一旦被打破,runtime 必须被拆成有自己状态的实体,wm-0001 与 worker-primary 命名都要重划——这正是本 ticket 要正面回答的岔路口。

## 期望产出

Answer 里给出:① 新主概念的命名与定义;② 有状态实体清单及其状态字段;③ 五项职责的归属表(职责 → 实体);④ 与 wm-0001/0002/0003 的关系(推翻/保留 + 理由 + 新不变量)。后续 ticket(并行模型、通信协议、远程执行、能力归属)全部依赖本答案,故本 ticket 是 map 的根,单独成 frontier。

## Answer

详见 [design.md](../design.md) v2 定稿。核心结论:

1. **主概念(保留 worker-primary,不引入 host/machine)**:runtime(机器+类型,Runtime 行)/ worker(常驻执行单元,Worker 行,身份=Worker.id=workerId)/ runner(worker 内 fork 的 run-scoped 子进程)。术语钉死见 design.md §2.0。wm-0001 载荷不变量保留(不预热空闲池,worker 死即拆)。

2. **进程拓扑(混合方案,非路 A 完全对称)**:managed native(本机非容器)留 server 进程内,直读 fs/git;managed docker/opensandbox + registered 起独立 runtime 进程,经隧道 RPC。不为对称性给 native 强加进程崩溃负担(B1)。演进:曾定路 A(完全对称),review 发现 B1(managed runtime 进程崩了孤儿 worker 没人杀)+ wm-0005 性能回退,收窄为混合。

3. **字段定稿(两字段)**:source(managed/registered)+ runtimeType(native/docker/opensandbox)。去重:现状 local 重载(非容器 vs 本机),非容器改 native,本机由 source=managed 兼带。砍 location(本期 managed=本机/registered=远程一一对应,② 真做时再加)。

4. **职责归属**:机器级能力(文件/git/环境)按文件物理位置分——native 在 server 本机硬盘→进程内直读;docker/opensandbox/registered 在容器/远程→隧道 RPC。agent 级能力(run/AG-UI)归 worker/runner。LocalRuntime 保留但收窄到只服务 native(06),越权问题解决。

5. **并行模型(沿用现状 + 破 wm-0003)**:同 workspace 多 runner(现状已支持)、隔离级别 user/workspace(现状)、跨 workspace 并行靠破 wm-0003。防重 key 从裸 ownerId 升级为 (ownerId, runtimeId, isolationScope) @@unique;协议身份改 workerId(ownerId 退回业务字段)。

6. **与 ADR 关系**:推翻 wm-0003(防重 key)、wm-0004 部分推翻(registered/docker 文件改隧道 RPC,run 命令通道保留)、wm-0005 保留+精确化(builtin→managed native 直读)。wm-0001/0002 及 runtime/providers/apps-runtime/packages-worker 全部保留。

落地交另一个 AI 按 [IMPLEMENTATION.md](../IMPLEMENTATION.md) + 7 个落地 ticket 执行。
