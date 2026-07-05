# Runtime / Worker 模块重构

> 本文是执行侧重构的**唯一执行文档**:把 worker 内置进 Runtime,支持两种启动模式
> (Server 直接控制 / 远程主动注册),并定义包与目录组织、Runtime 接口、通信、隔离/数据模型与 Phase。
>
> 已吸收并取代 `server-runtime-redesign-plan.md`(该文档删除)。与旧稿冲突处以本文为准,两处定案:
> ① worker **内置** Runtime、同一镜像产物(旧稿"runtime 包不含 worker、worker 独立镜像"作废);
> ② 包名 **`packages/providers`**(旧稿 `packages/runtime-provider` 作废)。
> 命名基线:`worker-manager` / `RuntimeProvider` / `isolationScope`。

## 当前进度(交接看这里)

| Phase | 状态 | commit |
|---|---|---|
| 0a 机械搬移 | ✅ 完成 | `5ac4645e`(providers 改名)、`80eace0f`(worker 搬 packages/) |
| 0b 依赖倒置 | ✅ 完成 | `84984b0d`(Runtime 接口 + LocalRuntime + 4 seam 走 runtimeFor(null)) |
| 1 注册骨架 | ✅ 完成 | `aabeee2f`(server:Runtime 表/配对 API/隧道端点/判死)、`c32978f2`(apps/runtime:manager 注册/心跳/重连)、`081df4f3`(shared 值内联修复) |
| 2 Registered 跑通 | ✅ 完成 | `1377afa7`(providers 回调拆解)、`41e1dd60`(RemoteRuntime+隧道 RPC)、`68a3e93a`(manager launcher/registry) |
| 3 前端 + 全链路接线 | ✅ 完成 | `0a06e477`(配对页)、`3b344ebd`(Workspace.runtimeId 数据层+校验)、`451bed5e`(run 路径接线+stop/destroy 路由修复)、`d9ff8da7`(workspace-dialog.tsx Registered 分支) |
| 4 收尾 | ✅ 完成 | `9418d7b1`(Managed-local 内嵌 runtime 产物,去 @agework/worker 依赖)、`a54256c8`(Managed-docker 统一到 agework/runtime 镜像)、`7a01d842`(register 握手带版本,server 只告警放行)、`3f030635`(server build 前置 runtime build,防内嵌产物过期)、本提交(docs) |

**Phase 2 落地摘要**(两个前置拍板点都按推荐方案定案并已实施):

1. **回调拆解**:`isExpectedRuntimeInstance` → `expectedRuntimeInstanceId: string | null` 数据字段
   (provisioner 用 `registry.findBindingWithResource()` 预先查好);`onWorkerExit` 从 ctx 移出,
   变成 `RuntimeProvider.start()`/`Runtime.start()` 的可选第二参数(仅 LocalRuntime(Provider)
   真正接线,RemoteRuntime 不传)。`RuntimeLaunchContext` 现在完全可序列化。
2. **`Workspace.runtimeId` 接线维持不碰**(按确认方案):Phase 2 只证明 RemoteRuntime 本身工作
   正确,`WorkerProvisioner` 仍写死 `runtimeFor(null)`;真正接上 `workspace.runtimeId` 留给 Phase 3
   (需要前端选 Runtime 的 UI 才有意义)。
3. **隧道协议**:launch/stop/destroy 复用现有 JSON-RPC 2.0 信封(`packages/shared/protocol/rpc.ts`
   的 `RpcRequest`/`RpcResponse`),没有新造包装;`RuntimeLaunchRpcParams` 不含 `runtimeType`——
   manager 实例专一,已知自己固定的类型,不用传。
4. **manager 配置面新增**:`--worker-image`(docker/opensandbox 必填)、`--log-dir`、
   `--worker-entry`/`--tsx-cli`(local 必填,显式指定不猜测)。
5. **已知缺口,未解决(留给未来需要 Registered+local 时再处理)**:local 模式下 manager 把自己
   bundle 成单文件 dist/main.js 后,没有独立的 `@agework/worker` 模块可 `require.resolve`,
   `--worker-entry`/`--tsx-cli` 必须由操作者显式指定 fork 目标(没有做“fork 自己”的自动推导——
   dev 用 tsx、prod 是纯 JS,两种场景的正确 fork 方式不同,自动猜测风险大于收益)。Registered
   的旗舰场景是 docker,这个缺口不阻塞它。
6. **端到端验证**(一次性脚本,不进常规单测套件——起真实子进程/真实网络,不适合塞进每次
   `pnpm test` 都跑的快速单测):真实 `apps/runtime` manager 子进程(tsx 直跑源码,`--runtime local`)
   出站连上一个真实 `RuntimeTunnelHandler`,注册成功后,server 侧直接构造 `RemoteRuntime` 调
   `start/stop/destroy`——全链路走真隧道 RPC,manager 的 `Launcher` 真调 `packages/providers` 的
   `LocalRuntimeProvider` 真 fork 了一个子进程(用一次性 worker 替身脚本,不依赖 docker/claude-sdk),
   `runtimeInstanceId` 以 `pid:token` 格式经隧道正确传回并 resolve;`destroy()` 真的杀掉了那个
   子进程(验证后无残留进程)。

