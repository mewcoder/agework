# 工作空间文件预览方案设计

> 状态:设计稿,未实现。
> 已拍板决策:① UI 放聊天页(workbench)右侧可折叠面板;② 代码预览用 shiki 只读高亮;③ **一步到位:全部 runtime(local / docker / opensandbox / registered)统一由工作区所在环境内的常驻 worker 代理读,server 不做任何本机 fs 直读**,链路参考 omnigent 的 server 纯代理模式;④ 第一阶段**纯只读**——写文件/编辑文件不做,diff 视图第二阶段再做(见 §6);⑤ **文件命令(list_files/read_file)走独立的 owner-scoped 通道,不复用 run 的 `command.result`/`RunEvent`**——命令/结果通道从下到上都是 run-scoped 的(`RunChannelMessage.runId` 必填、`RunEvent.runId` 是必填外键关联 `Run`),文件预览常见的「worker 在线但无活跃 run」场景凑不出合法 runId,原因与取舍见 `apps/server/src/worker-manager/docs/adr/0004-workspace-file-commands-independent-channel.md`,§3/§4 已按此改写。

## 1. 背景与目标

给用户提供「边聊边看 agent 改了什么文件」的能力:在会话页展示当前工作空间的文件树,点击文件可预览内容(代码高亮 / markdown / 图片)。只读查看,不做编辑保存。

现状(2026-07 摸底结论):

- 后端只有「列子目录」能力(建工作空间时的目录选择器),`apps/server/src/runtime/filesystem/directory-browser.ts:20` 明确 `filter(isDirectory)` 过滤掉文件;全仓没有任何「读文件内容」的 HTTP 接口或协议消息。
- worker / worker-manager 没有 file 类命令;registered runtime 的 WS 隧道(`packages/shared/src/protocol/runtime-tunnel.ts:81-100`)已有 `runtime.list-dir` / `runtime.create-dir` 先例,可对称扩展。
- 前端没有文件树组件;markdown/代码高亮栈已有:`@assistant-ui/react-streamdown` + `@streamdown/code`(底层 shiki,主题 `["github-light","github-dark"]`,见 `apps/web/src/components/assistant-ui/markdown-text.tsx:17-18`)。

## 2. 标杆项目对照结论

| 维度 | AionUi | omnigent(omni) | OpenHands | codeg |
|---|---|---|---|---|
| 文件树 | Arco `<Tree>`,每次展开懒加载一层 | 自研 FolderTree(懒加载)+ 变更文件扁平列表 | 不自绘,外包给沙箱内 openvscode-server(iframe) | 自研懒加载树 + workspace-state 快照流,git 状态染色 |
| 代码预览 | CodeMirror 6(看=改) | **shiki 只读高亮**,编辑才升级 Monaco | Monaco 只用于 git diff | Monaco(可编辑),文本硬上限 50MB |
| markdown | Streamdown | react-markdown + remark-gfm | react-markdown | Streamdown |
| 取沙箱文件 | 后端二进制 `/api/fs/*` | server 纯代理 → runner → os_env 沙箱内读 | app-server httpx 反代 → 沙箱内 agent-server | 同一份 Rust 实现双暴露(Tauri command + Axum);远程模式 `remote_http_call` 代理到远端主机 fs |
| 刷新 | 工具事件节流 2s 刷树 + WS 推送 + mtime 1s 轮询兜底 | **SSE `changed_files.invalidated` 失效 react-query,无轮询** | react-query `refetchOnMount`,无推送 | notify fs-watch + seq 增量推送(断线 replay、`changed_paths` 精准失效),无轮询 |
| 安全 | 后端二进制内,不可见 | 拒绝 NUL/绝对路径/`..` + `relative_to(root)` 校验;10MiB UTF-8 边界截断;二进制转 base64 | git diff 1MiB 上限;路径 `relative_to(repo)` | **最强纵深**:拒 `..` 组件 + canonicalize 前缀 + `O_NOFOLLOW` fd 上读(防 TOCTOU)+ `take(limit+1)` |

