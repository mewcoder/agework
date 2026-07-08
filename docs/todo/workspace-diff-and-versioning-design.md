# 工作空间 Diff 与版本管理方案设计

> 状态:设计稿,未实现。**第二阶段**——前置依赖 [`workspace-file-preview-design.md`](workspace-file-preview-design.md) 第一阶段(树 + 只读预览 + owner-scoped 文件命令通道)落地。
> 范围分级(2026-07-07 拍板):P0 = 变更文件列表 + diff 视图(只读),第二阶段;P1 = 单文件恢复(discard)——**选定为恢复能力的最终方案,放在最后阶段(第三阶段)做**,选它因为成本最低(复用 P0 通道,零新状态/存储/留底,git 本身即 baseline)且覆盖全 agent、全改动来源(含 bash);它是第一个写操作,实施时即解除「纯只读」约束。P2 会话 checkpoint(影子 git)与 Claude SDK file-checkpointing 均**降为不排期备选**,只留方案不进路线图(对照见 §5)。
> 明确不做:每轮(per-turn)diff——每轮的 patch 天然存在于聊天流工具事件里,与本档的累计 diff 互补;stage/unstage/commit 等 git GUI 能力——用户有 IDE/终端,agent 产品需要的是「看变更 + 恢复」,不是 git 客户端。

## 1. 标杆项目调研结论(2026-07-07,四家源码)

### 1.1 Diff 机制对照

| 维度 | omnigent(omni) | OpenHands | codeg | AionUi |
|---|---|---|---|---|
| 变更列表来源 | git 工作区:实时 `git status --porcelain`;非 git:拦截 agent write/edit 工具登记(session 级内存 registry) | `git diff --name-status <ref>` + `git ls-files --others` 补未跟踪 | `git status` + 并发 `git diff --numstat`(列表带 +N/-N 行数) | snapshot 后端 compare(闭源二进制) |
| diff baseline | git:`git show HEAD:path`;非 git:首写前留的内存快照(first-write-wins) | 请求参数 `ref`(本地模式传 HEAD;云端自动探测 origin 分支/merge-base) | 固定 HEAD(空仓库 fallback `--cached`) | workspace init 时确立的基线 |
| 非 git 工作区 | 降级内存 registry(shell 改动不可见、重启即丢、快照无大小上限) | `/changes` 返回 `[]`,功能等于关闭 | diff 不可用,树/预览照常 | `snapshot` 模式独立快照存储接管,功能完整 |
| 粒度 | **四家全部是累计语义**(vs HEAD 或会话基线),无每轮重置、无「会话起点 commit」机制(codeg/OpenHands 全仓搜不到 checkpoint/base_commit) | 同左 | 同左 | 同左 |
| diff 形状 | `{before, after}` 整文件对 | `{original, modified}` 整文件对 | original=`git show HEAD:` + modified=当前盘 | 前端 `createTwoFilesPatch` 自算 unified |
| 渲染 | Monaco DiffEditor(只读) | Monaco DiffEditor | Monaco DiffEditor(带上/下一处变更导航) | diff2html |
| 列表项展示 | A/M/D 徽章 + 字节数,deleted 置灰不可点开 | A/M/D/MOVED | A/M/D + **+N/-N 行数**(numstat) | operation 区分 create/modify/delete |
| 大小限制 | git status 5s 超时 | 单文件 1MB(`MAX_FILE_SIZE_FOR_GIT_DIFF`),超限 400 | 文本 50MB 硬上限 | 未知(后端闭源) |

关键教训(omni `GitStatusUnavailable`):git 命令失败(超时/非零退出)必须显式报错,**不能返回空列表伪装成「没有变更」**。

### 1.2 版本管理对照

| 项目 | 能力 | 机制 |
|---|---|---|
| OpenHands | 无 | 纯 git,恢复靠用户自己 |
| omnigent | 无恢复能力 | baseline 快照只服务 diff 展示 |
| codeg | **单文件回滚** `git_rollback_file`;git worktree 隔离(并行会话各开 worktree) | 无会话级 checkpoint;worktree 解决的是隔离不是回滚 |
| AionUi | **最全**:变更列表上 stage/unstage/discard/reset;另有 preview-history 单文件手动版本(save/list/restore) | `fs.snapshot` 双模式——git 工作区直接用真 git(staged/unstaged 语义);非 git 用独立快照存储(后端闭源,推测影子 git 一类) |
| (业界参照)Claude Code | checkpoint/rewind:每轮自动留底、可整体回滚 | 本质是影子 git(独立 gitdir,不污染工作区) |

