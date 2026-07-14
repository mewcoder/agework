> **⚠ SUPERSEDED**: 本 ADR 已被 server-runtime-worker 目标架构推翻。worker-manager 执行栈在 Phase 3 全部删除，worker 池/信箱/握手/fence 移入 `@agework/runtime/host` 的 RuntimeHost 库。

# Worker 为主概念,runtime 是无状态的运行载体

worker-manager 里 `worker`(server 管理的常驻执行单元)是主概念,`runtime`(容器 / fork 进程)是为 worker 服务的运行载体。系统里唯一被持久化的状态是 worker 被 server 观测到的存活(`WorkerInstance.status`:starting/running/stopped/error);runtime **没有独立状态**,只被创建与拆除,其存在被 worker 的存活吸收。之所以能把二者压成一行一状态(`WorkerInstance`),是因为下面这条不变量成立。

## 载荷不变量(整个模型成立的前提)

**每个 runtime 载体恰好对应一个 worker;不存在没有 worker 的载体;worker 死即载体被拆(fence → teardown)。** local 下 runtime 与 worker 就是同一个进程。这条一旦被打破(例如引入「预热的空闲容器池」,让 carrier 先于/独立于 worker 存在),runtime 就必须被拆成有自己状态的实体,本决定与 worker-primary 命名都要重划。

## 命名边界

`runtime` 一词只在两处合法:① 描述 worker 运行位置的**列属性**(`runtimeType` / `runtimeInstanceId` / `isolationScope`);② 递给 `runtime` 模块的**载体 handle**(`RuntimeInstanceRef`)以及 `runtime` 模块自己的资源策略概念(如 `getRuntimePolicy`)。worker-manager 自己拿 worker 行却挂 `runtime*` 名的地方(admin / 视图方法)属命名漂移,应向 `worker*` 收敛。
