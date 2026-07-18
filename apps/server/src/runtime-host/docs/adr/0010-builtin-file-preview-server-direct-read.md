> **⚠ SUPERSEDED**: 本 ADR 已被 server-runtime-worker 目标架构推翻。worker-manager 执行栈在 Phase 3 全部删除，worker 池/信箱/握手/fence 移入 `@agework/runtime-host`。

# ADR-0010: builtin runtime 文件预览走 server 直读，不经 worker

> 状态: 已拍板
> 前置: ADR-0009（文件命令走独立 owner-scoped 通道）
> 变更: 推翻 `docs/todo/workspace-file-preview-design.md` §3 中"为什么 local / docker 也不走 server 直读"的结论——builtin runtime 文件预览改为 server 直读，registered runtime 保持 worker 代理不变。

## 1. 背景

当前所有 runtime 形态的文件预览（`list_files` / `read_file`）统一走 worker 代理链路：

```
前端 → WorkspaceService → ensureWorkerForFilePreview（可能要拉起进程）
→ sendFileCommand → worker 长轮询拉取 → worker fs 读 → 结果回传
→ waitForFileCommandResult（10s 超时兜底）→ 返回前端
```

这条链路对 registered（远程）runtime 是唯一选择——文件在别的机器上。但对 builtin runtime（local / sandbox），文件就在 server 本机硬盘上（sandbox 的 workspace 目录是 volume 映射到宿主的），走 worker 是绕路。

## 2. 决定

**按 `runtime.source` 分治**：

| runtime.source | 文件物理位置 | 读取路径 |
|---|---|---|
| `builtin` | server 本机硬盘（sandbox 是 volume 映射） | RuntimeService → LocalRuntime → shared/fileBrowser 直读 |
| `registered` | 远程机器 | RuntimeService → RemoteRuntime → WorkerManager 代理读（现有逻辑不变） |

数据流：

```
前端 → WorkspaceController → WorkspaceService.listFiles/readFile
  → RuntimeService.listFiles(runtimeId, rootPath, path)
    → LocalRuntime:  shared/fileBrowser.listFiles(rootPath, path)    ← 几十毫秒
    → RemoteRuntime: WorkerManager.sendFileCommand → worker 代理读   ← 现有逻辑
```

判断标准只有一个：`runtime.source === "builtin"`。不看 runtimeType（local / sandbox / docker）——只要是 builtin，workspace 目录就在 server 本机上；sandbox 只是映射进容器给 agent 用，server 看到的就是本机路径。

## 3. 为什么推翻原有"全走 worker"结论

原有设计 §3 给了三个理由，逐条重新审视：

### 理由 1："一份实现覆盖全部形态，零分支"

**反驳**: RuntimeService 已经有 LocalRuntime / RemoteRuntime 的路由能力。`listDirectory` / `createDirectory` 已经走这个路由。`listFiles` / `readFile` 加进去是同一方向的自然延伸。WorkspaceService 只调一行 `RuntimeService.listFiles()`，不关心底层走哪条路——分支判断收在 RuntimeService 内部，对 WorkspaceService 来说是零分支。

### 理由 2："容器内 agent 以容器用户写文件，宿主 server 可能无读权限"

**反驳**: sandbox 的 workspace 目录是 volume 映射，宿主 server 进程对映射目录有读权限（映射目录的权限由宿主 fs 控制，不随容器内用户变化）。实际验证：Docker volume 映射到宿主时，宿主进程以自身用户身份读映射路径，不受容器内 UID 影响。如果真遇到权限问题，那是部署配置问题，不应该为此让所有 builtin 用户承受 worker 链路的延迟。

### 理由 3："server 不碰工作区 fs，安全面最小"

**反驳**: server 已经在碰 fs——`directory-browser.ts` 在 server 进程内做 `readdirSync` / `mkdirSync`。文件预览的 fs 操作只是多了"读文件内容"和"列文件（含文件/大小/类型）"，安全校验逻辑（路径越界、symlink 逃逸、大小截断）复用 worker 端已有的同一套代码，提取到 `@agework/shared` 即可。server 碰的是映射目录上的只读操作，不新增写面。

## 4. 性能对比

| 场景 | 当前（全走 worker） | 改后（builtin 直读） |
|---|---|---|
| builtin 文件预览 | ~1-3s（拉起 worker + 长轮询 + 回传） | **~10-50ms**（同进程 fs/promises） |
| registered 文件预览 | ~1-3s | ~1-3s（不变） |

builtin 场景提升 20-100 倍。额外收益：

- 不需要 `ensureWorkerForFilePreview`（不用为了看个文件就拉起/维持一个 worker 进程）
- 不需要 10s 超时兜底
- worker 进程可以更懒——只在真正跑 agent 时才拉起

## 5. 实现要点

### 5.1 安全校验逻辑提取到 shared

Worker 端 `packages/worker/src/files/workspace-file-browser.ts` 已有完整安全校验：

- `validateRelativePath`: 拒绝 NUL / 绝对路径 / `..`
- `resolveWithinRoot`: realpath + 前缀判断挡 symlink 逃逸
- `O_NOFOLLOW` 打开文件消除 TOCTOU
- 二进制探测（8KiB NUL）、大小限制（文本 1MiB / 图片 5MiB / 目录 1000 条）
- UTF-8 边界截断

