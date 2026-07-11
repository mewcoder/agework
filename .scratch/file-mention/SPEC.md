# 聊天框 `@` 文件提及

Status: draft
范围: **只做「文件」的 @ 引用**（不涉及 skill / MCP / 子 agent）
原则: **文件在服务端，前端穿 server 拿；按 workspace 全局缓存；搜索本地化，刷新交给用户；不过度设计**

> 部署形态：既有本地（native，文件在 server 本机），也有云端沙箱（文件在 worker 容器里，后期主场）。
> 一套设计同时覆盖两者，靠「搜索 / 加载分离 + 按 workspace 缓存」，不为此分叉。

## 1. 用户体验

像微信 @ 人一样：
1. 输入框打 `@` → 弹出项目文件列表
2. 继续打字（如 `login`）→ 列表实时筛到名字带 login 的文件
3. 点一个 → 输入框出现 `@src/login.ts`
4. 发送 → agent 知道你指的是这个文件

复用现有 `/` 命令那套弹层机制（`ComposerPrimitive.Unstable_TriggerPopover`），换 `char="@"`。

## 2. 文件列表怎么来（前端穿 server，复用侧边栏能力）

**前端进程碰不到文件系统**，只能 HTTP 打到 server，server 再去拿。侧边栏文件浏览已有这条链路，不重造，只加一个"列全部文件"的接口：

```
前端 workspacesApi.searchFiles(id)
 → GET /workspaces/files/search?id=
 → workspace.service.resolveFileContext → runtime.service → WorkerFileGateway
    ├─ native runtime：  直读 server 本机 FS（file-browser 纯函数）
    └─ 容器/远程 runtime：workerHttpClient → worker HTTP 隧道 → 容器内读 FS
```

- **native**（本地部署）：文件在 server 本机，直读，快。
- **容器 / 云端沙箱**：文件在 worker 容器里，server 再经 worker 隧道拿 → 前端→server→worker→FS，**两跳网络**。

已有的 `files/list` 是**单层目录**（readdir），凑不出全量，所以新增一个 `files/search`。

### 2.1 遍历方式：`git ls-files` 加 flag（问题2 定论，比参考项目都优）

```
git -C <root> ls-files --cached --others --exclude-standard -z
```

| flag | 作用 |
|---|---|
| `--cached` | 已跟踪文件 |
| `--others` | **未跟踪的新建文件**（用户 / agent 刚建、还没 commit 的也能 @） |
| `--exclude-standard` | 应用**完整** .gitignore（含嵌套 .gitignore、全局 gitignore、`.git/info/exclude`） |
| `-z` | NUL 分隔，文件名含空格 / 换行也不切错（**顺带解决"路径带空格"边界**） |

参考项目（codeg / AionUi / omnigent）都用 readdir / walkdir 遍历：含未跟踪文件，但 **gitignore 只靠硬编码 denylist、不全**（项目自定义忽略如 `.venv`/`target` 全漏）。我们 workspace 本来就是 git 仓库（创建带 `gitUrl`/`gitBranch`，云端沙箱也是 git clone），用 git 一条命令同时拿到「未跟踪 + 完整 gitignore」，还更快。

### 2.2 回退：非 git 目录（极少）

`git rev-parse --is-inside-work-tree` 判失败 → Node 递归遍历：denylist（`node_modules`/`.git`/`dist`/`build`/`.next`/`.venv`/`target`/`vendor`/`coverage`）+ 深度上限 + 数量上限截断。

### 2.3 最小增量（四个薄改动，底层全复用）

底层路径校验、超时、worker 链路全复用（**含 runtime 分档：native 直读 / 容器走 worker 隧道，`@` 层不感知**）：

| 层 | 文件 | 加什么 |
|---|---|---|
| 底层 | `file-browser.ts` | `searchFiles(root)`：git ls-files（回退遍历） |
| runtime port | `runtime.types.ts` + `runtime.service.ts` | `searchFiles` |
| 后端接口 | `workspace.controller.ts` + `.service.ts` | `GET /workspaces/files/search?id=` |
| 前端 api | `api/workspaces.ts` | `searchFiles(id)` |

返回 `{ list: string[] }`，相对路径。

## 3. 性能：搜索本地化 + 按 workspace 全局缓存

因为前端每次拿文件都要**穿 server**（云端两跳），核心就是**尽量少穿链**。把两件事分开：

| | 频率 | 在哪执行 | 本地(native) | 云端(容器) |
|---|---|---|---|---|
| **每次打字搜索** | 每个键 | 浏览器内存 | 零网络 | **零网络** |
| **拉文件清单** | **每 workspace 一次** | 穿 server（→ worker） | 直读几毫秒 | 两跳，但一次性 |

做法：
1. **按 workspace 全局缓存**：文件清单是 **workspace 级**（一个 workspace 一份，下面多会话共享）。用 TanStack Query 按 `['workspace-files', workspaceId]` 缓存——它本身就是「全局、按 key 分、自动去重」的缓存，等于你要的"全局文件 store"，不用自己搓 zustand。
2. **打开 / 选中 workspace 时拉一次**：selection 里 `selectedWorkspaceId` 变化就 prefetch。该 workspace 下切换会话都吃这份缓存，**穿链只一次**（不是每个会话拉一次）。
3. **搜索本地化**：每打一个字，直接在内存 fuzzy 匹配排序。同步、无网络，本地云端都一样。
4. **关闭 workspace 自动回收**：靠 TanStack Query `gcTime`（设几分钟）——切走 workspace 没人再用这份 query，自动垃圾回收，内存不囤；想"关闭即刻清"就在关闭动作里 `removeQueries`。一份清单几百 KB~1–2MB，本不是负担，gcTime 白送这层管理。

