# `@` 文件提及 —— 设计讨论纪要（详细版）

> 这份是**讨论过程 + 推理 + 取舍**的详细记录：探讨过哪些方案、为什么这么定、参考项目怎么做、方案怎么一步步演进的。
> 精简的最终决策版见同目录 `SPEC.md`。

---

## 0. 需求起点

用户诉求：聊天输入框里实现文件选择，支持 `@` 触发（像 GitHub / Cursor / 微信 @ 人那样）。

现状：composer 已经有 `/` 技能选择（`ComposerPrimitive.Unstable_TriggerPopover`，`char="/"`），是自研 textarea + 透明文字 + overlay 高亮解析器（`slashCommandFormatter.parse`），不是富文本编辑器。`@` 本质是同一套弹层机制换 `char="@"` + 换数据源。

---

## 1. 先搞清楚：一条消息怎么从输入框走到 agent（一切约束的基础）

用户特别强调：我们的消息是通过 AG-UI 协议、经 NestJS 后端转发给 agent 的，要先理解这个链路。逐跳核对真实代码后：

```
composer 字符串（含 @src/foo.ts 显示文本）
 ① 前端组装 RunAgentInput   AgUiThreadRuntimeCore.ts:640 runViaAgent
    · convertMessagesToAgUi() → messages[]
    · context = [{description:"system", value: modelContext.system}]   :647  ← context 通道已在用
    · forwardedProps = { agentType, ... }
 ② 前端发 HTTP              chat-http-agent.ts:22
    POST /conversations/run，body = RunAgentInput，header 带 auth/conversationId/agentType
 ③ NestJS 后端              conversation.controller @Post("run") → service
    鉴权、落库 user message、开 run、SSE 回流；input【原样透传】下发 worker（channel.ts:79）
 ④ worker adapter           packages/adapters/src/claude/base/
    · processMessages(input)          utils.ts:77   → 取 messages 最后一条第一个 text block = userMessage
    · buildStateContextAddendum(input) utils.ts:135  → context[]+state【注入 systemPrompt】
    · query({ prompt: userMessage, options:{ systemPrompt } })   adapter.ts:285,306
 ⑤ Claude Agent SDK spawn CLI 在 workspace 跑（有 Read/Grep 工具）
```

**三个决定方案的硬约束（都来自这条链路）**：

1. **`context` → systemPrompt 是每轮 run 重算重注的**（`buildStateContextAddendum` 每次跑，context 来自每轮重算的 `modelContext`）。→ 影响：往 context 里塞文件内容会每轮重复，token 灾难；塞路径每轮几十字节无所谓。
2. **`processMessages` 只取最后一条消息第一个 text block**（多 block 会被丢）。→ 影响：文件引用塞进 user message 正文有丢内容风险，走 context 更干净。
3. **双 agent**：Claude 原生认 `@path`（当路径引用、自己 Read），Codex 不认；且文件访问按 runtime 分档（本地直读 / 容器 RPC）。

---

## 2. 参考项目调研（../agent-project）

两轮调研，对象：codeg、AionUi、omnigent（chrome-acp、open-hands 没做 `@`）。

### 2.1 第一轮：数据源方案

| 项目 | 数据源 | UI | 拉取粒度 | 过滤 |
|---|---|---|---|---|
| codeg | 全量文件树一次拉 + 客户端缓存 | Tiptap `@tiptap/suggestion` 富文本 | 整棵树（walkdir depth≤10） | 子串 includes |
| AionUi | 全量扁平列表一次拉 + 客户端 fuzzy 打分 | 自研 div 下拉 + 普通 Input | 全量扁平 | **分级打分** computeMentionScore |
| omnigent | 逐目录懒加载 + 游标分页 | 自研菜单 + textarea | 单层目录 | 目录内 includes |

结论：形态最像我们的是 **AionUi**（自研下拉 + 全量扁平 + 客户端打分），codeg 用 Tiptap 富文本我们学不了。

### 2.2 第二轮：针对三个"真问题"看实现

- **问题1 防误伤**：AionUi `MessageMention.ts` 正则 `/(?:^|\s)@([^\s@]+)/g` + 注释明说"caller must confirm each path exists in the workspace（avoids matching emails）"—— 边界规则 + 存在性校验。omnigent 同款边界规则。codeg 靠 Tiptap 结构化节点零误伤。
- **问题2 未跟踪文件**：三家都用 readdir/walkdir **遍历**（不是 git ls-files），所以天然含未跟踪新建文件；但 gitignore 靠硬编码 denylist、不全。
- **问题3 传给 agent**：三家**全是插路径 token、agent 自己读，没有一个内联文件内容**。