**交接注意**:shared 包源码直连消费,`protocol/index.ts` 等入口**跨文件 re-export 运行时值会
ERR_MODULE_NOT_FOUND**,值必须内联在入口文件(见 `common/index.ts` 的 generateId 注释;
类型导出不受限)。验证基线:`pnpm typecheck` + eslint + 单测 + `pnpm build` 全绿,改动执行链路时
建议真机起 dev server 冒烟(Phase 1/Phase 2 都靠这个抓到了坑——Phase 1 的 ERR_MODULE_NOT_FOUND、
Phase 2 的 `@agework/providers` 依赖漏加)。

**Phase 3 落地摘要(本轮范围:只做配对页,用户明确选定)**:

用户在"workspace 创建器加 Runtime 选择"和"只做我的运行环境配对页"之间明确选了后者——workspace
创建器(`workspace-dialog.tsx`)是个已在工作的 700 行复杂表单,现在也没有任何真实 workspace 能
选 Registered runtime(`WorkerProvisioner` 仍写死 `runtimeFor(null)`),先不碰它,风险和收益不对等。

已交付:
- `apps/web/src/pages/settings/runtime.tsx` + `runtime/issued-runtime-token-dialog.tsx`:新用户
  设置页"我的运行环境"(导航项在 `MonitorIcon`),DataTable 列出 list/create/delete,创建成功后
  弹一次性配对命令(`agework-runtime --server <url> --token <token> --runtime docker`),关闭后
  token 不可再取(后端只存 sha256,与 admin 的一次性密码弹窗同一模式)。
- `apps/web/src/api/runtimes.ts` + `apps/web/src/hooks/use-runtime.ts`:照抄 `workspaces.ts`/
  `use-workspace.ts` 的 api client + react-query hooks 结构。
- 验证:typecheck/lint(0 新增问题,仅剩改动前就有的 6 个 shadcn 组件存量 lint 错误)/build 全绿;
  web 单测 258→261(新增 `runtimes.test.ts`);**真机验证**——起真实 server(端口 3100)+ 真实
  vite dev server(5183,代理到 3100),通过实际的前端会走的 dev proxy 路径 `curl` 了
  create→list→delete→list 全链路,响应结构与前端 TS 类型完全对上。**没有**在真实浏览器里点击
  验证(这个环境没有浏览器自动化工具),这一点如实告知,不谎称"浏览器验证过"。

**Phase 3 后续:workspace 全链路接线(用户确认继续做完整版)**:

在配对页基础上,把 Registered Runtime 真正接进 workspace 创建 + run 触发的完整链路。过程中发现
并修了两个比"缺功能"更严重的既有正确性缺口:

1. **workspace 目录语义分叉**:`WorkspaceDirectoryHandler.prepareCreate()` 原本对所有 workspace
   做真实本机文件系统操作(`mkdirSync`/`realpathSync`/`statSync`/`git clone`)。Registered
   workspace 的目录在远程机器上,server 摸不到——新增 `remote` 分支:必须手填绝对路径、不支持
   Git 克隆,完全跳过文件系统校验,`directorySource="remote"`、`ownsDirectory=false`(删除不
   `rmSync`)。
2. **stop/destroy 从未真正路由到 RemoteRuntime**(比 1 更严重,是静默正确性 bug,不是缺功能):
   `WorkerProvisioner.stop/destroy` 硬编码 `runtimeFor(null)`,对 Registered runtime 上的 worker,
   idle timeout / workspace 删除 / fence 判死全部会尝试在本机 docker/进程表操作一个只存在于远程
   机器的载体,静默失败、永久泄漏,且这条路径此前完全没有被测试覆盖过。修法:`WorkerInstance` 加
   `runtimeId` 列记录载体绑定的 Registered Runtime,`RuntimeInstanceRef` 加 `targetRuntimeId`,
   三处构造 ref 的调用点(`worker-manager.service.ts` 两处、`lifecycle.handler.ts` 一处)都补上;
   顺带发现并修了第三处:重启孤儿回收(`onApplicationBootstrap`)误把 `runtimeType==="local"`
   当作"一定是 Managed"——但 Registered manager 也能配成 `--runtime local`,已改成只处理
   `runtimeId` 为空的行,不误杀远程机器上仍然健康的 worker。

其余接线:`RunLauncher.getPlacement()` 对 Registered workspace 跳过部署级 allow-list 校验(那是
Managed 专属策略,该 workspace 的 runtimeType/isolationScope 已在创建时对着目标 Runtime 自己的
注册类型/能力矩阵校验过);`workspace-dialog.tsx` 按 Explore 调研的方案 A 加了顶层"运行位置"
切换,新状态与原 Managed 状态机完全隔离,零配对机器的用户看到的表单不变。

**真机验证**(本轮最扎实的一次):起真实 server + 真实 `apps/runtime` manager(`--runtime local`,
worker 替身脚本)→ 真实 HTTP 配对(`/runtimes/create`)→ 真实创建 workspace 带 `runtimeId`(响应
`directorySource="remote"`、`runtimeType` 从目标 Runtime 派生,未验证/未创建任何本机目录)→ 真实
创建 model provider + conversation → 真实 POST `/conversations/agent/run` 触发一次 run → **manager
日志(运行在完全独立的进程里)打出 `LocalRuntimeProvider local worker forked` 并带着这次 run 的
runId**——证明 `workspace.runtimeId` 从真实 HTTP 请求一路经 `getRunContext → RunLauncher →
WorkerProvisioner → RemoteRuntime → 隧道 RPC → 远程 manager → 真实 fork` 全部走通,不是靠单测
mock 拼出来的信心。验证完毕清空所有测试数据(workspace/model-provider/runtime)并确认无残留进程。

