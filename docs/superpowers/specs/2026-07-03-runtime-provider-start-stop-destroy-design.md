# RuntimeProvider 扁平化为 start/stop/destroy —— 设计

## 背景

`runtime` 模块的 registry 层已经扁平(`local|docker|opensandbox` 三个 type 是 peer),但**实现层还没扁**:容器侧是「abstract `ContainerRuntimeProvider` + 两个 12 行薄壳 provider + 平行的 `SandboxEngine` 接口层(docker/opensandbox engine)」两层结构;`RuntimeProvider` 接口还带着 `prepareEnvironment`/`launchWorker` 两段式和死属性 `placementKind`。本次把实现层折平、把接口收敛,并顺手修掉一个容器泄漏。

术语见 `apps/server/src/worker-manager/CONTEXT.md`(新增 Fence、Stop / Destroy);决策见 `worker-manager/docs/adr/0002`。

## 目标接口

```ts
interface RuntimeProvider {
  readonly type: string;                                     // local | docker | opensandbox
  start(ctx: RuntimeLaunchContext):  Promise<{ runtimeInstanceId: string }>;
  stop(ref: RuntimeInstanceRef):     Promise<void> | void;   // owner 仍在:停 worker,保留载体
  destroy(ref: RuntimeInstanceRef):  Promise<void> | void;   // owner 永久消失:删除载体
}
```

三方法在三个 provider 上的落地:

| | start | stop(owner 还在) | destroy(owner 删了) |
|---|---|---|---|
| local | `fork` 子进程 | `SIGTERM`(有内存 channel 杀 channel) | 同 stop(杀进程;无内存态时按 `ref` 的 pid 杀) |
| docker | `docker run` | `docker stop`(留容器) | `docker rm -f`(现成 `dockerRemove`) |
| opensandbox | `createSandbox` + `runCommand` | `pauseSandbox`(留沙箱) | `deleteSandbox`(现成) |

## 改动清单

### 1. 完全折叠(实现层)
- 删 abstract `ContainerRuntimeProvider`、`docker-runtime.provider.ts` / `opensandbox-runtime.provider.ts` 两个薄壳、`SandboxEngine` 接口。
- `DockerSandboxEngine` → `DockerRuntimeProvider implements RuntimeProvider`;`OpenSandboxEngine` → `OpenSandboxRuntimeProvider`。各自把原 `getOrCreate`+`startWorker` 实现进 `start`、`stop`(原 `stop`)、`destroy`(新)。
- `OpenSandboxClient` 保留(真 SDK adapter)。
- 折叠后 `runtime/sandbox/`:`docker-runtime.provider.ts`、`opensandbox-runtime.provider.ts`、`opensandbox-client.ts`、`sandbox-utils.ts`。

### 2. 接口 / 类型清理(`runtime.types.ts`)
- 合并 `prepareEnvironment`+`launchWorker` → `start`;`teardown` → `stop`;新增 `destroy`;删 `recoverOrphan`(折进 destroy)。
- 删死属性 `placementKind`、中间类型 `RuntimeEnvHandle`、`LocalInstanceHandle`、`LocalLaunchInput`、`SandboxEngine`、`SandboxRuntime`。
- 保留 `RuntimeLaunchContext`、`RuntimeInstanceRef`、`RuntimeProvider`,及降级为共享 helper 产物的 `SandboxStartInput`/`SandboxPlacement`。

### 3. 共享 helper
- 原 `ContainerRuntimeProvider.buildSandboxStartInput` 抽成纯函数并进 `sandbox-utils.ts`,docker/opensandbox 两个 provider 都调(≥2 处真复用,合规)。

### 4. 死代码清理
- 删 `resume`(engine + `OpenSandboxClient.resumeSandbox`)、`isHealthy`(engine + `SandboxEngine` 声明)。opensandbox 只剩 create / pause(stop) / delete(destroy) / getSandbox 活链路。

### 5. 上层跟随
- `RuntimeService`:保留 `resolveRuntimeTarget`/`getRuntimePolicy`;转发方法改为 `start`/`stop`/`destroy`(按 `type` 分发)。
- `WorkerProvisioner`:`prepareEnvironment`+`launchWorker` 两次调用合成一次 `start`;`teardown` 路径→`stop`。
- **路由(行为变更)**:
  - `stop` ← fence(`fenceOwner`→`teardownOwner`)、admin(`stopWorkerInstance`)。owner 仍在。
  - `destroy` ← 启动清 local 孤儿(原 `recoverOrphan`)、删 workspace/user(`shutdownResource`)。owner 永久消失;`shutdownResource` 此前误走 stop 导致容器泄漏,本次修复。
  - 不变:bootstrap 容器行走 `livenessStore.touch`(不 stop 不 destroy,留着复用)。

> 注:local 的 stop 与 destroy 同为杀进程,所以「bootstrap 清孤儿」归 destroy 对功能无差,只是语义归类更准(连不回来的孤儿是永久清)。

## 验证
- `pnpm --filter server typecheck` 全绿。
- `pnpm test:server` 全绿;补/改 provider、provisioner、lifecycle 的精准单测(start/stop/destroy 三路由 + 死代码移除)。
- eslint 0 error(type-aware,不能只信 tsc)。

## 非目标
- 不引入 pause/resume worker 生命周期(idle-resume 已在前次砍掉,不复活)。
- 不改 `runtimeType` 域值、config/prisma/shared/前端(已在前两份计划落地)。
- 不动 run 模块 executor 改名(独立 follow-up)。
