# Runtime Provider 扁平化 + worker-manager 执行编排重构 · 设计

> 日期:2026-07-03 · 状态:待评审
> 关联历史:`docs/archive/runtime-provider-architecture.md`(平级运行形态愿景)、`docs/archive/runtime-pluggable-provider-plan.md`(provider 注册约定)

## 1. 背景与问题

### 1.1 worker-manager 执行器乱
- `worker-manager/sandbox-instance/sandbox-instance.executor.ts`(632 行)与 `local-instance/local-instance.executor.ts`(248 行)**复制粘贴同一段启动握手序列**(`insertStarting → 拉起 → waitForRegister → upsertRunning`,失败 `markErrorByOwner`),但并发模型不同,无法简单抽父类。
- `WorkerManagerService` 门面 `resolveInstance` / `releaseInstanceForRun` / `shutdownInstanceByOwnerId` **三处按 `runtimeType` 各判一次 `if (local)`**,`ownerRunIds` 索引被迫上提到门面并附带解释性注释。
- sandbox executor 一个类扛 5 件事:acquire settle 状态机(`AcquireRunState` / `cancelledBeforeReady`)、owner 引用计数 + idle watchdog、启动握手序列 + registry 写、idle-resume、env 拼装。

### 1.2 runtime 分型硬编码,偏离原始愿景
- `RuntimeService` 用 `startSandbox` / `launchLocal` 等 **type-specific 方法**硬编码分型;docker/opensandbox 是 `SandboxEngine` 引擎子层。
- 原始 `runtime-provider-architecture.md` 的愿景是**平级运行形态**(Local / Docker / OpenSandbox / Custom);`runtime-pluggable-provider-plan.md` 已定 `RuntimeProvider` 接口 + `readonly type` 自声明 + `RUNTIME_PROVIDERS` token + `registry.resolve(type)`、"加 provider = 建类 + 注册,零 switch"。现状是后来的偏离。

## 2. 目标

1. **runtime 扁平化**:单一 `RuntimeProvider` 注册表,`type ∈ {local, docker, opensandbox}` 全 peer,各自声明+实现;server(worker-manager / run)只按 `runtimeType` 取 provider 调方法,**不感知引擎或具体实现**。
2. **worker-manager 去执行器化**:删两个 executor,留唯一泛型 `WorkerProvisioner`(名暂定 provision,后续可调);门面与调用方**无 `runtimeType` 分支**。**本次删净 worker-manager 的 executor;server 侧仅剩 run 模块 `WorkerRunExecutor` 一处,由紧邻 follow-up(见非目标)收尾清零。**
3. **砍回收**:去掉引用计数、idle watchdog、idle-resume、`AcquireRunState` settle 状态机。
4. **收窄契约**:`AcquireInstanceResult` 只留 `ready | error`。

### 非目标
- 不改 worker 侧执行(容器 entrypoint 仍是 worker;fork 机制不动)。
- 不实现 `pause`/`resume`(只在接口留可选槽,无触发源前不填)。
- 不改 orphan / 跨进程重启恢复的**语义**(保持现状,仅随接口迁移落点)。
- 不做前端 runtime 选择器 UI。
- **run 模块的 `WorkerRunExecutor` / `RunExecutor` 去-executor 改名(会话驱动器,如 `RunDriver`)+ 去掉单实现接口 + `run/execution/` 目录改名** 列为**紧邻 follow-up**,不并入本次核心。本次 worker-manager 的两个 instance executor 随重构删除,server 侧只剩这一处 executor 残留,follow-up 收尾即全清。

## 3. 目标架构

```
runtime/ ── 扩展点(唯一一根轴)
  RuntimeProvider 注册表:  type → provider
    ├─ LocalRuntimeProvider          type="local"        placementKind="process"   fork 进程
    ├─ DockerRuntimeProvider         type="docker"       placementKind="container" ┐ 容器共性一份
    └─ OpenSandboxRuntimeProvider    type="opensandbox"  placementKind="container" ┘ 各自只差容器 API
  (docker/opensandbox 内部复用现有引擎实现,server 不可见)

worker-manager/ ── worker 协议 + 编排,类型无关
  WorkerProvisioner(泛型:把实例 provision 到就绪):
    登记 run → insertStarting → runtimeService.prepareEnvironment(ctx)
             → runtimeService.launchWorker(ctx, env) → handshake.waitForRegister
             → upsertRunning        (失败 → markError)  ⇒ 返回 ready | error
  WorkerManagerService(门面):resolveInstance/teardown 转发 provisioner;fence 索引;admin 查询
```

调用方永远只 `registry.resolve(runtimeType)` 后调方法,`local` / `docker` / `opensandbox` 对它无区别。