`pnpm typecheck` + `pnpm build` + 全部 5 个包测试套件(server 832 / web 261 / runtime 26 /
providers 44 / shared 21,合计 1184)+ eslint 全绿,eslint 剩余问题均为改动前已存在的存量基线
(server 2 条 floating-promise 警告、web 6 个 shadcn 组件的 react-refresh 错误 + 4 条第三方库
warning),没有引入新问题。

**Phase 4 落地摘要(本轮:server 去掉 `require.resolve('@agework/worker')`,worker-manager
数据面/物理面正式分家)**:

§13 三个产物分发问题(开工前先与用户对齐,不边做边拍板)的定案与落地:
1. **Managed-docker 镜像 tag 怎么跟 server 版本对齐?** → 维持 `:latest`,版本正确性靠
   register 握手兜底。落地:`DEFAULT_WORKER_IMAGE` 改名 `DEFAULT_RUNTIME_IMAGE`,值
   `agework/runtime:latest`(commit `a54256c8`)。`scripts/build-worker.mjs` 改 build
   `apps/runtime/Dockerfile`(原 `packages/worker/Dockerfile` 退役为孤儿,见下)。
2. **Managed-local 的 spawn 路径从哪来?** → server 发布物内嵌一份。落地(commit `9418d7b1`):
   `apps/server/scripts/embed-runtime.mjs` 在 server build 末尾把 `apps/runtime/dist/main.js`
   复制到 `apps/server/dist/agework-runtime/main.mjs`;`runtime-config.ts` 的 `resolveRuntimeEntry`
   解析顺序 = `AGEWORK_RUNTIME_LOCAL_ENTRY` 覆盖 → 内嵌产物(dev/prod 都走这条) → dev 回退到
   workspace 里已构建的 `@agework/runtime` dist。`LocalRuntimeProvider` 不再 fork `tsx`,改成
   `node` 直跑产物 `.mjs` 并注入 `AGEWORK_WORKER_ROLE=worker`(同一产物以 worker 角色启动)。
   server 的 `package.json` 去掉 `@agework/worker` 与 `tsx` 两个 prod 依赖,新增 `@agework/runtime`
   作为 devDependency(给 build 顺序 + dev 回退用)。
3. **版本偏差策略:server 对不齐时拒绝还是告警?** → 告警+放行。落地(commit `7a01d842`):
   `@agework/shared` 新增 `AGEWORK_VERSION` 常量(源码内联,每次发版手动 bump);worker register
   (`WorkerRegisterRequest`)与 manager 隧道 register(`RuntimeTunnelRegisterMessage`)都多带
   一个 `version`;server 端 `WorkerManagerService.registerWorker` 与 `RuntimeTunnelHandler`
   的 register 分支收到版本后与本地 `AGEWORK_VERSION` 比对,不一致只 `logger.warn` + 放行,
   不阻断(主要兜底 Registered 远程 manager 单独构建后与 server 漂移)。

顺带收尾 Phase 1/2 漏下的 `apps/runtime` 的 `LocalProviderConfig` 字段(commit `7a01d842` 一并):
`manager/launcher.ts` 与 `config.ts` 的 `workerEntryPath`/`tsxCliPath` 双字段合并成单一
`runtimeEntryPath`(`--runtime-entry` / `AGEWORK_RUNTIME_ENTRY`),不传则默认 fork manager
自身(`process.argv[1]`)——Registered+local 场景下 manager 与 worker 共用同一 bundle,默认即
正确,操作者不再需要手填 `--worker-entry`/`--tsx-cli`。

**Dev 构建陷阱与修复(commit `3f030635`)**:发现 `pnpm --filter server build` 走的是 server
package 自己的 npm script,**不经 turbo 的 `^build` 调度**,导致 `embed-runtime.mjs` 拷贝的是
上一次手动 build 留下的旧 `apps/runtime/dist/main.js`(曾因此给 Managed fork 出一份**缺
`version` 字段**的过期 worker,被真机 fork 抓到)。修法:server `build` 脚本前置
`pnpm --filter @agework/runtime build`,保证每次 server build 都先 esbuild 出最新 runtime
bundle(150ms)。复现验证:去掉 worker register 的 `version` 字段后 `pnpm --filter server
build`,内嵌 `.mjs` 的 `version:AGEWORK_VERSION` 计数 2→1;还原后 1→2。此前不前置时计数保持
2(读旧 dist)。**交接提醒**:改 worker/manager 源码后,用 `pnpm --filter server build` 或
`pnpm build`(turbo,因 `@agework/runtime` 是 server devDep、`^build` 会带它)都行,两者现在
都能拿到新鲜内嵌产物。