## 2. agework 方案总览

沿用第一阶段的架构决策——**ADR-0005 混合分治**(不是"全 runtime 统一 worker"):builtin runtime(local / docker / sandbox,工作区就在 server 本机硬盘上,sandbox 是 volume 映射)走 **server 进程直读**,不经 worker;registered runtime(远程机器)才走 owner-scoped 独立文件命令通道(ADR-0004)的 worker 代理。相对路径安全校验已提取到 `@agework/shared/filesystem`,server 与 worker 复用同一份。diff/版本管理沿用同一分治:git 纯函数也提取到 `@agework/shared`(仿照文件预览把 file-browser 提到 `shared/filesystem` 的模式),builtin 由 `RuntimeService`/`LocalRuntime` 在 server 进程内直接跑 git;registered 才往 `WorkspaceFileCommandPayload` 联合类型里**追加命令**——通道、Store、鉴权、超时语义零新增。

```
阶段一(另档): 文件树 + 只读预览(workspace-file-preview-design.md)
阶段二 = P0:   diff 视图——git-only,累计 vs HEAD,只读。非 git 显示「暂不支持变更视图」。
阶段三 = P1:   单文件恢复(discard)——恢复能力的最终形态,唯一的写操作。
不排期备选:    P2 影子 git checkpoint(整树回滚 + 非 git 支持)、Claude SDK file-checkpointing
              (仅 claude、不含 bash 改动),均只留方案(§5)。
```

为什么 baseline 选 HEAD 而不是「会话起点」:四家没有一家做会话起点 checkpoint(§1.1),HEAD 语义无状态(worker 重启不丢)、与用户的 git 心智一致(「未提交的改动」);会话粒度的留底属于 P2 影子 git 的职责,不混进 P0。

## 3. P0:Diff 视图设计

### 3.1 协议与实现(builtin server 直读 / registered worker 代理)

git 纯函数(porcelain 解析、numstat、`git show HEAD:` 取 before)提取到 **`@agework/shared`**——仿照文件预览把 file-browser 提到 `shared/filesystem` 的模式,单文件自包含(shared 以源码形式被消费、禁跨文件 re-export,新建 `packages/shared/src/git.ts` 或并入 `shared/filesystem`),**server 与 worker 复用同一份**。两条执行路径:

- **builtin**:`WorkspaceService` 判 `ctx.runtimeSource === "builtin"` → `RuntimeService`/`LocalRuntime` 在 server 进程内直接调 shared/git(`execFile git`,cwd = `workspaceRootPath`),几十毫秒,不经 worker。
- **registered**:`WorkspaceService` 走现有 `executeFileCommand` → worker 侧经现有 `WorkspaceFileCommandHandler` 分发调同一份 shared/git,执行纪律(异步、AbortSignal、fire-and-forget、try/catch 到底)继承第一阶段 §3。

对外只在 `packages/shared/src/protocol/workspace-file-command.ts` 的 `WorkspaceFileCommandPayload` 追加两个命令(registered 分支用,命名沿用第一阶段 snake_case):

- `list_changed_files`(无参数)
- `read_file_diff`(参数:相对 `path`)

命令执行细节(两条路径共享,逻辑同在 shared/git):