---

## 3. 逐个决策（探讨了什么 → 为什么这么定）

### 3.1 语义：注路径 vs 注内容 → **注路径**

探讨：Cursor/Cline/Roo 的 `@file` 注**内容**（`<attached-files>`）；但它们不是 tool-loop 架构、不是每轮重注 systemPrompt。而：
- Claude Code（我们的 harness）的 `@file` 是"路径引用 + agent 用 Read 自己读"（联网核实）。
- CopilotKit（我们的 AG-UI 协议母体）的 `useCopilotReadable` 是 context `{description,value}` → systemPrompt。
- 我们 context 每轮重注（约束1）→ 注内容 = 每轮重复整份文件。
- agent 本来就有 Read/Grep。

→ **注路径不注内容**。离我们最近的两个参照（Claude Code + CopilotKit）都这么干。

### 3.2 落点：正文 vs context → **走 AG-UI `context` 通道**

探讨：拼进 user message 正文最省，但 `processMessages` 只取一个 text block（约束2）、语义脏、且靠 Claude 专有 `@` 解析对 Codex 不生效。走 `context` 则两个 agent 统一（都注入 systemPrompt）、结构化、不污染正文。前端 `runViaAgent` 已经在填 context。

→ **路径走 context，正文 `@path` 文本作辅助 buff**。单次引用语义 = 只 push 进当轮 input，零额外状态（多轮记忆靠 session resume）。

### 3.3 数据源：每键服务端搜 vs 一次拉全量 vs 逐目录 → **一次拉全量 + 客户端 fuzzy**

探讨三条路：
- 每键服务端搜：慢链路下每键一次往返，体感差 + 竞态。
- 逐目录懒加载（omnigent）：不能跨目录 fuzzy。
- 一次拉全量 + 客户端 fuzzy（AionUi/codeg）：一次往返后全本地。

→ 选**一次拉全量 + 客户端 fuzzy**。被两个同形态项目背书。

### 3.4 遍历方式：git ls-files vs FS 遍历 → **git ls-files --cached --others --exclude-standard -z**

探讨：参考项目都用 FS 遍历（含未跟踪，但 gitignore 靠硬编码 denylist 不全）。我们最初写"git ls-files 列跟踪文件"——**自查发现漏未跟踪新建文件**（真问题2）。修法两条：加 `--others`，或改用遍历。

对比后 git 方案更优：`--cached`（已跟踪）+ `--others`（未跟踪新建）+ `--exclude-standard`（完整 gitignore，比 denylist 准）+ `-z`（NUL 分隔，顺带解决空格路径），一条命令、更快。我们 workspace 本就是 git 仓库。非 git 才回退遍历。

→ **git 一条命令，比三家遍历派都优**。

### 3.5 时机：预加载 vs 打开会话加载 → **打开会话加载一次**

探讨：我一度包装成"prefetch/预读"这种额外优化。用户点破：打开会话本来就该加载文件目录（跟加载消息历史一样自然），不是"预"加载。

→ **打开会话时加载一次**，不是 app/服务启动时（不知哪个 workspace、会过时），也不是打 `@` 才拉。

### 3.6 性能：防抖节流要不要 → **完全不要**

演进：我最初按"远程慢链路"设计了三处防抖节流（fuzzy 节流 / 降级 debounce / 竞态）。用户两次点破：① 很多是本地读取；② 也有云端，但要理解清楚。

关键想清楚：把**搜索**和**拉取**分开——
- 每次打字**搜索**永远在浏览器内存，本地云端都**零网络**。
- **拉取**清单一次性（打开会话时），云端有网络延迟但被"打开会话"藏掉。

→ 搜索不碰网络 ⇒ **防抖节流没有可防的东西**；而且内存 fuzzy 已 cap + 毫秒级，加节流反而让候选滞后、伤手感。**不做**。

### 3.7 刷新：自动实时 vs 手动 → **手动 + 空态兜底**

用户判断：`@` 多数引用已存在文件，新建后马上 @ 是少数，不需要实时。

