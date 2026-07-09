# 05 — 能力 RPC 补全:tunnel 新增 list-files/read-file/git-diff

- Type: task
- Status: pending
- Blocked by: 04

## 目标

runtime 进程侧隧道 RPC 补全机器级能力:list-files / read-file / list-changed-files / read-file-diff。现状 tunnel.ts 只有 list-dir/create-dir,缺文件预览和 git diff。

## 依据

- design.md §5.5(RPC 方法集)、§5.2(能力归属)、§6(能力判据)
- wm-0005 精确化:registered/docker 文件/git 走隧道 RPC

## 范围

**runtime 进程侧(apps/runtime)**:
- `apps/runtime/src/registered/tunnel.ts:163-187`(dispatch switch)—— 新增 case:
  - `runtime.list-files` / `runtime.read-file`
  - `runtime.list-changed-files` / `runtime.read-file-diff`
- 文件/git 实现复用 `packages/shared/filesystem`(见下)—— runtime 进程在那台机器上直读 fs / 跑 git
- `apps/runtime/src/filesystem/` —— 新增 file-browser.ts(或从 worker 侧迁),调 shared 安全纯函数

**shared 安全纯函数提取**(wm-0005 已规划):
- `packages/shared/src/filesystem/path-safety.ts` —— validateRelativePath, resolveWithinRoot
- `packages/shared/src/filesystem/file-browser.ts` —— listFiles, readFile(纯函数,异步 fs/promises)
- 从 `packages/worker/src/files/workspace-file-browser.ts` 提取(现状 worker 已有完整安全校验:越界/symlink/大小/二进制)

**协议类型**:
- `packages/shared/src/protocol/runtime-tunnel.ts` —— 新增 RPC 方法类型 + params/result

**server 侧调用**:
- `apps/server/src/runtime/remote/remote-runtime.ts` —— 新增 listFiles/readFile/listChangedFiles/readFileDiff,经隧道 RPC 调
- `apps/server/src/runtime/runtime.service.ts:291-346` —— 这些方法对 docker/opensandbox/registered 走 RemoteRuntime(隧道 RPC);native 仍走进程内直读(06 收窄)

## 不做

- 不改 native(native 直读,06 处理 LocalRuntime 收窄)
- 不退役 wm-0004 worker 文件通道(07)
- 不定写操作幂等(§10 未决,本 ticket 只做读能力;写操作 discard_file_change 留后续)

## 验收

1. `pnpm typecheck` + `pnpm --filter @agework/shared test` + `pnpm test:server` 过
2. shared filesystem 安全单测:越界 `..`/绝对路径/symlink 逃逸/大小截断/二进制拒绝
3. registered runtime 文件预览走隧道 RPC(不拉起 worker),git diff 工作
4. managed docker/opensandbox 文件预览走 loopback 隧道 RPC
5. native 文件预览仍走进程内直读(不变)

## 依赖

04(managed 容器 runtime 进程在)