采纳:整体形态对齐 omnigent(自研树 + shiki 只读 + 相对路径校验 + 服务端截断 + 事件失效刷新),它与本仓库技术栈(react-query、竖切模块、server↔worker 通道)同构度最高。OpenHands 的 openvscode-server 方案不采纳(重、且要求沙箱内跑 VSCode)。

## 3. 总体架构

所有 runtime 形态走同一条数据链路,文件读取一律由工作区所在环境内的常驻 worker 执行,server 只做鉴权 + 代理收敛(对齐 omnigent 的「server 纯代理 → runner 在沙箱内读」):

```
web → server HTTP →(owner-scoped 文件命令队列,与 run 命令共用同一条长轮询连接但走独立协议类型)
→ 工作区所在环境内的常驻 worker 直接处理(不经 RunnerManager/runner 子进程)→ 读 fs →
经独立的 owner-scoped 结果端点回传(不经 command.result/RunEvent)→ server 的
WorkspaceFileCommandStore 按 commandId 收敛 → HTTP 响应 → web
```

**不复用 `command.result`**:`cancel`/`interrupt`/`approval_resolved`/`user_message` 那套「server 发请求 → worker 应答」范式(`packages/shared/src/protocol/channel.ts:95-136`)从下到上都是 run-scoped 的——`RunChannelMessage.runId` 必填,`RunnerManager.handle()`(`packages/worker/src/runner-manager.ts:61`)按 `command.runId` 把命令转发给对应 runner 子进程,`command.result` 最终落进 `RunEvent` 表而 `RunEvent.runId` 是必填外键关联 `Run`(`onDelete: Cascade`,`schema.prisma:191-194`)。文件预览的典型场景恰恰是「worker 在线但没有活跃 run」(上一个 run 已终态,容器/进程还常驻着)——这时没有真实 runId 可用,伪造一个会在外键处直接失败,借用最近一次真实 run 的 runId 又会污染那次 run 的审计事件时间线并撞上 seq 去重状态。详见 ADR-0004。

worker 数据面(HTTP 长轮询 command 通道)本身仍是仓库里唯一能触达全部工作区形态(含沙箱、远端)的机制,下行**复用同一条物理长轮询连接**(不新开连接),只是队列里的消息类型从单一 `RunChannelMessage<CommandPayload>` 变成 `RunChannelMessage<CommandPayload> | OwnerCommand<WorkspaceFileCommandPayload>` 的联合;上行结果新开一个 owner-scoped 端点直接回传,不进 `WorkerUpstreamPort`/`WorkerEventService`/`RunEventService`。

**为什么 local / docker 也不走 server 直读**(虽然本机读得到):

1. 一份实现覆盖全部形态:local / docker / opensandbox / registered 零分支;registered 也**不需要**给 runtime WS 隧道单加 file RPC。
2. 权限与视角一致:容器内 agent 常以容器用户(往往 root)写文件,宿主 server 进程对新文件可能无读权限;worker 与 agent 同环境、同用户、同视角。
3. 安全面最小:server 完全不碰工作区 fs,不新增任何宿主路径读取面。

代价与语义:

- worker 必须在线:容器停着(stop 留载体)或 worker 未拉起时无法预览,返回明确的「运行时未启动」提示(v1 不做自动拉起,见 §6)。
- 命令通道是长轮询,worker 在线时往返延迟可忽略;server 对每次请求设超时(10s)兜底。
- **不需要为此上 WS**(已核实实现):worker 以 25s 真长轮询挂起(`packages/worker/src/worker.ts:23`),server 新命令入队即刻 resolve 挂起的 poll(`worker-manager/connection/command-queue.ts:46 resolveOwnerWaiters`),命令下发与 WS 推送一样即时;结果经独立端点即时回传。文件预览是人手点击的低频请求,通道开销无感;将来若做终端流等高频场景,再整体评估 worker 数据面升级 WS,契约不受影响。