## 4. runtime 模块改动

### 4.1 `RuntimeProvider` 接口(新)
```ts
interface RuntimeProvider {
  readonly type: string;                    // 自声明:"local" | "docker" | "opensandbox"
  readonly placementKind: "container" | "process"; // placement/isolation 读这个,不判具体 type
  // ctx 携带完整启动 env;container 在 prepareEnvironment 起容器时就要用(docker run 依赖 env)
  prepareEnvironment(ctx: RuntimeLaunchContext): Promise<RuntimeEnvHandle>; // 资源就绪。container: getOrCreate/resume 容器(带 env);process(local): no-op
  launchWorker(ctx: RuntimeLaunchContext, env: RuntimeEnvHandle): Promise<{ runtimeInstanceId: string }>; // 启动 worker 进程。local: fork;opensandbox: engine.startWorker;docker: no-op(entrypoint 即 worker)
  teardown(ref: RuntimeInstanceRef): Promise<void> | void; // 收 DB row 派生的 ref,不靠内存
  recoverOrphan?(ref: RuntimeInstanceRef): Promise<void> | void; // 重启后收孤儿。local: 按 runtimeInstanceId 杀孤儿进程;container: 不实现,交 liveness seed
}
```
- **启动 env 归属 ctx,不作 `launchWorker` 的裸参数(P1-1 修正)**:`RuntimeLaunchContext.workerEnv` 由 provisioner 构造(共享 `AGEWORK_WORKER_*` 协议 env + `startToken`);provider 在 `prepareEnvironment` / `launchWorker` 内部**合并自己的 infra env**(`API_BASE` / `SANDBOX_ENGINE` / `RESOURCE_NAME` 等)再落地。Docker 在 `prepareEnvironment` 起容器那刻就能拿到完整 env(现状 `docker-engine.ts` 的 `docker run` 依赖 env)。
- `prepareEnvironment` 返回 `RuntimeEnvHandle`(container:容器 handle;process:空),由 `launchWorker` 吃进,中间状态显式传递,不靠 provider 内部藏 map。
- **`teardown` / `recoverOrphan` 收 `RuntimeInstanceRef` 而非裸 `ownerId`(P1-2 修正)**:`RuntimeInstanceRef { type; ownerId; runtimeInstanceId; isolationScope }` 由调用方从 `WorkerRegistry` DB row 派生。现状停止依赖内存 `ownerStates` 找 `runtimeInstanceId`(`sandbox-instance.executor.ts:276`),**服务重启后这份状态没了**;改由 DB row 驱动后,admin stop / fence / workspace·user 删除都能按持久行停止/回收(与现状 `stopRuntimeInstance` 先 `findById` 再停一致)。
- **两方法保留不合并(Q2 决策)**:`prepareEnvironment`=资源就绪、`launchWorker`=启动 worker 进程。sandbox 引擎本就有独立 `startWorker`(`sandbox-engine.ts`),worker 进程启动不总随资源就绪同时发生(opensandbox 真动作,docker 才 no-op),故不并为单一 `start()`。
- **不放 `pause`(Q3 决策)**:本轮接口不含 `pause`;将来有触发源(admin 手动 / 闲置策略)再加 optional,现在放只是空槽噪音。
- **`recoverOrphan?`(Q4 决策)**:optional。local 按 `runtimeInstanceId` 杀孤儿进程;container 不实现,重启后的容器由 bootstrap liveness seed + watchdog fence 接管(见 §5)。
- `RuntimeLaunchContext` / `RuntimeEnvHandle` / `RuntimeInstanceRef` 放 `runtime.types.ts`。

### 4.2 注册表
- `runtime-provider.registry.ts` + `RUNTIME_PROVIDERS` DI token,沿用现有 `SANDBOX_ENGINES` 的 `useFactory` 聚合模式;`resolve(type): RuntimeProvider`,未知 type 抛错。

### 4.3 各 provider
- `LocalRuntimeProvider`(`local-runtime.provider.ts`,root):`prepareEnvironment` no-op;`launchWorker` 收编现有 `launchLocal`(fork);`teardown` = kill;保留 `recoverOrphan`(orphan 恢复路径不变)。
- `DockerRuntimeProvider` / `OpenSandboxRuntimeProvider`:容器共性(备容器、env、挂载、teardown 形状、跨重启复用判定)写**一份**内部共享(基类或私有 helper),两者只差调 docker / opensandbox API。
- 现有 `DockerSandboxEngine` / `OpenSandboxEngine` / `OpenSandboxClient` / `SANDBOX_ENGINES` **降级为 runtime 模块内部实现细节**,不再经 `RuntimeService` 暴露;server 不感知。