→ 去掉自动 invalidate / run 结束刷新；长 staleTime 吃缓存；两个刷新点 = 打开会话天然加载 + 用户手动刷新；**兜底**：搜不到/空态时露"刷新目录"入口，避免"刚建文件搜不到又不知咋办"。

### 3.8 防误伤：`@` 撞日常文本 → **边界规则 + 存在性校验**（参考 AionUi）

自查发现真问题1：正文里邮箱 `foo@bar.com`、`@某人`、scope `@scope/pkg`、装饰器 `@Component` 会被误判。

对比：codeg 的 Tiptap 结构化节点零误伤，但要富文本编辑器，我们纯 textarea 学不了。AionUi 的方案契合我们：
1. **边界规则**：`@` 必须行首/空白后（`(?:^|\s)@([^\s@]+)`）→ 直接挡邮箱（`@` 前是字母不匹配）。
2. **存在性校验**：路径必须在已加载清单里才算引用 → 挡 `@人`/scope。

→ 选 **AionUi 路线**，高亮和发送共用这套规则。

---

## 4. 方案演进轨迹（怎么一步步改的）

1. **部署形态**：最初按"远程慢链路"重设计（三档光谱 + 防抖 + 降级 + worker 缓存）→ 用户指出"多是本地" → 砍成纯本地极简 → 用户指出"也有云端沙箱，是后期主场" → 收敛为「**搜索/加载分离**」一套覆盖本地+云端，不分叉。
2. **防抖节流**：从"要三处" → 想清"搜索永远在内存" → **完全不要**。
3. **数据源**：从"git ls-files 列跟踪文件"（漏未跟踪）→ 自查发现 → **加 --others --exclude-standard**（比参考项目遍历派更优）。
4. **时机**：从"prefetch/预加载"包装 → 用户点破 → **打开会话加载一次**（常规加载，不是额外动作）。
5. **刷新**：从"自动 invalidate + run 结束刷新" → 用户判断不需实时 → **手动 + 空态兜底**。
6. **落点**：从"纯文本 hint 拼正文" → 理解链路后 → **走 context 通道**（两 agent 统一）。

---

## 5. 三个"真问题"（方案自查时发现，都已解决）

| # | 问题 | 影响 | 解决 |
|---|---|---|---|
| 1 | `@` 撞邮箱/@人/scope/装饰器 | 误高亮 + 误塞 context | 边界规则 + 存在性校验（§3.8） |
| 2 | git ls-files 漏未跟踪新建文件 | "新建文件想 @"搜不到，连手动刷新都救不了 | 加 `--others --exclude-standard`（§3.4） |
| 3 | "两 agent 统一"在 Codex 侧未验证 | Codex adapter 是否有 context 注入未核实 | P3 先 Claude 跑通，Codex 标注待验证，不硬说已统一 |

---

## 6. 最终方案（决策汇总）

1. **交互**：`@` 触发弹层（复用 `/` 那套），打字本地 fuzzy 筛，选中插入 `@path`。
2. **数据源**：`git ls-files --cached --others --exclude-standard -z`（主）+ Node 遍历 denylist（非 git 回退）；复用侧边栏 `files/*` 链路，加 `files/search`。
3. **性能**：搜索本地化（内存 fuzzy，零网络，不防抖节流）+ 拉取一次化（打开会话加载）+ top 20~30 cap。
4. **索引**：worker 生成 / 前端 TanStack Query 持有 / 打开会话触发；刷新交给用户 + 空态兜底。
5. **防误伤**：边界规则 + 存在性校验。
6. **给 agent**：注路径不注内容，走 AG-UI `context` 通道，正文 `@path` 作辅助；Codex 待验证。

---

## 7. 分期

- **P1**：前端弹层 + 本地筛 + 高亮 + 防误伤规则（mock 文件表跑通交互）。
- **P2**：后端 `files/search`（git ls-files --others）+ 前端拉取缓存 + 打开会话加载 + 手动刷新入口，替 mock。
- **P3**：发送时选中文件填进 `context`，Claude 端跑通；核实 Codex 的 context 注入。

## 8. 暂不做 / 待验证

- 超大仓降级（几万+ 文件，加 `query` 服务端过滤 + `truncated`）——留字段占位。
- worker 常驻索引缓存、自动失效、持久文件托盘、多分类 `@`（commit/会话）。
- Codex 的 context 注入（P3 核实）。
