# Worker Manager

server 与常驻 worker 进程之间的通信、注册与生命周期边界。这里 **worker 是主概念**,runtime 是为它服务的运行载体。

## Language

**Worker**:
server 管理的核心单元——一个 owner 名下、能接收命令并回报事件的常驻执行单元。它被 server 观测到的存活(starting / running / stopped / error)是系统里唯一被持久化的状态。
_Avoid_: Runtime instance(指实体时)、agent process、sandbox

**Runtime**:
worker 运行所在的壳:容器(docker / opensandbox)或 fork 出的进程(local)。本身无独立状态,只被创建与拆除,随 worker 一同生灭、为 worker 服务;其「是否存在」被 worker 的存活状态吸收,不单独记录。
_Avoid_: Carrier、engine、container(泛指时)

**Owner**:
worker 的归属与隔离键。user 隔离下是 userId,workspace 隔离下是 workspaceId。同一 owner 同时只有一个活跃 worker,可被该 owner 下多个并行 run 复用。
_Avoid_: Tenant、account

**Isolation scope**:
决定一个 worker 被谁共享的粒度:`user`(该用户所有 workspace 共享一个 worker)或 `workspace`(每 workspace 独占一个)。
_Avoid_: Isolation level、裸用的 scope

**Worker instance**:
worker 与其 runtime 载体 1:1 融合后的那一条记录(`WorkerInstance` 行)。local 下 runtime 与 worker 就是同一个进程。
_Avoid_: Runtime instance