**worker 侧执行纪律(同进程内解决,不新开进程)**:worker 是单线程常驻进程,同时还要通过 IPC 转发同 owner 下其他正在跑的 run 的事件,文件操作因此不能拖慢或搞挂它:

1. `WorkspaceFileCommandHandler`(fs 操作)用 `fs/promises` 异步 API,不用 `directory-browser.ts` 那种同步风格——真正的磁盘 I/O 走 libuv 线程池,不占主线程,常规读取(哪怕读满 1MiB 文本/5MiB 图片)不会让同 owner 下其他 run 有能感知到的卡顿。
2. 每次 fs 调用套 `AbortSignal` 超时(8s,比 server 侧 awaiter 的 10s 短,worker 能抢先把「文件系统响应超时」这个具体错误回传,而不是让 server 触发笼统超时),防止网络挂载盘等真正卡死的场景一直占着线程池槽位。
3. `commands.ts` 的分发循环里,文件命令分支不 `await`,`void handler(command).catch(...)` 触发即走,避免拖慢同一批次里排在后面的 `cancel`/`interrupt`。
4. 全程严格 try/catch 到底,任何失败都转成走结果通道回传 `error`,不允许裸抛/裸 reject 冒到顶层——`packages/worker/src` 目前没有任何 `unhandledRejection`/`uncaughtException` 兜底,一次 unhandled rejection 会直接终止整个 worker 进程,连带杀掉该 owner 下所有正在跑的 run。

关键点:**API 契约对前端只有一套**(见 §4),且与 runtime 形态无关;后端实现也只有一条 worker 代理路径,没有「本机直读」分支。

刷新机制演进:

- v1(本期):面板打开时拉取 + 手动刷新按钮。
- v2:run 到达终态时前端 invalidate 文件相关 query(已有 `use-conversation-run-status-monitor.ts` 监控 run 状态,挂一个 invalidation 即可,不需要后端改动)。
- v3(可选):参考 omnigent,worker 文件写工具完成后节流上报事件,server 转推前端做精准失效。不做 AionUi 式 mtime 轮询。

## 4. 后端设计(协议 + worker + server)

### 4.1 分工与文件骨架

改动落在四处,职责按「谁离数据近」划分。文件命令协议**独立于** `CommandPayload`/`CommandResultPayload`(见 ADR-0004),不改 `channel.ts`:

```
packages/shared/src/protocol/workspace-file-command.ts   # 新增独立协议:WorkspaceFileCommandPayload
                                          # (list_files/read_file,无 runId)、WorkspaceFileCommandResult
                                          # (含错误形状)、不含 runId 的 OwnerCommand 信封类型

packages/worker/src/files/
├── workspace-file-browser.ts             # 纯函数(异步 fs/promises):列一层目录、读文件、
│                                         # 路径安全校验、截断/二进制/symlink 判定
├── workspace-file-browser.spec.ts
└── workspace-file-command.handler.ts     # WorkspaceFileCommandHandler:RunnerManager 的兄弟角色,
                                          # 不进 RunnerManager,常驻 worker 直接处理 + fire-and-forget
                                          # 分发 + AbortSignal 超时 + try/catch 到底(见 §3 执行纪律)

apps/server/src/worker-manager/connection/
├── workspace-file-command.store.ts       # WorkspaceFileCommandStore:pending map + commandId 匹配,
│                                         # 结构照抄 worker-handshake.store.ts,不自带超时,由调用方
│                                         # 套 `withTimeout` 并在超时/出错分支显式清理 pending 条目
└── workspace-file-command.controller.ts  # POST /worker/owners/:ownerId/file-command-results,
                                          # worker 处理完直接 POST 回传,不经 command.result/RunEvent

apps/server/src/workspace/
├── workspace.controller.ts               # +2 个 GET 端点
└── workspace.service.ts                  # +listFiles / readFile:属主校验 → 解析常驻 worker → 委派
```