### 4.4 `RuntimeService` 泛型化
- 新增泛型转发:`prepareEnvironment` / `launchWorker` / `teardown` / `pause`,内部 `registry.resolve(type)`。
- 保留:`resolveRuntimeTarget`、`getRuntimePolicy`。
- 删除 type-specific:`startSandbox` / `resumeSandbox` / `stopSandbox` / `launchLocal`(worker-manager 改调泛型)。`recoverOrphanLocal` 迁到 local provider,经泛型入口或专用 recovery 入口保留。

### 4.5 目录
- 删 `local/`(单文件上提 root)。
- provider 平铺 root:`local-runtime.provider.ts` / `docker-runtime.provider.ts` / `opensandbox-runtime.provider.ts` + 容器共享文件。
- 引擎实现(docker/opensandbox client/engine)保留在子文件夹作为容器 provider 私有实现(文件夹是否更名为 `container/` 留给实现期,非阻塞)。

### 4.6 placement / isolationScope
- 现有 `isSandboxPlacement` / `runtimeType === "sandbox"` 分支改读 provider `placementKind`。
- `runtimeType` 域值 `local | sandbox` → `local | docker | opensandbox`,牵动 `RuntimeTarget`、placement 计算、`WorkerRegistry` 行(完整外部面见 4.7)。

### 4.7 `runtimeType` 域值迁移的完整边界(P1-3 补节)
现状对外/配置面是 **`runtimeType ∈ {local, sandbox}` + 独立 `sandboxEngine ∈ {docker, opensandbox}`** 两个字段;扁平化后**合并成单一 `runtimeType ∈ {local, docker, opensandbox}`,删除 `sandboxEngine`**(DB 开发期重建,不做兼容映射)。受影响清单:

- `packages/shared/src/api/workspaces.ts`:`WorkspaceRuntimeType` 扩为 `local|docker|opensandbox`;删 `SandboxEngineType` 及 `WorkspaceResponse.sandboxEngine` / `CreateWorkspaceRequest.sandboxEngine`。
- `apps/server/src/config/config.service.ts`:`RuntimeType` / `RUNTIME_TYPES` 扩值;删 `SandboxEngineType` 与默认 engine 读取;`getDefaultRuntimeType` / `isRuntimeTypeAllowed` 覆盖新值域。
- `apps/server/src/run/launch/run-launcher.ts` `getPlacement`:去掉 `sandbox → sandboxEngine` 映射,直接按 `runtimeType` 交 provider。
- Prisma `Workspace`:删 `sandboxEngine` 列、`runtimeType` 取新值域(dev 重建)。
- 前端 `apps/web` 对应 types / workspace 创建·编辑表单:由集合值驱动,不再有独立 engine 选择项。

> 本节把范围明确扩到 workspace/config/shared/前端,不再只是 `RuntimeTarget` / registry 行。

## 5. worker-manager 模块改动

- 删 `local-instance/`、`sandbox-instance/` 两 executor。
- 新 `instance/worker.provisioner.ts`(internal provider,不 export;`WorkerProvisioner`,名暂定):
  - 持有 owner 实例状态(ready / pending 去重),泛型,无 `runtimeType` 分支。
  - 它就是现在两个 executor 里**复制了两遍的公共启动序列**抽出来的那一份:`insertStarting → runtimeService.prepareEnvironment → launchWorker → handshake.waitForRegister → upsertRunning`;失败 `markError`;返回 `ready | error`。类型差异已收进 provider 的 `prepareEnvironment`/`launchWorker`。
  - **insertStarting 撞 `running` 行 = 复用(Q1 决策,已核对为现状)**:撞到 DB `running` 行 → 复用/attach 既有 row 的 `runtimeInstanceId`,不清不重起;死实例交 bootstrap liveness seed + watchdog fence。token 入库(`worker-token.guard.ts:49` 从 DB 行验 `startToken`)保证重启后旧 worker 仍被认;本轮不改这套跨重启语义。
  - worker 协议 env(共享 `AGEWORK_WORKER_*` + `startToken`)在 provisioner 构造;type-specific infra env(`API_BASE` / `SANDBOX_ENGINE` / `RESOURCE_NAME` 等)由 provider 贡献。