**孤儿产物(本轮只标记不删,留给后续清理)**:
- `packages/worker/Dockerfile` + `packages/worker/package.docker.json`:原独立 worker 镜像的
  构建文件。`build-worker.mjs` 的 `WORKER_DOCKERFILE` 已改指 `apps/runtime/Dockerfile`,这两个
  文件不再被任何活路径引用,可删;`.dockerignore` 里 `!packages/worker/dist/main.js` 这条豁免
  也随之失效(只 `!apps/runtime/dist/main.js` 还有用)。
- `docs/superpowers/{plans,specs}` 里多处仍写 `DEFAULT_WORKER_IMAGE`(历史设计稿),与现
  `DEFAULT_RUNTIME_IMAGE` 不符——属历史记录,不追溯改写,以本进度表/§13 为准。

**真机验证**:
- **Managed-docker(commit 2)**:`docker build -t agework/runtime:latest -f apps/runtime/Dockerfile .`
  成功(修了 `.dockerignore` 放行 `apps/runtime/dist/main.js`);`docker run` 注入
  `AGEWORK_WORKER_ROLE=worker` + apiBase 指向一个真 capture HTTP server,容器以
  `workerRole:"worker"` 启动、`POST /worker/owners/<id>/register` 带正确 `{startToken,pid}`、
  进入 command long-poll;不注入 role 则走 `runManager`(Registered 远程 manager 路径)——
  证明 worker 镜像 = runtime 镜像 = 同一产物,role 仅由 env 决定。
- **Managed-local(commit 1)**:fork `apps/server/dist/agework-runtime/main.mjs`(ESM,从 server 的
  CommonJS 进程 fork),解析外部化的 SDK 从 server `node_modules`,role dispatch 起成 worker,
  真实 `POST register` 命中 capture server。
- **版本字段(commit 3)**:重新 build 后 fork 同一内嵌产物,register body 现带
  `"version":"0.0.1"`;bundle 含两处 `version: AGEWORK_VERSION`(worker-http + manager tunnel)。
- 验证基线:`pnpm typecheck` + eslint(server 仅 2 条改动前就有的 floating-promise 警告)+ 单测
  (server 832 / providers 44 / worker 45 / runtime 27 / shared 21)+ `pnpm build` 全绿。

---

## 0. 目标

把「起环境 + 执行 agent」收敛成**一个 Runtime 模块**,worker 内置其中:

- **Worker 内置于 Runtime**:Runtime 直接持有 worker 代码(子文件夹),起 worker = 起自己。
- **Worker 启动后自己和 server 通信**:worker 出站直连 server(事件/命令),不经 Runtime 中转(方案 A)。
- **两种启动模式**:
  - **Managed**:Server 通过 Runtime 模块**直接启动**(in-process),用内置 worker 起 worker。
  - **Registered**:Runtime 在**别的机器**启动、**主动注册**到 Server,Server 经隧道控制它。

---

## 1. 核心结构:Worker 内置于 Runtime

```
Runtime(一个产物 / 一个镜像 = agework-runtime)
├── manager   起 worker(用 providers)、连 server、管生命周期      ← apps/runtime
└── worker    跑 agent(用 adapters)、启动后直连 server            ← packages/worker,构建期打进同一产物
    ├── worker(常驻)  连 server、收 launch-run、RunnerManager spawn runner
    └── runner         per-run 执行单元,跑 adapter
```

- **worker 是独立源码包 `packages/worker`**(现 `apps/worker` 纯平移,npm 名 `@agework/worker` 不变),
  保留 worker/runner 两级结构与 `AGEWORK_WORKER_ROLE` 分派;`apps/runtime` 依赖它并**打进同一
  bundle/镜像**。"内置" = 构建期同一产物,不是子文件夹。
- Runtime **起 worker = 起自己**(docker run 自己 / spawn 自己产物的 worker 角色,bundle 内含 worker),
  不去外面拿 worker 入口/镜像。
- worker 镜像 = Runtime 镜像 = **同一个产物**,版本天然一致。
- worker 起来后**自己连 server**(worker-http),Runtime 不做数据中转。

---

## 2. 两种启动模式

### 2.1 Managed —— Server 直接控制(in-process)

```
Server ──直接调 Runtime 接口──▶ Runtime(in-process,用 packages/providers)
                                   │ 起 worker(docker run agework-runtime / spawn)
                                   ▼
                                 Worker ──出站直连──▶ Server(事件/命令)
```

- Server **够得到**环境,通过 `Runtime` 接口的 **`LocalRuntime`** 实现,in-process 调 `packages/providers` 起 worker。
- 无独立 runtime 进程;Runtime 逻辑跑在 server 进程里。
- Worker 起来后直连 server。

### 2.2 Registered —— 远程主动注册(独立进程)

```
远程机器:agework-runtime 启动 ──出站注册──▶ Server(控制隧道)
Server ──隧道下发 launch──▶ agework-runtime/manager
                              │ 起 worker(docker run 自己)
                              ▼
                            Worker ──出站直连──▶ Server(事件/命令)
```

- Server **够不到**环境:`agework-runtime` 在远程机器出站注册,Server 经**控制隧道**发 launch/stop。
- Server 侧通过 `Runtime` 接口的 **`RemoteRuntime`** 实现,把调用转成隧道 RPC。
- Worker 仍出站直连 server。

**两模式唯一区别:谁把 worker 拉起来**(Server in-process / 远程 manager);**worker→server 通信完全一样**。

---