- 归属逻辑:HTTP 契约与鉴权归 `workspace`(领域入口);文件命令下发/应答收敛归 `worker-manager`(新的独立通道,与 `command.result` 那条平行、不复用);fs 读取与全部安全校验归 worker(唯一与工作区同环境的角色)。依赖方向 workspace → worker-manager,正向,无新增反向依赖。
- workspace → worker 寻址:`WorkerRegistryRepository.findActiveByWorkspace(workspaceId)` 已经是现成的一步查询——按 `workspaceId` 找 `WorkerWorkspaceBinding` + 关联的 `Worker` 行,`status !== "running"` 时返回 null,天然覆盖「从未启动」和「已停止」两种「运行时未启动」场景,不需要重新计算 isolation scope。`WorkerManagerService` 加一个薄的公开方法把这个查询暴露给 `workspace` 调用。
- `workspace-file-browser.ts` 的安全校验风格(相对路径、NUL/`..`/绝对路径拒绝、realpath 前缀判断)对齐 `runtime/filesystem/directory-browser.ts`,但 fs 调用本身用异步 API,不是同步——原因见 §3 worker 执行纪律。server 侧不再有任何 fs browser 文件,对 `path` 只做基本形状校验(非空串规整、无 NUL)后透传。
- 不动 runtime module:directory-browser 服务的是「建工作空间选目录」(绝对路径、只列目录),语义不同,不合并。

### 4.2 API 契约

RPC-over-HTTP,子资源保留动作段(backend-naming §15):

```
GET /api/v1/workspaces/files/list?id=<workspaceId>&path=<relativePath>
GET /api/v1/workspaces/files/read?id=<workspaceId>&path=<relativePath>
```

- 查询参数 ≤3,`@Query()` + pipe 直接接,不建 Query DTO。`path` 是**相对 workspace 根目录的路径**,`list` 时省略表示根目录。
- `list` 响应(数组字段必须叫 `list`;目录在前、同类按名字 `localeCompare` 排序,server 端排好):

```jsonc
{
  "path": "src/components",           // 规整后的相对路径,根目录为 ""
  "list": [
    { "name": "ui", "type": "directory" },
    { "name": "chat-header.tsx", "type": "file", "size": 2048 },
    { "name": "bar", "type": "symlink", "target": "foo", "targetType": "directory" }
  ],
  "truncated": false                   // 单目录超上限(1000 项)时置 true 并截断
}
```

- `type: "symlink"`:用 `lstat`(不 follow)识别,不当成 `"directory"` 返回——否则懒加载树在 root 内部的环形 symlink(比如 `foo/bar` 指回 `foo` 自己或更上层目录)上会允许用户一层层点开出死循环。`target` 是符号链接自身文本、`targetType` 是最终指向的类型(`directory`/`file`/`unknown`,解析失败给 `unknown`);前端不允许原地展开 symlink 节点,给不同图标,点击时跳转到 `target` 解析出的实际路径。

- `read` 响应:

```jsonc
{
  "path": "src/app.ts",
  "encoding": "utf8",                  // "utf8" | "base64"
  "content": "...",
  "size": 10240,                       // 磁盘真实大小(截断前)
  "truncated": false
}
```

### 4.3 鉴权、在线与超时语义

- 鉴权:属主校验,复用 `WorkspaceRepository` 按 `userId + id` 查(同 `getOwnedId` 语义,`workspace.repository.ts:148`),查不到抛 404。runtime 形态不影响鉴权,也不需要读 `rootPath`(server 不下发绝对路径,见 §4.4)。
- worker 不在线(`findActiveByWorkspace` 查无 `status === "running"` 的绑定,容器已停 / 尚未有过会话都落这一支):在真正下发命令之前就短路,直接抛 `BadRequestException("运行时未启动,发起对话后即可浏览文件")`,前端整板空态展示——不浪费一次 10s 等待。
- 应答超时:`WorkspaceFileCommandStore.waitForResult()` 外层套 `withTimeout`,默认 10s 未收到匹配 `commandId` 的结果即拒绝,server 返回超时类错误(如 504),前端预览区内联提示可重试。超时/出错分支必须显式清理 Store 里对应的 pending 条目(照抄 `worker.provisioner.ts` 里 `handshakeStore.cancel(...)` 那个 catch 分支的写法),否则 worker 迟迟不回或永久失联时会在 Store 里留下再也不会被消费的 pending Promise。
- worker 侧 fs 调用套 `AbortSignal` 超时,取 8s(比 server 侧 10s 短),worker 能抢在 server 侧超时兜底之前,把「文件系统响应超时」这个具体错误经结果通道回传,前端拿到的提示更准确。
- worker 侧校验失败(越界、二进制、超限)以 result 的错误形状回传,server 统一转成 `BadRequestException(message)`,message 直接给前端展示。
- 桌面端(Electron)后端是 in-process 同一个 NestJS server,local worker 同样常驻本机,链路完全一致,不新增 Electron IPC。