**不需要防抖 / 节流**——每次打字都不碰网络（搜索永远在内存）。防抖节流是给"每键发请求"准备的，我们没有；加节流反而让候选滞后于输入、伤手感。

**唯一的限量**：命中太多时只显示 **top 20 条**（打分排序后 slice），保护 DOM。几十条不用虚拟列表。

### 3.1 索引落点与刷新

- **生成**：worker / 沙箱侧（`git ls-files`），文件在哪就在哪跑。
- **持有**：前端 TanStack Query，按 `workspaceId` 分 key，唯一持有者；server / worker 都不额外缓存。
- **触发**：打开 / 选中 workspace 时一次。
- **回收**：`gcTime` 自动（切走 / 关闭 workspace 就清）。

**刷新交给用户，不做自动实时。** `@` 绝大多数引用已存在的文件，新建后马上要 @ 是少数，不值得上自动失效。所以：
- 平时吃缓存（长 `staleTime`），不自动 invalidate、不 run 结束刷新。
- 两个刷新点：**打开 workspace 那次天然加载** + **用户手动刷新**（`invalidateQueries`）。
- **兜底**：`@` 弹层搜不到 / 空态时露出"刷新目录"入口——平时不显示，搜不到才引导刷一下，避免"刚建了文件搜不到又不知道咋办"。

## 4. 防误伤：`@` 怎么和日常文本区分（问题1 定论，参考 AionUi）

正文里常有邮箱 `foo@bar.com`、`@某人`、npm scope `@scope/pkg`、装饰器 `@Component`，不能都当文件引用。选 AionUi 的两道防线（生产代码验证过，契合我们纯 textarea composer；codeg 的 Tiptap 结构化节点要富文本编辑器，代价太大不选）：

1. **边界规则**：`@` 必须在**行首或空白后**才触发（正则 `(?:^|\s)@([^\s@]+)`）。这一条**直接杀掉邮箱**——`foo@bar.com` 的 `@` 前面是 `o`，不匹配。同时排除转义 `\@`，query 到空白结束。
2. **存在性校验**：parse 出的 `@xxx` **只有 `xxx` 在已加载的文件清单里，才算文件引用**（才高亮、才注入 context）。`@某人`、`@scope/pkg` 不撞真实文件路径就被过滤掉。

高亮解析和发送时的引用提取**共用这套规则**，保证"看到高亮的"和"真发给 agent 的"一致。

## 5. 模糊匹配

子序列打分（fzf 风格）：query 字符按序出现即命中；连续 / 路径边界（`/`、`-`、`_`、驼峰）/ 文件名部分命中加分；gap 扣分。排序后取 top-K。几十行纯函数，配单测。

## 6. 选中的文件怎么给 agent（问题3 定论，注路径）

三个参考项目**全都是插路径 token、让 agent 自己读，没有一个内联文件内容**。方向明确：**只给路径，不给内容**——agent（Claude/Codex）自己有 Read 工具，指个路就够，塞全文浪费还超 context（而且我们 context 每轮重注 systemPrompt，注内容会每轮重复整份文件）。

- 发送时把选中文件路径挂进 AG-UI 的 `context` 字段（前端 `runViaAgent` 组装 `RunAgentInput` 时已经在填 `context`），adapter 注入 systemPrompt。输入框里的 `@path` 纯文本一起发，agent 双重看得到。
- 以输入框正文为准 + 存在性校验（§4）：发送时从正文按规则解析 `@path`、只保留清单里存在的，据此填 context。用户删了文本就不带。
- **Codex 已确认**：`context` 注入 systemPrompt 在 Claude adapter（`buildStateContextAddendum`）和 Codex adapter（同款 `buildStateContextAddendum`）都已确认。两个 agent 都通过 context → systemPrompt 看到文件提及。

## 7. 高亮

`directive-text.tsx` 现有的 `/` 解析器扩展一条 `@` 分支（按 §4 规则），输入框浮层和消息里都把命中的 `@path` 显示成高亮色。

## 8. 分期

- **P1**：前端弹层 + 本地筛 + 高亮 + 防误伤规则（§4）（先用 mock 文件表跑通交互）。
- **P2**：后端 `files/search`（git ls-files --others）+ 前端按 workspace 缓存（打开 workspace 加载 + gcTime 回收 + 手动刷新入口），替 mock。
- **P3**：发送时把选中文件填进 `context`，Claude/Codex 端跑通（两个 adapter 的 `buildStateContextAddendum` 都已确认读 `input.context`）。

## 9. 暂不做（需要时再加）

- **超大仓降级**：正常项目几千~两万文件、gzip 几十 KB，一次拉没问题。真遇到超大仓（几万+）云端 payload 偏大，才给 `files/search` 加 `query` 参数走服务端过滤 + `truncated` 截断。先留字段占位。
- worker 常驻索引缓存、自动失效、持久文件托盘。