LocalRuntime 直读必须复用同一套逻辑。做法：把纯函数核心提取到 `@agework/shared`：

```
packages/shared/src/filesystem/
├── path-safety.ts         # validateRelativePath, resolveWithinRoot
├── file-browser.ts        # listFiles, readFile（纯函数，异步 fs/promises）
└── file-browser.types.ts  # BrowseResult 等类型
```

Worker 和 LocalRuntime 都调用同一份代码，安全行为一致。

### 5.2 RuntimeService 新增方法

```ts
// runtime.service.ts
async listFiles(runtimeId: string, rootPath: string, relativePath: string): Promise<WorkspaceFileListResponse> {
  const runtime = await this.getRuntime(runtimeId);
  if (runtime.source === "builtin") {
    return this.localRuntime.listFiles(rootPath, relativePath);
  }
  // registered: 委派 WorkerManager
  return this.workerManager.listFilesViaWorker(runtimeId, rootPath, relativePath);
}
```

LocalRuntime 的 `listFiles` / `readFile` 调 shared/fileBrowser 直读；RemoteRuntime 路由到 WorkerManager（现有 `sendFileCommand` + `waitForFileCommandResult` 链路）。

### 5.3 WorkspaceService 简化

```ts
// workspace.service.ts
async listFiles(userId: string, workspaceId: string, path: string) {
  // 属主校验
  const owned = await this.repo.getOwnedId(userId, workspaceId);
  if (!owned) throw new NotFoundException(...);

  // 解析 runtime 信息
  const ctx = await this.getRunContext(workspaceId);

  // 一行调用，不关心本地/远程
  return this.runtimeService.listFiles(ctx.runtimeId, ctx.workspaceRootPath, path);
}
```

不再自己调 `WorkerManagerService.sendFileCommand` / `waitForFileCommandResult` / `cancelFileCommand`——这些全部收进 RuntimeService 内部。

### 5.4 rootPath 参数喂入

RuntimeService 的 `listFiles` / `readFile` 方法签名中 `rootPath` 是参数，不是 runtime 自己查的：

```ts
listFiles(runtimeId: string, rootPath: string, relativePath: string)
```

WorkspaceService 查出 rootPath 后传进去。这符合架构决策链第 2 条"参数喂入"——runtime 不反向依赖 workspace。

### 5.5 WorkerManager 文件命令方法归属调整

`sendFileCommand` / `waitForFileCommandResult` / `cancelFileCommand` / `ensureWorkerForFilePreview` 从 `WorkerManagerService` 的公开 API 降级为 **RuntimeService 内部调用**——WorkspaceService 不再直接调这些方法。WorkerManagerService 只保留给 RuntimeService（registered 分支）用的内部方法，不 export 给 workspace 模块。

### 5.6 不动现有目录选择路径

`directory-browser.ts`（server 端和 runtime 端）服务的是"建工作空间选目录"（绝对路径、只列目录），语义不同，不合并。文件预览的 listFiles 含文件/大小/类型，是不同的能力。

## 6. 不改的部分

- **registered runtime 的文件预览**: 继续走 worker 代理（ADR-0009 的独立通道），协议不变。
- **Worker 端文件浏览器**: `workspace-file-browser.ts` / `workspace-file-command.handler.ts` 保留，registered runtime 的 worker 仍然需要它们。安全校验逻辑提取到 shared 后，worker 改为调用 shared 版本，本地实现删除。
- **前端 API 契约**: `GET /api/v1/workspaces/files/list` / `GET /api/v1/workspaces/files/read` 不变，前端不感知后端路由变化。
- **Worker 命令协议**: `WorkspaceFileCommandPayload` / `WorkspaceFileCommandResult` / `OwnerCommand` 不变，registered 分支继续用。
- **directory-browser.ts**: 两份副本保留，服务目录选择场景，不与文件预览合并。

## 7. 验证清单

1. shared: `file-browser.ts` + `path-safety.ts` 提取 + spec（越界、截断、二进制、symlink）→ `pnpm --filter @agework/shared typecheck && test`
2. server RuntimeService: `listFiles` / `readFile` 方法 + LocalRuntime 直读分支 + RemoteRuntime WorkerManager 分支 → `pnpm --filter server typecheck && test`
3. server WorkspaceService: `listFiles` / `readFile` 改为调 RuntimeService，移除直接 WorkerManager 调用 → `pnpm --filter server typecheck && test`
4. Worker: `workspace-file-browser.ts` 改为调用 shared 版本，删除本地重复安全校验代码 → `pnpm --filter worker test`
5. 手工验证:
   - builtin workspace 文件预览响应时间 < 100ms（对比改前 ~1-3s）
   - builtin workspace 不需要 worker 在线即可预览（worker 离线时也能看文件）
   - registered workspace 文件预览仍走 worker，行为不变
   - 路径越界（`..`、绝对路径）仍被拒绝
   - symlink 逃逸仍被挡住
   - 大文件截断、二进制拒绝行为不变