### 4.4 路径安全(参考 omnigent `_validate_path` / `_resolve`)

命令 payload 只携带**相对路径**,worker 锚定自身工作区根目录(它启动时的 workdir)解析——server 从不下发绝对路径,天然杜绝「拿别人的根目录来读」。worker 侧 `workspace-file-browser.ts` 内集中校验,list / read 共用:

1. 拒绝含 NUL 字节、绝对路径、任何 `..` 段的输入。
2. `join(rootPath, relativePath)` 后取 `realpath`,结果必须仍在 `realpath(rootPath)` 之下(前缀 + 分隔符判断),否则抛错——挡住 symlink 逃逸到 root 外。
3. `list` 阶段每个 entry 先 `lstat`(不 follow):是 symlink 就按 §4.2 的 `"symlink"` 类型返回,不再进一步 `stat` 判断是文件还是目录——**root 内部**的环形 symlink(`realpath` 前缀检查放行,因为没有逃出 root)如果被当成 `"directory"` 处理,懒加载树会允许用户一层层点开出死循环,所以干脆不展开,交给前端处理跳转。
4. read 目标(non-symlink 情况)必须是普通文件(`isFile()`),list 目标必须是目录;其余(socket、fifo 等)拒绝。
5. 可选加固(codeg 做法):read 用 `fs.open` 带 `O_NOFOLLOW` 打开后在 fd 上 stat + 读,消除 realpath 校验与实际读取之间的 TOCTOU 窗口;worker 在沙箱内跑、风险本就有限,实施时顺手做即可,不作为验收项。

### 4.5 大小与二进制策略

- 文本读取上限 **1 MiB**:超出时在 UTF-8 字符边界截断,`truncated: true`,`size` 报真实大小(omnigent 用 10MiB,本项目场景 1MiB 足够,预览不是下载)。
- 二进制判定:读出的前 8KiB 含 NUL 字节即视为二进制。
  - 图片扩展名(png/jpg/jpeg/gif/webp/svg/ico/bmp)→ `encoding: "base64"` 返回,上限 **5 MiB**,超出以错误应答「图片过大,暂不支持预览」。
  - 其他二进制 → 错误应答「二进制文件不支持预览」(不返回内容,前端展示提示 + size)。
- result 载荷经 §3 的独立结果端点(HTTP POST)回传:文本截断后 ≤1 MiB、图片 base64 后 ≤7 MiB;已核对 `apps/server/src/config/registry/defaults.ts` 的全局 body 上限 `DEFAULT_API_BODY_LIMIT = "50mb"`(`main.ts` 全局 `useBodyParser` 应用),7 MiB 远在限内,不需要为这个端点单独调大。
- 目录单层条目上限 1000,超出截断并置 `truncated`(懒加载一层一取,正常目录远达不到;node_modules 这类目录也不会炸)。
- 隐藏文件(dotfile)默认返回,不做服务端过滤;树是懒加载的,`.git`、`node_modules` 不展开就没有成本。

### 4.6 测试点