## 3. 包 / 模块组织

```
packages/  (库)
├── providers    起/停/毁载体(local/docker/opensandbox);server 与 runtime 都用
├── worker       执行单元(常驻 worker + runner);apps/runtime 依赖并 bundle
├── adapters     agent 实现(claude / codex);worker 用
└── shared       协议(worker↔server + 控制隧道)

apps/  (进程)
├── server       控制平面;import providers;✗ 不 import worker(终态;过渡期仅 resolve 其入口路径)
├── runtime      agework-runtime:入口三分派 + manager;依赖 worker+providers 打成一个镜像(Phase 1 创建)
├── web
└── desktop
```

依赖方向:
```
apps/server      → packages/providers + packages/shared   (✗ 不依赖 worker,终态;过渡期 resolve 入口)
apps/runtime     → packages/providers + packages/worker + packages/shared
packages/worker  → packages/adapters + packages/shared
providers ─╳→ worker   (不 import,只运行时 spawn/run 产物)
```

> **为什么 providers 是独立库**:Managed 时 Server 也要用它 in-process 起 worker,所以必须能被 server 和
> runtime 两处复用。**为什么 worker 也是独立库**:让"角色 × 依赖"从目录纪律变成包边界(worker 的依赖
> 写死在自己 package.json),且 0a 搬家时 server 的 `require.resolve("@agework/worker")` 零改动;
> apps/runtime 依赖它只为 bundle 成同一产物与入口转发。
>
> **两条正交的轴,别混**:providers 是**载体类型轴**(local/docker/opensandbox,"worker 的壳是什么");
> `LocalRuntime`/`RemoteRuntime` 是**部署形态轴**("server 够不够得到环境")。任意组合合法——
> RemoteRuntime 背后的远程 manager 内部同样用 providers 起载体。

---

## 4. `apps/runtime` 内部结构(agework-runtime)

```
apps/runtime/                 (Phase 1 创建)
├── package.json              依赖 packages/{providers, worker, shared}
├── Dockerfile                打成 agework-runtime 镜像(= worker 镜像本身)
├── build.config.ts           打成单产物 bundle(含 manager + worker 包代码)
└── src/
    ├── main.ts               总入口三分派:AGEWORK_WORKER_ROLE 未设置 → manager;
    │                          =worker|runner → 调 @agework/worker 导出的 runWorker/runRunner
    ├── cli.ts                manager 参数:--server / --token / --runtime <type>
    ├── config.ts             server 地址 / token / runtime 类型
    │
    └── manager/              ── 管理侧(仅 Registered 进程内激活)──
        ├── tunnel.ts         控制隧道客户端:出站连 server、注册/上报能力/重连、收 launch/stop
        │                     (注册是隧道建连握手的第一步,同一条 WS 状态机,不单拆文件)
        ├── launcher.ts       用 providers 起/停/毁 worker(docker run 自己 / spawn 自己产物的 worker 角色)
        └── registry.ts       本机活载体记录 + 载体监督(容器/进程还在否、残留清理)
```

worker 包内部(= 现 `apps/worker/src` 原样,0a 纯平移):

```
packages/worker/src/
├── main.ts               包自己的可执行入口(worker|runner 二分派)——Managed local 下 server
│                          仍直接 fork 它,保留到 Phase 4;之后只留 runWorker/runRunner 导出
├── worker.ts             常驻 worker(runWorker):register 握手、command long-poll、管 runner 生死
├── runner-manager.ts     RunnerManager:spawn per-run runner(注入 role=runner)、监督、IPC 桥接
├── commands.ts           server 下发 command 的解析/分发/结果回传
├── logging/              结构化日志(worker-log、trace)
├── agent/                runner 侧(runRunner):跑 packages/adapters、产出 event
└── transport/            worker-http.ts(数据面出站直连,startToken)+ runner-ipc.ts(worker↔runner)
```

- 角色 × 依赖是**包边界**:`packages/worker` 只依赖 adapters+shared;apps/runtime 的 `manager/` 只
  import providers(对 worker 包只做入口转发 + bundle,不深入其内部模块)。越界 import = 分层破了。
- Managed 模式下 `apps/runtime` 整体不出场(`LocalRuntime` 顶位,server 直接 fork / docker run worker 产物)。
- logging 归属 Phase 1 按真实使用再定(留 worker 包 / 上提 shared / manager 自带),不预建 common/。

- **role 分派沿用现有 env 机制**:`AGEWORK_WORKER_ROLE` 未设置(远程机器直接启动)→ manager;
  `=worker|runner` → 对应 worker 角色(由 launcher / RunnerManager 注入)。不引入 `--role` flag,
  也不做隐式"按上下文猜"。
- **worker 心跳/判死真源在 server**(两模式 worker 都直连 server 事件端点,server 侧 liveness 一套通吃);
  manager 不做心跳判死,只做本机载体监督。
- `manager/launcher` 起 worker:`docker run agework-runtime <worker 入口>` / `spawn(self, <worker 入口>)`。

---

## 5. Runtime 接口(Server 怎么用)

Server 依赖一个 `Runtime` 接口(**控制面**:起/停/毁 worker),两实现,server 无感:

```ts
interface Runtime {
  start(ctx): Promise<{ runtimeInstanceId }>;   // 起 worker
  stop(ref) / destroy(ref);
}
```

