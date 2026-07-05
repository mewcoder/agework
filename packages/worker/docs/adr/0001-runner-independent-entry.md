# Runner 独立入口 + 显式 env 白名单,取代共享入口的角色自派发

worker 常驻进程为每个 run fork 一个 runner 子进程执行 agent。此前 runner 与 worker(以及
`apps/runtime` 里的 manager)共享同一份可执行入口文件,靠 `AGEWORK_WORKER_ROLE` 环境变量在
运行时分派角色,fork 子进程时把 `process.env` 整份 `spread` 下去。这带来两个问题:分派逻辑
分散在两层入口文件里(`apps/runtime/src/main.ts` 和 `packages/worker/src/main.ts` 各判一次同
一个环境变量);runner 因为继承 worker 的全部环境变量,拿到了 `AGEWORK_WORKER_API_BASE` /
`AGEWORK_WORKER_START_TOKEN` 这类它自己从不使用的敏感凭据——runner 全程只经 IPC channel 和
worker 通信,从不直连 server。

决定:runner 拥有独立的物理入口文件(`apps/runtime` 内与 worker/manager 入口并列的
`runner.ts`,直接调用 `packages/worker` 导出的 `runRunner()`),不再靠共享入口 + env 分派启动。
`packages/worker` 自身原本承担同类自执行分派的 `main.ts` 整体删除,包改为纯导出
`runWorker`/`runRunner`(`package.json` 的 `exports` 指向 `worker.ts`)。fork runner 时的环境
变量从整份继承 `process.env` 改为显式白名单:OS 基础环境(`PATH`/`HOME` 等,供 runner 内部再
fork 的 agent CLI 子进程使用)+ runner 真正读取的少数 `AGEWORK_WORKER_*` 变量,明确排除
worker 自己的 server 认证凭据。

manager→worker 这一层(`packages/providers` 的 local provider 里同样整份 spread
`process.env`)与本决定是同一类问题,但不在这次范围内,留作后续单独决定,不在这里一并处理。

## Consequences

- `apps/runtime` 的构建从单入口改成多入口(esbuild 产出 `dist/main.js` + `dist/runner.js`
  两个独立产物),Docker 镜像与 `apps/server/scripts/embed-runtime.mjs` 的内嵌产物都要跟着复制
  两个文件而不是一个。
- `docs/todo/runtime-worker-module-refactor.md` 里"role 分派沿用现有 env 机制"一节所述的
  worker/runner 二级分派方案,以及"`packages/worker/main.ts` 保留到 Phase 4"的过渡状态,均由本
  决定取代;文档需要同步更新,不再以旧述为准。
- `packages/worker/Dockerfile`、`package.docker.json` 及自身的 esbuild build 脚本随 `main.ts`
  删除一并清理(此前已因产物无活路径引用被标记为孤儿)。