- worker `workspace-file-browser.spec.ts`:
  - 越界:`..`、绝对路径、NUL、symlink 指向根外 → 全部拒绝。
  - 截断:>1MiB 文本 `truncated: true` 且在 UTF-8 边界(多字节字符不撕裂)。
  - 二进制:NUL 判定;图片走 base64(5MiB 上限);非图片二进制错误应答。
  - symlink:root 内部环形 symlink 返回 `type: "symlink"` 而不是 `"directory"`,`target`/`targetType` 形状正确。
  - 排序与形状:目录在前;根目录 `path: ""`。
- worker `workspace-file-command.handler.ts` spec:收到 `list_files` / `read_file` → 正确经独立结果通道回传匹配 `commandId` 的结果;校验失败以错误形状回传;fs 调用超过 8s `AbortSignal` 超时 → 回传「文件系统响应超时」;处理函数内部抛错不应变成 unhandled rejection(mock 一次同步 throw,断言进程不退出、结果通道收到 error)。
- server `workspace-file-command.store.spec.ts`:收到匹配 commandId 的结果履约对应 pending Promise;`withTimeout` 超时后 pending 条目被清理(不会在之后收到迟到结果时残留悬空 resolve)。
- server workspace service spec:非属主 404;`findActiveByWorkspace` 无 running worker → 400(不发起命令,不等 10s);worker 错误应答转 400(手搓 mock)。

## 5. 前端设计

### 5.1 布局与状态

- `workbench.tsx` 的 `WorkbenchContent` 内,`<Thread>` 右侧并排一个固定宽度(`w-88` 左右)的文件面板;开关状态 `useState` 放 `WorkbenchContent`,开关按钮(lucide `FolderTree` / `PanelRight` 类图标)以 prop 传给 `ChatHeader` 渲染在右侧。不建全局 store,不做拖拽调宽(后续可加)。
- workspaceId 解析与 `chat-header.tsx:23` 同源:`conversation?.workspaceId ?? selectedWorkspaceId`;未选工作空间时不显示开关按钮。
- 移动端(`useSidebar().isMobile`)本期隐藏入口;后续如需,复用同一面板组件塞进 Sheet。

### 5.2 组件结构

```
apps/web/src/components/workspace-file-panel/
├── workspace-file-panel.tsx    # 容器:标题栏(刷新/关闭)+ 上树下预览分栏
├── workspace-file-tree.tsx     # 懒加载树:每展开一层拉一次 list
└── workspace-file-preview.tsx  # 按类型分发:code/markdown/image/binary 提示
```

树不引第三方组件:目录节点用现有 `Collapsible` + 递归渲染,展开时才发起该层 query(AionUi/omnigent 同款「一层一取」)。选中文件 state 放在 panel 容器里。

### 5.3 数据层

- `apps/web/src/api/workspaces.ts` 追加 `listWorkspaceFiles(id, path)` / `readWorkspaceFile(id, path)`(沿用该文件现有 fetch 封装),配套补 `workspaces.test.ts` 用例。
- `apps/web/src/hooks/use-workspace.ts` 追加 react-query hooks:
  - `useWorkspaceFiles(workspaceId, path, enabled)`,key `["workspace-files", workspaceId, path]`,目录展开时 `enabled` 才为 true。
  - `useWorkspaceFileContent(workspaceId, path)`,key `["workspace-file", workspaceId, path]`。
- 刷新按钮 = `invalidateQueries(["workspace-files", workspaceId])` + 当前打开文件;v2 在 `use-conversation-run-status-monitor.ts` 观察到 run 进入终态时做同样的 invalidate。

### 5.4 预览渲染矩阵

| 类型(按扩展名) | 渲染 | 依赖 |
|---|---|---|
| 代码 / 未知文本 | shiki `codeToHtml`,双主题 `themes: { light: "github-light", dark: "github-dark" }`,按需 import 语言 | `shiki` 提升为直接依赖(已在依赖树,`@streamdown/code` 底层就是它,零体积增量) |
| markdown | `streamdown` 的 `<Streamdown>` 直接渲染(独立组件,不依赖 assistant-ui 消息上下文;plugins/主题复用 `markdown-text.tsx:17-18` 的配置) | `streamdown` 提升为直接依赖(已在依赖树) |
| 图片 | `encoding === "base64"` → `<img src="data:...">` | 无 |
| 二进制 / 超限 | 提示文案 + 文件大小(后端 400 的 message 直接展示) | 无 |