| 实现 | 用于 | 怎么做 |
|---|---|---|
| **`LocalRuntime`** | Managed | `import packages/providers`,in-process 起 worker |
| **`RemoteRuntime`** | Registered | 经控制隧道把 start/stop/destroy 转成 RPC → 远程 `agework-runtime/manager` → 它本地 providers |

Server 只写 `runtime.start(ctx)`,不管底层是本机直调还是隧道。

**语义统一、传输不统一**:`Runtime` 接口方法集与控制隧道 RPC 方法集**一一对应**,`RemoteRuntime` 只是把
同样的调用编码上隧道。因此本机跑 Registered(agework-runtime 注册到 localhost server)天然合法,零特判;
将来 server 容器化后够不到宿主 docker 时,本机从 Managed 切 Registered 只是换部署,不改 server 代码。

### RuntimeFileOps —— 暂不实现

文件管理 / 目录发现(浏览、读写「那个 Runtime 上」的目录)**首版不做**,`Runtime` 接口不含 `fileOps()`。
workspace 创建时目录**手填绝对路径**(不做远程浏览)。将来要做时再扩:
`interface RuntimeFileOps { listDir/read/write/createDir }`,Managed 由 server 直读,Registered 经隧道委派
manager 执行,UI 无感。

### 现状 seam(Phase 0b 的插入点)

当前唯一「物理启动离开 server 进程」的 seam 是 `RuntimeService.start/stop/destroy`
(`runtime/runtime.service.ts:48/53/58`),调用方共 5 处:`worker.provisioner.ts:137/191/196` +
`lifecycle.handler.ts:82`(另 `lifecycle.handler.ts:126` 经 provisioner 间接调)。Phase 0b 就是把这
5 个 seam 改调 `runtimeFor(target)` 返回的 `Runtime` 实现;registry / handshake / fence 语义保留。

> 注意:**worker 的 event/command 不走这个接口**——那是 worker 直连 server(§6)。Runtime 接口只管
> 「起 worker」,是控制面。

---

## 6. 通信

### 两条通道
```
① 控制通道(仅 Registered):agework-runtime/manager ⇄ server/runtime-gateway
     出站 WS 隧道;传 launch/stop;runtime token 鉴权
② 事件通道(两模式都有):worker ⇄ server 事件端点
     worker 出站 worker-http;command long-poll + event/status/heartbeat;startToken 鉴权
```

### runtime 侧网络能力
- `common/server-conn`(连接/鉴权)+ `manager/tunnel`(控制隧道)+ `worker/transport`(事件)。
- 协议在 `packages/shared`。

### server 侧对端
```
apps/server:
├── runtime-gateway     接受 agework-runtime 出站控制隧道(WS 服务端)+ registry + 发 RPC(= RemoteRuntime 后端)
└── worker 事件端点      接受 worker 出站(worker-http):command 队列 + event 接收 + register
                          = 现有 worker-manager 的数据面(保留)
```

server 侧落点(按 backend-architecture 规则):

- `LocalRuntime` / `RemoteRuntime` / `Runtime` 接口 → 现有 `apps/server/src/runtime` module
  (`RuntimeService` 演进为面向 `Runtime` 接口的编排入口)。
- `runtime-gateway` → runtime module 的子能力目录 `runtime/gateway/`(internal provider,
  不新建顶层 module;它只服务 RemoteRuntime,无独立调用方)。
- worker 事件端点 → 留在现 `worker-manager` module(数据面),不动。

### 连接方向硬约束
Server **永不反连** Runtime;Registered runtime 永远 **dial-out**(NAT 免疫)。worker 永远出站连 server。

---

## 7. 启动一个 run 的数据流

### Managed
```
1. run 层 → runtimeFor(workspace) = LocalRuntime
2. LocalRuntime.start(ctx) → providers.docker run agework-runtime <worker 入口>(注入 server 地址+token)
3. worker 起来 → 出站连 server 事件端点 → register 握手
4. worker run-loop 跑 adapter → event 出站发 server;command 从 server 拉
```

### Registered
```
1. (前置)远程机器 agework-runtime 已出站注册,runtime-gateway 记录在线
2. run 层 → runtimeFor(workspace) = RemoteRuntime
3. RemoteRuntime.start(ctx) → runtime-gateway 经隧道发 launch → 远程 manager
4. 远程 manager.launcher → docker run agework-runtime <worker 入口>(注入 server 可达地址+token)
5. worker 起来 → 出站连 server 事件端点(与 Managed 同一套)→ register
6. worker run-loop 跑 adapter → event 直连 server;command 从 server 拉
```

两条流程**第 3 步之后完全一样**(worker 直连 server);差别只在第 2-4 步「谁起的 worker」。

---

## 8. 隔离档 / Workspace / 数据模型 / 前端

### 隔离模型:四档 + 能力矩阵

隔离靠**容器复用粒度**,不靠进程拆分 / OS 沙箱:

| 档 | 隔离单元 | 谁共享 | 状态 |
|---|---|---|---|
| **host / none** | 无(裸机器) | 该 owner 所有 workspace+对话 | 启用(local) |
| **user** | 容器(每 user) | 一个用户的多 workspace | 启用 |
| **workspace** | 容器(每 workspace) | 一个 workspace 的多对话 | 启用(**推荐默认**) |
| **conversation** | 一次性 worker(每对话) | 不共享 | **暂不实现**(保留档位) |

