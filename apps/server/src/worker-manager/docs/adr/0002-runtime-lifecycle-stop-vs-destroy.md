> **⚠ SUPERSEDED**: 本 ADR 已被 server-runtime-worker 目标架构推翻。worker-manager 执行栈在 Phase 3 全部删除，worker 池/信箱/握手/fence 移入 `@agework/runtime/host` 的 RuntimeHost 库。

# Runtime 载体收尾分 stop(留)与 destroy(删),RuntimeProvider 扁平化为 start/stop/destroy

原本 runtime 载体只有一个收尾动作 `teardown`,底下是 `docker stop` / `pauseSandbox`(**保留**载体),而所有终态调用点(fence 判死、admin 手动停、删 workspace/user)都走它。结果:删掉一个 workspace 后,它的容器只是 stop、没有 rm,而 `ownerId = workspaceId` 再也不会回来 → 容器永久躺尸泄漏。我们把收尾拆成两种意图,并借此把 `RuntimeProvider` 契约扁平化。

## 决定

`RuntimeProvider` 契约收敛为三个 peer 方法(engine 折进 provider,删掉 abstract `ContainerRuntimeProvider` 基类、两个 12 行薄壳与 `SandboxEngine` 接口层):

```ts
interface RuntimeProvider {
  readonly type: string;                                     // local | docker | opensandbox
  start(ctx):   Promise<{ runtimeInstanceId: string }>;      // 建环境 + 起 worker(create/start 合一)
  stop(ref):    Promise<void> | void;                        // owner 仍在:停 worker,保留载体
  destroy(ref): Promise<void> | void;                        // owner 永久消失:删除载体
}
```

**路由**:

| 调用点 | 意图 | 方法 |
|---|---|---|
| fence 判死 / admin 手动停 | owner 仍在,只是这次实例停掉 | `stop` |
| 启动(bootstrap)清 local 孤儿 | 连不回来的孤儿,永久清 | `destroy` |
| 删 workspace / user | owner 永久消失 | `destroy` |
| 启动扫到的容器行 | 大概率还活着,留着复用 | 都不调(liveness re-seed) |

`recoverOrphan` 不再单列方法,折进 `destroy`(local 的 destroy 支持「有内存 channel 杀 channel,否则按 `ref` 里的 pid 杀」)。

## 为什么

「停下来(可复用)」和「删掉(owner 没了)」是两种不同意图,过去被压成一个 `teardown` 动作,导致删除路径不删载体而泄漏。分开后:语义清晰、顺手修掉泄漏、`start`/`stop`/`destroy` 三方法在三个 provider 上全是真实现无恒空方法(见下)。

## 与 0001 的一致性

0001 的载荷不变量是「worker 死即载体被拆,不存在没有 worker 的载体」。`stop` 保留物理容器,**看似**留下了没有 worker 的载体——但 `stop` 仍把 worker 标记为 `stopped`,那个停机容器**不进 `WorkerInstance` 持久状态**,只是加速下次 relaunch 的物理复用缓存。持久化模型里依旧不存在「有状态的无主载体」,不变量不破。

## Consequences

- **local 的 stop 与 destroy 是同一个动作(杀进程)**。这不是假 no-op,而是 local 天生没有独立载体、只有一态的真实长相;容器才有「停(留)/ 删(删)」两态。
- **destroy 是行为变更,需接线**:docker 用现成 `dockerRemove`(`docker rm -f`),opensandbox 用现成 `deleteSandbox`,此前都从未作为收尾被调用。删除路径由 `stop` 改走 `destroy`。
- **死代码清理**:`resume`(engine + `OpenSandboxClient.resumeSandbox`)与 `isHealthy`(engine + `SandboxEngine` 接口)无调用方,随本次移除。
- **fence 仍走 stop**:fence 后同 owner 下次 run 会 `docker run` 撞已停同名容器,走既有名字冲突自愈路径。若日后希望 fence 后下次 run 干净,可把 fence 改走 destroy——不影响接口。