- shiki highlighter 单例 + 动态 `import()` 懒加载,不进首屏 chunk。扩展名→语言映射表放 `workspace-file-preview.tsx` 内(参考 AionUi `fileUtils.ts` 的映射,只保留常见几十种,未命中回退 `text`)。
- `truncated: true` 时预览顶部显示「文件过大,仅显示前 1MiB」条。

### 5.5 空态与错误态

- 未选会话/工作空间:面板不可见(入口按钮就不渲染)。
- worker 不在线:后端 400,面板整体空态展示 message(「运行时未启动,发起对话后即可浏览文件」),不自动重试。
- 目录为空:空态占位;单文件读取失败/超时:预览区内联错误 + 重试按钮。

## 6. 后续增强(实施时再细化)

- **变更推送(v3 刷新)**:omnigent 模式——worker 文件写工具完成后节流发「文件已变更」事件,server 经现有事件通道转推前端,前端只做 query 失效不做增量 patch。
- **变更文件列表 + diff 视图(已拍板:第二阶段做,第一阶段只做树 + 只读预览)**(omnigent FlatFileList / OpenHands Changes 形态,2026-07-07 已调研三家实现):
  - 形态:变更列表(A/M/D 徽章)+ 点开看 `{before, after}` 整文件对,累计语义(vs HEAD),**不做每轮 diff**(每轮的 patch 天然在聊天流工具事件里,互补)。
  - 实现:worker 新增 `list_changed_files`(`git status --porcelain`,可并发 `git diff --numstat` 给列表带 +N/-N 行数,codeg 做法)/`read_file_diff`(`git show HEAD:path` + 当前全文)两命令,无状态、重启不丢、shell 改动可见;非 git 工作区 v1 显示「暂不支持变更视图」(codeg / OpenHands 同款语义;四家调研中仅 omni 做了非 git 降级)。
  - 注意:omni 的非 git 方案(工具写前留内存快照)对 agework **不可行**——我们的 agent 是外部 CLI,worker 事后消费事件流,拦不到"写之前";非 git 若要支持,用影子 git(独立 gitdir 做基线,≈AionUi snapshot 模式),不抄 omni。
- **worker 不在线时自动拉起**:预览请求触发 runtime ensure,需权衡冷启动时长与用户预期,v1 明确不做。
- 以上均不改 §4 的 API 契约与 §5 的组件结构。

## 7. 实施与验证清单

1. shared 协议扩展(新增独立的 `workspace-file-command.ts`,不改 `channel.ts` 的 `CommandPayload`/`CommandResultPayload`,见 ADR-0004)→ `pnpm --filter @agework/shared typecheck`(改 shared 按仓库约定优先补精准单测)
2. worker:`workspace-file-browser.ts` 纯函数(异步 fs)+ spec、`workspace-file-command.handler.ts`(fire-and-forget 分流、AbortSignal 超时、try/catch 到底)接入 `commands.ts` 分发循环 → `pnpm --filter worker test`
3. server:`workspace-file-command.store.ts` + spec、新 owner-scoped 结果端点、`WorkerManagerService` 暴露 `findActiveByWorkspace` 薄方法、workspace service/controller + spec → `pnpm --filter server test` + typecheck + eslint
4. 前端:api + hooks + 面板三组件 + ChatHeader 开关 → `pnpm --filter web typecheck` + eslint + `workspaces.test.ts`
5. 手工验证:local 与 docker workspace 均可看树/预览 ts、md、png;从未发起过会话的 workspace 显示「运行时未启动」空态;停掉容器后同样;`../` 越界请求被 worker 拒绝并回 400;root 内部环形 symlink 显示为不可展开节点而不是死循环;有活跃 run 时打开文件预览不影响该 run 的流式输出(验证 fire-and-forget 分流生效)。