- **Runtime 实例专一**:一个实例只承载**一种**运行方式(启动时 `--runtime docker|local` 定死,不传自动探测);
  注册时上报能力矩阵 `{ type, isolationScopes }`。不做「内部支持多种」的全能节点。
- OS 沙箱不做核心;egress 过滤 + 凭据保护单独立项。

### Workspace 模型

**workspace = (Runtime, 那个 Runtime 上的目录)。**

- 创建时:选 Runtime → **手填**「那个 Runtime 上」的目录绝对路径(远程浏览暂不做,见 §5)→ 选隔离档
  (按 Runtime 能力收窄)。
- 目录在执行 Runtime 本地 → 零文件同步、零跨机器挂载(容器内 bind-mount)。
- **绑定 Runtime、不可换**;要换 = 删了重建。

### 状态与恢复

- **真源在 server DB**(`RunEvent` / `Message`),worker/容器可弃;崩溃/容器重启从 DB 兜底。
- 日常恢复走 `agentSessionId` resume;从 `RunEvent` 结构化 replay 到启用 conversation 档时再上。

### 数据模型(字段以 `schema.prisma` 为准)

- **新增 `Runtime` 表**(注册的 Runtime 部署实例):`{ id, name, kind (managed|registered), runtimeType,
  ownerId?, ownerScope, status, lastHeartbeatAt, tokenHash, tokenExpiresAt, capabilities, createdAt, updatedAt }`,
  `@@unique([ownerId, name])`。
- **`Workspace` 加 `runtimeId`**:复用现有 `runtimeType?` / `isolationScope?`,创建时写入,不可改。
- **`WorkerInstance` 加 `runtimeId?`**(载体在哪个 Runtime)。
- ADR-0001:`Runtime` 表(部署实例)≠ carrier;与 `WorkerInstance`(carrier↔worker 1:1)分开。

### 前端交互(概要)

- **workspace 创建器**:运行位置(选 Runtime,选它即定运行方式,**无独立 runtime 类型下拉**)→ 目录
  路径手填输入框 → 隔离档。
- **"我的运行环境"配对页**(Registered):添加 = 配对码,`agework-runtime --server <url> --token <配对码>
  --runtime docker` 出站连来、上报能力;删除 = 撤 token(下次心跳 410 退出);可轮换/看详情。
- **运行时标签**:session 顶部 `🟢 mac-studio · 项目共享`;Runtime 掉线变红。

---

## 9. 从现状迁移

现有 `worker-manager`(`apps/server/src/worker-manager`)**拆两半**:

| 现有部分 | 去向 |
|---|---|
| 数据面:command-queue / command-dispatcher / worker-endpoint / token-guard(worker 直连的对端) | **留 server**(worker 事件端点) |
| 物理面:provisioner / lifecycle(起/停载体) | **进 `LocalRuntime` / providers** |
| liveness / handshake(心跳/判死) | **留 server**(worker 事件端点侧,两模式通用;不下放 manager,避免双实现) |
| registry(活载体记录) | Local 在 server 进程(LocalRuntime),Remote 在远程 manager;只记载体 ref,不含心跳状态 |

> **消重复原则**:LocalRuntime 与 manager 唯一共享的库是 `packages/providers`(起/停/毁载体 +
> worker 启动 spec 组装/env 注入)。心跳判死真源始终在 server,manager 只做本机载体监督,
> 两边不出现平行的 liveness/handshake 实现。

其它:
- `packages/runtime`(provider)→ **`packages/providers`**(改名,让出 Runtime 语义)。
- `apps/worker` → **`packages/worker`**(纯平移,npm 名 `@agework/worker` 不变,保留 worker/runner 两级);
  agent 逻辑留 `packages/adapters`;`apps/runtime`(Phase 1)依赖它 bundle 成同一产物。
- Server 停止 `require.resolve('@agework/worker')`,改为 **docker run/spawn 一个 agework-runtime 可执行**(不 import worker)。

---

## 10. 关键不变量 / 边界

- **Server 不碰 worker 代码**:只调 Runtime 接口(控制)+ 收 worker 事件(数据端点)。
- **Worker 直连 server**:event/command 走 worker-http,不经 Runtime 中转(方案 A)。
- **Worker 内置 Runtime**:起 worker = 起自己;worker 镜像 = runtime 镜像。
- **providers 独立库**:server 与 runtime 复用;不 import worker。
- **连接方向**:server 永不反连 runtime;Registered 永远 dial-out。
- **状态真源在 server DB**(`RunEvent`):worker/容器随时可弃,不在执行侧存不可再生状态。
- **两级心跳**:Runtime 掉线 → 其上所有 worker 标记 lost;worker 掉线 → 单 owner fence。判死真源在 server(§4)。
- **不引入 Runtime 调度器**(首版):`runtimeId` 由用户建 workspace 时选定。
- **worker 复用/新起的决策权在 server**(依据 DB 真源:owner 活跃 worker、隔离档,两模式同一套逻辑);
  Runtime 层只执行"怎么起"。"Runtime 管理 Worker" = 生命周期执行 + 载体监督,**不含调度决策**。