- **git 子进程纪律**:`execFile("git", [args...])` 数组传参(不过 shell,杜绝注入),`cwd` = `workspaceRoot`(builtin 是 server 本机 `workspaceRootPath`,由 `WorkspaceService` 查出后喂入;registered 由 server 经 `resolveRuntimeSpec` 算出、随命令 payload 下发,worker 没有唯一工作区根,见预览稿 §4.4),单命令 5s 超时(对齐 omni;超时/非零退出以错误应答回传,绝不返回空结果——§1.1 教训)。
- **`list_changed_files`**:`git status --porcelain=v1 --untracked-files=all -z`(`-z` 免转义歧义)解析出 `added / modified / deleted`(rename `R` 取新路径归入 modified,codeg/omni 同款);并发跑 `git diff HEAD --numstat -z` 拿 +N/-N(未跟踪文件 numstat 没有,置 null;二进制行 numstat 为 `-`,同样置 null)。过滤 `.git/`;条目上限 500,超出置 `truncated`。
- **`read_file_diff`**:`path` 先过 `@agework/shared/filesystem` 的同一套校验(`validateRelativePath` / `resolveWithinRoot`,相对路径、拒 NUL/`..`/绝对路径,即预览稿提取到 shared 的那份)再拼进 git 参数。`before` = `git show HEAD:<path>`(HEAD 中不存在 → `null`,呈现为新增);`after` = 当前盘内容(deleted 文件 → `null`)。任一侧判定为二进制(NUL 检测)→ 错误应答「二进制文件不支持对比」。
  - **超限即拒绝,绝不做「截断的 diff」(2026-07-07 拍板)**:`before`/`after` 任一侧超 1MiB **不截断**,直接错误应答「文件过大,不支持对比(>1MiB)」。对截断内容算行级 diff 会撒谎——截断点之后的行全被算成删除,用户看到一屏假的红色改动。宁可没有 diff 不能有错的 diff(OpenHands 超 1MB 抛 `GitPathError`→400 同款取舍)。文件仍在变更列表里显示 A/M/D 状态与行数,只是点开对比时给这个提示。预览稿 `read_file` 的截断语义**不受影响**(预览截断只少看后半截,不产生假信息)。
- **非 git 判定**:`git rev-parse --git-dir` 失败 → 错误应答「非 git 工作区暂不支持变更视图」(错误码/文案区别于「git 命令执行失败」,前端分别展示空态与报错态)。空仓库(init 后无 commit)不算非 git:diff 时 `before=null` 全量新增(OpenHands 空树兜底同款语义)。

### 3.2 API 契约

沿用第一阶段的资源段与动作命名(backend-naming §15):

```
GET /api/v1/workspaces/files/changes?id=<workspaceId>
GET /api/v1/workspaces/files/diff?id=<workspaceId>&path=<relativePath>
```

`changes` 响应:

```jsonc
{
  "list": [
    { "path": "src/app.ts", "status": "modified", "additions": 12, "deletions": 3 },
    { "path": "docs/new.md", "status": "added", "additions": null, "deletions": null }
  ],
  "truncated": false
}
```

`diff` 响应(整文件对,前端自己算行级 diff——AionUi 同款前置,省 worker 载荷之外的第二次往返):

```jsonc
{
  "path": "src/app.ts",
  "status": "modified",
  "before": "...",          // string | null(新增文件为 null)
  "after": "..."            // string | null(删除文件为 null)
}
```

无 `truncated` 字段:超 1MiB 走错误应答(见 §3.1),而不是返回一个会撒谎的截断 diff。

鉴权(属主校验)、错误应答转 `BadRequestException`:两条路径相同。超时/在线依赖按 `runtime.source` 分两种:

- **registered**:worker 不在线短路、10s awaiter 超时,与第一阶段 §4.3 相同,不重复设计。
- **builtin**:server 进程内直读、几十毫秒,**不依赖 worker 在线、无 10s awaiter 超时**;唯一兜底是 git 子进程本身的 5s 超时(§3.1),超时/失败直接转 `BadRequestException`。

### 3.3 前端设计

