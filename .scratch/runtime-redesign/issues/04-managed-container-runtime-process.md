# 04 — managed docker/opensandbox 起独立 runtime 进程 + supervisor

- Type: task
- Status: pending
- Blocked by: 01, 03

## 目标

混合方案核心:managed docker/opensandbox 起独立 runtime 进程(跑 apps/runtime),经 loopback 隧道 RPC launch/stop/destroy。进程崩了 supervisor 自动重启。managed native 仍留 server 进程内(不动)。

## 依据

- design.md §1(混合方案)、§4.1(进程定位)、§5.6(执行拓扑)、§5.7(supervisor/B1)
- wm-0002(start/stop/destroy 契约保留)

## 范围

**server 侧 fork managed 容器 runtime 进程**:
- 新增 supervisor(位置:`apps/server/src/runtime/managed/` 或 worker-manager 子目录,按 backend-architecture 判定):
  - server 启动时按 allowedRuntimeTypes,docker/opensandbox 各 fork 一个 apps/runtime 进程
  - 注入 loopback server 地址 + managed token(预生成,存 Runtime 行 tokenHash,非空)
  - 记 runtime 进程 pid,监听 exit;崩了自动重启(退避策略:立即→指数退避封顶)
  - 重启后 runtime 进程重新连 server(loopback 隧道)
- `apps/server/src/runtime/runtime.service.ts` —— onApplicationBootstrap 对 docker/opensandbox 不再 upsert 后直读,改为 fork 进程 + 等注册

**runtime 进程侧**(apps/runtime,复用 registered 现有逻辑):
- `apps/runtime/src/registered/tunnel.ts` + `launcher.ts` —— 现状已支持 launch/stop/destroy 经隧道 RPC,managed 复用同一份代码,只是连 loopback
- managed token 的注入:apps/runtime config 接受 managed 模式(区别 registered 的 admin 发 token)

**断连语义分治**(design.md §4.3):
- managed 容器隧道断连 → 视为「进程重启中」,等重连宽限,不立刻判死
- registered 隧道断连 → 维持现状判死
- `apps/server/src/runtime/gateway/runtime-tunnel.handler.ts` + `runtime-liveness.watchdog.ts` —— 按 source 分治断连处理

**孤儿 worker 清理**(design.md §5.7):
- runtime 进程崩时它 fork 的 worker 成孤儿
- 重启后的 runtime 进程负责清理(它知道自己的 worker);或 server 保留按 pid 兜底杀孤儿(destroy 的孤儿清理不完全迁出 server——这点在 ticket 里定:选 runtime 进程自清理,server 不持 pid)

## 不做

- 不碰 managed native(留 server 进程内,现状)
- 不补能力 RPC(list-files 等,那是 05)
- 不实现 ②(远程但 server 管)

## 验收

1. `pnpm typecheck` + `pnpm test:server` 过
2. `pnpm dev`,managed-docker runtime 进程被 server fork 起来,loopback 隧道连上,注册成功
3. 手工 kill managed-docker runtime 进程,supervisor 自动重启,重连成功
4. runtime 进程崩时其 worker 被清理(不泄漏)
5. managed native 仍走 server 进程内(不受影响)

## 依赖

01(命名 managed/native)、03(workerId 协议身份)