- `WorkerManagerService` 门面:`resolveInstance` / `releaseInstanceForRun` / `shutdownInstanceByOwnerId` 去分支、转发 `WorkerProvisioner`;**保留 fence 索引 `ownerRunIds`/`runOwner`(liveness fence 用,非回收)**;保留 admin 查询。
- **teardown 统一走 provisioner(Q5 决策)**:`facade → WorkerProvisioner.teardown(ref) → RuntimeService.teardown(ref)`,不 facade 直连 provider——让 owner 内存态清理、command dispatcher `cleanupByOwnerId`、registry `markStopped` 收在一处不散。provisioner 重启后无内存态时,靠 DB `ref` 走无状态 teardown。
- 砍回收:`activeRunCount`、`retainOwnerRun`/`releaseOwnerRun`、`IdleWatchdog`/`handleIdle`、`lastStoppedRuntimeInstanceId` 及 idle-resume、`AcquireRunState`/`acquireStates`/`settleReady`/`settleError` 全删。
- **bootstrap liveness seed(P2 修正)**:现状 `lifecycle.service` 用 `findRunningByRuntimeType("sandbox")` seed liveness(`lifecycle.service.ts:94`);拆成 `docker|opensandbox` 后 `"sandbox"` 这个筛值失效,改为**按 container placement 发现**——`WorkerRegistry` 增 `findRunningByPlacement("container")`(行按 `runtimeType`→`placementKind` 映射,或查所有 container 类型集合)。否则重启后容器 owner 不会被 `touch`、进不了后续 fence。

## 6. 跨模块契约改动

- `packages/shared` `AcquireInstanceResult`:去 `cancelledBeforeReady`,只留 `{ outcome:"ready"; runtimeInstanceId } | { outcome:"error"; error }`。
- `run/execution/worker-run.executor.ts`:删 `cancelledBeforeReady` 分支(取消由 run 层自有 `state.cancelled` 在 `ready` 分支自处理,line 92-98 已具备);`releaseInstanceForRun` 语义降为"只清 worker-manager fence 索引",不再释放实例引用(回收已砍)。
- 同步更新 `worker-run.executor.spec.ts` 等相关 spec。

## 7. 保留不动
handshake(`WorkerHandshakeStore` / token guard)、liveness(watchdog / fence)、admin 查询、orphan 与跨进程重启复用语义、引擎实现(降为内部)。

## 8. 风险

| 风险 | 说明 | 处置 |
|---|---|---|
| 空闲容器不回收 | 砍 idle watchdog 后容器常驻到显式 teardown/fence,资源占用上升 | 已接受;回收作为后续独立项 |
| `runtimeType` 域值变化 | `local\|sandbox → local\|docker\|opensandbox`,牵动 placement / registry 行 / RuntimeTarget | DB 开发期重建(旧 plan 已定无迁移);全量扫描读 `runtimeType` 处,改读 `placementKind` 或直接用 type |
| idle-resume 去除 | `lastStoppedRuntimeInstanceId` 复用路径删除 | 确认仅 idle 复用被删,**跨重启复用不受影响**(回归覆盖) |
| 契约收窄影响 run | 删 `cancelledBeforeReady` | 依赖 run 层自有 cancelled 处理;补取消路径单测 |

## 9. 测试计划
- runtime:每 provider 单测(prepare/launch/teardown 分支 + `type`/`placementKind` 自声明);`registry.resolve` 命中/未知抛错。
- worker-manager:`WorkerProvisioner` 序列单测(ready / error / 同 owner 并发去重);门面 fence 路径。
- run:`worker-run.executor` 去 `cancelledBeforeReady` 后的取消/失败/就绪路径。
- 全量 `pnpm typecheck` + **eslint(type-aware)** + `pnpm test:server`。

## 10. 落地顺序(粗)
1. `packages/shared` 契约收窄(`AcquireInstanceResult`)。
2. runtime:`RuntimeProvider` 接口 + 注册表 + 三 provider + `RuntimeService` 泛型化 + placement trait + `runtimeType` 域值迁移。
3. worker-manager:`WorkerProvisioner` + 门面收敛 + 删两 executor + 砍回收。
4. run:去 `cancelledBeforeReady` 分支。
5. 全量校验。

> 细粒度步骤在实现计划(writing-plans)展开。

## 11. 收尾核对(已完成)

原开放问题 Q1–Q5 已上升为正文决策:Q1 见 §5 provisioner、Q5 见 §5 门面、Q2/Q3/Q4 见 §4.1。

- **Q1 现状核对已完成 → 确认 A(复用)即现状,零成本**:`worker-token.guard.ts:49` 的 token 校验读 DB 行 `findActiveByOwnerId().startToken`(startToken 入库、非内存),重启后旧 worker 带原 token 继续 poll 能过;`lifecycle.service.ts:74-98` bootstrap 对 sandbox running 行**不清、只 `livenessStore.touch()`** 给心跳窗口(注释明示盲目清容器是已移除的旧教训),仅 local 行杀孤儿。故容器跨重启保留+复用即现状,A 无需任何持久化改造。(`worker-access-key-not-persisted` 记忆记的是已移除的旧行为,已更正。)