- **入口**:workspace-file-panel 顶部加「文件 | 变更」两个平级视图切换(shadcn `Tabs`;omni FilesPanel 同款形态,也符合本仓库「诊断类 UI 用平级 tab」的既有偏好)。变更 tab 挂 `useWorkspaceChanges(workspaceId)`,key `["workspace-changes", workspaceId]`。
- **变更列表项**:A/M/D 徽章(绿/琥珀/红,语义 token)+ 相对路径(截断)+ `+N/-N` 行数(numstat 为 null 时不显示)。deleted 项置灰、不可点开(omni 同款,省一个「整篇红」渲染分支;后续要放开只是前端改动)。`truncated` 时列表底部提示。
- **diff 渲染**:不引 Monaco / diff2html。前端用 `diff` 包(npm `diff`,很小)对 `{before, after}` 跑 `diffLines`,自研 unified 视图:行级 +/- 着色(`bg-green-*/bg-red-*` 语义 token)+ 行号 + 上下文折叠(连续未变更 >8 行折叠成「展开 N 行」)。不叠加 shiki 语法高亮(diff 行着色与语法高亮叠加是 Monaco 级复杂度,收益不成比例);将来要 side-by-side/编辑器级体验时再懒加载 Monaco DiffEditor,契约不变。
- **刷新**:与文件树共用失效机制——手动刷新按钮 + run 终态 invalidate(`["workspace-changes", id]` 与 `["workspace-files", id]` 一起失效);v3 变更推送落地后同样受益。
- **空态**:非 git 工作区 → 变更 tab 整体空态展示后端 message;git 命令失败 → 报错态 + 重试按钮(两者分开,见 §3.1 非 git 判定)。

### 3.4 测试点

- worker `workspace-git.spec.ts`(用临时目录起真实 git 仓库):
  - porcelain 解析:A/M/D、rename 归 modified、`-z` 含空格/中文路径;untracked 文件 additions=null。
  - `read_file_diff`:修改文件 before/after 正确;新增 before=null;删除 after=null;HEAD 不存在的路径;二进制错误应答;任一侧 >1MiB → 「文件过大不支持对比」错误应答(不返回截断内容)。
  - 非 git 目录 → 「非 git 工作区」错误形状;git 超时(mock execFile)→ 「git 命令执行失败」错误形状,**不是空列表**。
  - 注入防护:path 含 `..`/绝对路径在进 git 前被拒。
- server:workspace service 两个新方法转发/错误映射(mock,复用第一阶段 spec 模式)。
- 前端:diff 行折叠/着色组件单测;`workspaces.test.ts` 补两个 API。

## 4. P1:单文件恢复(discard)——最后阶段(第三阶段)

**已选定为恢复能力的最终方案**(成本最低、跨 agent、全改动来源;对比见文档头与 §5)。它是本功能线第一个也是唯一的写操作,实施时即解除第一阶段的「纯只读」约束。方案:

- 恢复动作同样按 `runtime.source` 分治(逻辑同在 shared/git,先过路径校验):
  - `modified` / `deleted` → `git checkout HEAD -- <path>`(等价 codeg `git_rollback_file`、AionUi `discardFile`);
  - `added`(未跟踪)→ 直接删除该文件(只删普通文件,目录/symlink 拒绝)。
  - **builtin**:由 `RuntimeService`/`LocalRuntime` 在 server 端直接跑(`execFile`,cwd = `workspaceRootPath`),不经 worker;**registered**:走 worker 命令 `discard_file_change`(参数:相对 `path`),经 `WorkspaceFileCommandHandler` 分发。
- 前端:变更列表项 hover 出「恢复」按钮 + `AlertDialog` 确认(明确文案:丢弃该文件的全部未提交改动,不可撤销);成功后 invalidate changes + 该文件的 preview/diff query。
- API:`POST /api/v1/workspaces/files/discard`,Body DTO `{ id, path }`(写操作用 POST,backend-naming §15)。
- 不做 `discard all` / reset 整树(那是 P2 checkpoint 回滚的语义,单文件级别误伤面小得多)。

## 5. P2:会话 checkpoint 与非 git 工作区(远期方向)

唯一同时解决「非 git 工作区 diff」和「整体回滚(rewind)」的机制是**影子 git**(AionUi snapshot 模式的合理推测实现,Claude Code checkpoint 同类):

- worker 在自身数据目录(工作区外、与 worker 同环境,如 `~/.agework/shadow-git/<workspaceId>`)维护独立 gitdir,`git --git-dir=<shadow> --work-tree=<root> add -A && commit` 在 run 开始/终态时各留一个 checkpoint。
- 由此获得:非 git 工作区的变更列表与 diff(baseline = 最近 checkpoint)、按 run 边界查看「这一轮改了什么」、整树恢复到某轮之前(危险操作,双重确认)。
- 已知成本(所以远期):大工作区首次 `add -A` 慢且占空间——需复用工作区 `.gitignore` + 内置排除表(node_modules 等);checkpoint 数量增长需要修剪策略;恢复是重写工作区的高危写操作。
- **不抄 omni 的非 git 方案**(工具写前留内存快照):agework 的 agent 是外部 CLI,worker 事后消费事件流,拦不到「写之前」;且内存快照重启即丢、shell 改动不可见,影子 git 全面优于它。

