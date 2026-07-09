# 06 — LocalRuntime 收窄:只服务 native

- Type: task
- Status: pending
- Blocked by: 05

## 目标

LocalRuntime 职责收窄到只服务 managed native(进程内直读 fs/git)。docker/opensandbox 的能力已迁到各自 runtime 进程(05),LocalRuntime 不再越权替它们干活。

## 依据

- design.md §2.3(职责归属)、§5.2(能力归属)、§8(模块边界)
- 解决最初痛点:LocalRuntime 越权替 docker/opensandbox 干文件/git

## 范围

- `apps/server/src/runtime/local/local-runtime.ts` —— 保留,但明确只服务 native。listFiles/readFile/listChangedFiles/readFileDiff 仍直读本机 fs/git(native 的 workspace 在本机硬盘)
- `apps/server/src/runtime/runtime.service.ts:74-83`(runtimeFor)—— 路由分治:
  - managed native → LocalRuntime(进程内直读)
  - managed docker/opensandbox + registered → RemoteRuntime(隧道 RPC,05 已补能力)
- `apps/server/src/runtime/runtime.service.ts:291-346` —— listFiles 等方法按 runtimeType/source 分治:native 调 localRuntime;其余调 RemoteRuntime(隧道)
- 删 LocalRuntime 里替 docker/opensandbox 干活的越权路径(如果有的话,grep 确认)

## 不做

- 不删 LocalRuntime 类(native 还要用它直读)
- 不改 native 的直读逻辑(现状已验证 10-50ms)
- 不碰 worker 文件通道(07)

## 验收

1. `pnpm typecheck` + `pnpm test:server` 过
2. native 文件/git 走进程内直读(LocalRuntime),性能仍 10-50ms
3. docker/opensandbox/registered 文件/git 走隧道 RPC(不经 LocalRuntime)
4. LocalRuntime 不再被 docker/opensandbox 路径调用(grep 确认)

## 依赖

05(容器能力 RPC 已就位,LocalRuntime 才能放手)