- **两通道独立鉴权**:控制隧道 = runtime 配对 token;事件通道 = worker startToken;互不混用。
- **ADR-0001**:Runtime/agework-runtime 是执行宿主,不是 carrier;carrier↔worker 1:1 不破;Registered
  **严禁容器池化**。
- **向后兼容**:Managed(`runtimeId=null`)= 现状路径,单机零感知。

---

## 11. Phase

- **Phase 0a — 机械搬移(纯 rename/move,不改一行逻辑)**:`packages/runtime`→`packages/providers`
  (npm 名改 `@agework/providers`,server 侧 import 全量替换);`apps/worker`→`packages/worker`
  (npm 名不变,server 零改动)。git 可逐文件跟踪,typecheck + eslint + 单测 + build 全绿即验收。
- **Phase 0b — 依赖倒置(零行为变化)**:抽 `Runtime` 接口;现 `RuntimeService`+worker-manager 物理面 →
  `LocalRuntime`;§5 列出的 5 个 seam 改调 `runtimeFor(target)`。全程 Managed(`runtimeId=null`),逐字节等价。
- **Phase 1 — Runtime 注册骨架**:`Runtime` 表 + registry + Runtime 级心跳/判死(server 侧);**创建
  `apps/runtime`**(入口三分派 + manager + Dockerfile,依赖 worker+providers);manager 出站注册、上报能力;暂不起 worker。
- **Phase 2 — Registered 跑通**:runtime-gateway(隧道服务端)+ `RemoteRuntime`;远程 manager 起 worker;端到端在远程机器跑一次 run。
- **Phase 3 — 前端**:workspace 创建器(选 Runtime + 目录路径手填 + 隔离档)、"我的运行环境"配对页、
  运行时标签(§8 前端交互)。可与 Phase 2 后半并行。
- **Phase 4 — 收尾**:server 去掉对 worker 的 `require.resolve`;worker-manager 数据面/物理面正式分家。
  **前置:先回答 §13 的产物分发问题。**
- **后续可选**:`RuntimeFileOps`(远程目录浏览 / 文件管理,§5);云 Runtime(Managed 但远程可达,
  K8s/云沙箱);conversation 档(serverless worker + `RunEvent` 结构化 replay)。

---

## 12. 命名对照

| 概念 | 用词 |
|---|---|
| 控制平面 | **Server** |
| 执行宿主(环境+执行) | **Runtime** / `agework-runtime`(可执行/镜像) |
| 起载体 | **providers**(`packages/providers`,原 `packages/runtime`) |
| agent 实现 | **adapters**(`packages/adapters`) |
| 执行单元(内置) | **Worker**(`packages/worker`,含常驻 worker + runner 两级;bundle 进 runtime 产物) |
| per-run 执行进程 | **runner**(worker 内部,`AGEWORK_WORKER_ROLE=runner`) |
| 远程管理侧 | **manager**(`apps/runtime/manager`,仅 Registered) |
| server 调的接口 | **Runtime 接口**(`LocalRuntime` / `RemoteRuntime`) |
| server 收隧道 | **runtime-gateway**(runtime module 子能力) |
| server 收 worker | **worker 事件端点**(现 worker-manager 数据面) |
| 隔离键 | **Owner**(userId\|workspaceId,现有) |
| 隔离档 | **isolationScope**(host/user/workspace[/conversation 暂不用],现有,升级为 Runtime 能力矩阵) |
| 判死 | **Fence**(现有,新增 Runtime 级) |

---

## 13. Open questions

### 产物分发(Phase 4 前必须回答)

> **✅ 已在 Phase 4 全部答完并落地**——定案见上方"Phase 4 落地摘要";在此保留原问题作为历史。
> 三个问题分别定案为:① 维持 `:latest`、正确性靠 register 握手兜底;② server 发布物内嵌一份
> runtime bundle;③ 告警+放行。

Phase 4 后 server 不再 `require.resolve('@agework/worker')`,Managed 模式
下 server 起 worker 变成消费一个**外部产物**,但产物从哪来、版本怎么对齐没有答案:

1. docker 场景:`agework-runtime` 镜像 tag 如何与 server 版本对齐?(现在 monorepo import 天然同版本,
   拆开后需要显式 pin:随 server 发布写死 tag / 启动时校验版本握手?)
2. local provider(非 docker)场景:spawn 的可执行路径从哪来?§4 的 "spawn 自己" 只对远程 manager 成立
   (spawner 是 agework-runtime 自己);Managed 时 spawner 是 server 进程,"自己"不成立,需要配置项
   指向 agework-runtime 可执行,或 server 发布物内捆绑一份。
3. 版本偏差策略:worker register 握手时带版本,server 对不齐时拒绝还是告警?

在回答之前,Phase 0-3 期间 server 可继续从 workspace 解析 worker 入口(现状路径),不阻塞前序工作。

### 其它待定(不阻塞动工)

- 同 workspace 多对话并发写冲突 → per-conversation git worktree(并发正确性问题,非隔离,后续)。
- 从 `RunEvent` 结构化 replay 何时做 —— 崩溃恢复增强 / conversation 档前置。
- `Runtime` 归属:owner 是 user 还是 org。
- 云 Runtime 的 provider:复用现有 provider 接口还是独立实现。