### 参照:agent 自带的恢复能力(2026-07-07 查证)

| | Claude Code | Codex CLI |
|---|---|---|
| 内置能力 | checkpoint/rewind:每条用户 prompt 自动留底,`Esc Esc` / `/rewind` 三选一恢复(代码/对话/两者) | 曾有实验性 `/undo`(ghost commit:每轮 prompt 前对脏工作树悄悄建 git commit/stash),**已因设计问题移除**;现状 = 官方建议靠 git,`/rewind` 是开着的 feature request(openai/codex#11626) |
| 机制 | 文件副本存 `~/.claude/file-history/<session>/`,**不依赖 git**,默认保留 30 天 | ghost commit 依赖工作区是 git 仓库 |
| 关键局限 | **只追踪 Claude 文件编辑工具的改动**——bash 产生的改动(`rm`/`mv`/脚本生成)和用户手改**不追踪**;session 内有效 | 已移除,不可用 |
| 程序化暴露 | **Agent SDK 暴露**:`enableFileCheckpointing: true` + `extraArgs: {"replay-user-messages": null}`,从 user message 的 `uuid` 拿 checkpoint id,resume 会话后调 `rewindFiles(uuid)`(官方 agent-sdk/file-checkpointing 文档) | 无 |

对 agework 的取舍含义:

1. **agent 自带恢复不能当通用方案**:Codex 侧无能力;Claude 侧 bash 改动不追踪(agent 恰恰大量经 bash 改文件),且只覆盖 claude 这一种 adapter——P2 影子 git 作为跨 agent、全改动来源的统一机制仍然成立(Codex 的 ghost commit 本身就是同思路的变体)。
2. **但 Claude 这条 SDK 通路值得留着**:claude adapter 走 Agent SDK,开 `enableFileCheckpointing` 后可以拿到每条 user message 粒度的 checkpoint uuid,做「回退这一轮 Claude 的文件编辑」的轻量恢复(限:仅文件工具改动、需 resume 原 session)。若将来只想给 claude agent 先上恢复体验,这条路成本远低于影子 git,可作为 P2 之前的中间产物;记入备选,不排期。

## 6. 实施与验证清单(P0)

1. shared:新建 `git.ts`(porcelain 解析、numstat、`git show HEAD:`、discard,单文件自包含)+ spec(真实临时 git 仓库);`workspace-file-command.ts` 追加两命令与响应形状(registered 用) → `pnpm --filter @agework/shared typecheck` + 精准单测
2. server(builtin 直读):`RuntimeService`/`LocalRuntime` 新增 `listChangedFiles` / `readFileDiff`,调 shared/git(`execFile`,cwd = `workspaceRootPath`) → `pnpm --filter server typecheck && test`
3. server(registered 代理):worker 侧接入 `WorkspaceFileCommandHandler` 分发调同一份 shared/git → `pnpm --filter worker test`
4. server:`WorkspaceService` 按 `ctx.runtimeSource` 分治(builtin → RuntimeService 直读,registered → `executeFileCommand` worker)+ controller 两端点 + spec → `pnpm --filter server test` + typecheck + eslint
5. 前端:`diff` 依赖 + 变更 tab + diff 视图组件 + api/hooks → `pnpm --filter web typecheck` + eslint
6. 手工验证:
   - **builtin** workspace 改几个文件(含 shell 直接改的)→ 变更列表全出现且行数正确;新增/删除/rename 状态正确;worker 离线时也能看变更(builtin 不依赖 worker 在线);
   - **registered** workspace 变更列表/diff 仍走 worker,行为一致;
   - 非 git workspace 显示空态;`git` 不存在的镜像里(若有)显示报错态而非空列表;点开 modified 文件 diff 正确、>1MiB 文件提示**文件过大不支持对比**(不做截断 diff);有活跃 run 时拉变更列表不影响流式输出。
