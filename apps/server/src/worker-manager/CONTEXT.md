# Worker Manager

server 与常驻 worker 进程之间的通信、注册与生命周期边界。这里 **worker 是主概念**,runtime 是为它服务的运行载体。

## Language

**Worker**:
server 管理的核心单元——一个 owner 名下、能接收命令并回报事件的常驻执行单元。它被 server 观测到的存活(starting / running / stopped / error)是系统里唯一被持久化的状态。
_Avoid_: Runtime instance(指实体时)、agent process、sandbox

**Runtime**:
worker 运行所在的壳:容器(docker / opensandbox)或 fork 出的进程(local)。本身无独立状态,只被创建(start)与收尾(stop / destroy,见下),随 worker 一同生灭、为 worker 服务;其「是否存在」被 worker 的存活状态吸收,不单独记录。
_Avoid_: Carrier、engine、container(泛指时)

**Owner**:
worker 的归属与隔离键。user 隔离下是 userId,workspace 隔离下是 workspaceId。同一 owner 同时只有一个活跃 worker,可被该 owner 下多个并行 run 复用。
_Avoid_: Tenant、account

**Isolation scope**:
**仅 sandbox(容器)运行时的概念**,决定容器被谁共享的粒度:`user`(该用户所有 workspace 共享一个容器)或 `workspace`(每 workspace 独占一个容器)。`local` 直接在宿主机 fork 进程、无容器,**不具隔离级别**——数据行里 local 的 `isolationScope` 是为填非空列硬塞的占位值,不代表真实隔离(展示层应识别为 `host`)。
_Avoid_: Isolation level、裸用的 scope

**Worker instance**:
worker 与其 runtime 载体 1:1 融合后的那一条记录(`WorkerInstance` 行)。local 下 runtime 与 worker 就是同一个进程。
_Avoid_: Runtime instance

**Fence**:
心跳超时判死并强制回收一个 owner 的机制。worker 定期上报心跳;watchdog 扫到某 owner 超时未见心跳即判死(**超时即判死,不做「确认死亡」**——卡死但进程没退出正是它要抓的场景),通知其名下 run「worker lost」并停掉载体。owner 本身(workspace / user)仍存在,下次 run 可重新拉起。
_Avoid_: Health check(它不是探活重试,是判死)、kill(过于物理)

**Stop / Destroy**:
runtime 载体收尾的两种意图。**Stop**——owner 仍在(fence / admin 手动停),停掉 worker 但**保留**载体(容器 stop/pause、local 杀进程),下次 run 可复用。**Destroy**——owner 永久消失(启动清孤儿 / 删 workspace·user),**删除**载体(容器 rm/delete、local 杀进程)。两者都把 worker 标记为 stopped,差别只在物理载体留不留,不影响持久化的 worker 状态。local 无独立载体,两者同为杀进程。
_Avoid_: Teardown(笼统,不区分留 / 删)
