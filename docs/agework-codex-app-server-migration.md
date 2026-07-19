# AgeWork Codex app-server 迁移开发文档（执行版）

> 文档状态：Implementation Ready — 决策已锁、协议已验证
> 目标仓库：`mewcoder/agework`，从最新 `main` 新建功能分支
> 修订日期：2026-07-12
> 目标读者：负责实施迁移的 AI Agent / 开发者
>
> **本文是执行契约。两份配套材料：**
> - **协议源真相**：[`docs/codex-app-server.md`](codex-app-server.md)（Codex 官方 app-server 协议全文）。**任何协议字段、方法名、消息顺序以它 + 本地 `generate-ts` 输出为准，不得凭本文示例猜测。**
> - **生成类型**：`codex app-server generate-ts` 的输出（见 §9、Ticket 02）。编译期类型以它为准。
>
> 本文已把一次设计评审（grilling）的 8 条决策锁进正文，并用 0.144.1 实测修正了初版文档的协议猜测。**决策不再重开**，标注 `【决策N】` 的地方按此实现。

## 0. 给实施 AI 的执行指令

改代码前依次完成：

1. 读 `CLAUDE.md`、`CONTEXT-MAP.md`、`.claude/rules/backend-architecture.md`、`.claude/rules/backend-naming.md`。
2. 读 [`docs/codex-app-server.md`](codex-app-server.md) 的 Protocol / Initialization / Approvals / Turns / Events / Errors 章节。
3. 读现有代码，画出现有 Codex 运行链路，**不得凭文件名猜**：
   - `packages/adapters/src/codex/base/adapter.ts`（纯协议→AG-UI 基类 `CodexAgentAdapter extends AbstractAgent`）
   - `packages/adapters/src/codex/base/{types,config,utils}.ts`
   - `packages/adapters/src/codex/business/codex-agent.adapter.ts`（NestJS+env+provider 注入子类）
   - `packages/adapters/src/claude/business/claude-agent.adapter.ts`（**HITL 参照实现**：`pendingActionSink` + `canUseTool` + terminal interrupt）
   - `apps/runtime/src/worker/agent/index.ts`（`createAgentDriver`，backend 分支在此）、`apps/runtime/src/worker/worker.ts`（runner 进程生命周期、finalize、`forceExitAfterInterrupt`）、`apps/runtime/src/worker/runner-manager.ts`（子进程 fork / SIGTERM→SIGKILL）
   - `apps/runtime/src/runner.ts`
   - `apps/server/src/run/**`（尤其 `run.service.ts` 的 `resumeWithAnswers` / `extractResumeAnswers`、`driver/**`）、`apps/server/src/run/docs/adr/0001-question-interrupt-terminal-model.md`
   - `packages/shared/src/protocol/run-events.ts`、`packages/shared/src/common/index.ts`（`PendingAction`）、`packages/react-ag-ui/src/runtime/types.ts`（`AgUiInterrupt` / `AgUiResumeEntry`）
4. 按 Ticket 顺序实施，每个 Ticket 验收通过再进下一项。
5. **不顺手重构** Claude Adapter、Runtime、WorkerManager、前端 RunSession。触碰到的局部命名按 `backend-naming.md`。
6. 不删除旧 `@openai/codex-sdk` 实现，直到 app-server 路径完成真实环境验证（Ticket 08）。

完成定义不是"能收到 Codex 文本"，而是：Thread 恢复、流式文本/Reasoning、命令与文件工具调用与输出流、**命令/文件/权限审批（用户中途批/拒）**、原生取消、错误、Usage、AG-UI 转换、进程清理全部可验证。

---

## 1. 为什么迁移（一句话）

**当前 `@openai/codex-sdk` 是单向接口，app-server 是双向协议。** SDK 的 `Thread` 只有 `run/runStreamed`，事件流纯出站，`approvalPolicy` 只是开 turn 前设死的静态枚举——**没有任何回调/方法把请求送回一个进行中的 turn**。所以今天 Codex 只能"按策略自动批"，无法"让用户中途批/拒命令与改文件"（Claude 已经能，靠 `pendingActionSink`+`canUseTool`）。

app-server 是 JSON-RPC，server 能反向发 request 并阻塞等 response。**审批、`turn/steer`、`tool/requestUserInput`、MCP elicitation 全部派生自这一个"双向"结构**——正是 SDK 从根上给不了的。plan/diff/usage 富通知是次要顺带品。

迁移的正当性完全系于一件事：**让 Codex 的用户级命令/文件审批与 Claude 平级**。第一阶段做到 Ticket 05（审批可用）即达成核心价值，可在此设检查点。

> 扩展背景（SDK 已承担的映射、难以从 SDK 获得的原生能力清单）见 git 历史里本文初版；此处不复述。

---

## 2. 决策摘要（已锁）

### 2.1 架构基线（沿用现状，非本次新增）
- 一个 **runner 进程 = 一个 run**：adapter 创建一次、`run()` 调一次、流结束即 `process.exit`。多轮续话靠持久化的 `agentSessionId` + `thread/resume`，**不靠活着的 adapter**。→ app-server 子进程随每个 run 起停（每消息冷启动），这与 Claude 的 `claude` CLI `query()` 每 run spawn **同构**，是既定基线，非新风险。
- app-server 只存在执行侧（runner 进程内），不进 AgeWork Server 控制面、不暴露给浏览器。
- **第一版一个 Codex Runner 一个 app-server（stdio 子进程）**。Worker 级共享 app-server 是未来 ADR，明确不在本次范围。

### 2.2 本次 8 条设计决策（grilling 结论，正文按此实现）

| # | 决策 | 落点 |
|---|---|---|
| **【决策1】版本策略** | generate-ts 只对 **Managed runtime 锁定的 codex 版本**生成；`initialize` 记录 `codexVersion`，与生成版本不一致时按 capability 表降级、不兼容则 `RUN_ERROR(version_mismatch)`；Registered/用户自带 codex 为 **best-effort，不阻塞**。 | §9、Ticket 02 |
| **【决策2】resume 契约泛化** | 不新开 Codex 专用命令。把 server 侧 `extractResumeAnswers`/`approval_resolved` 从"只输出 `answers`、只认 `status:resolved`"**泛化成透传不透明 `payload` + 接受 `status:cancelled`/decline**；Codex adapter 自解 `decision`；Claude 权限拒绝顺带解锁。 | §11、Ticket 05 |
| **【决策3】pendingUserAction 语义** | `PendingAction = "question" \| null` **不动**。它是"有待处理 HITL"的**粗粒度存在标志**，不是种类判别；具体种类/选项由消息上的 `AgUiInterrupt`（reason/responseSchema/metadata）承担。sidebar、派生规则、shared 类型都不改。 | §11.3 |
| **【决策4】目录排版** | app-server 沿用 **base/business 两层**：纯协议（client/translator/mapper/types/generated + AbstractAgent 子类）放 `base/`，框架无关；spawn/env 白名单/codexPath/Logger/脱敏放 `business/`。**不用文档初版的扁平 `app-server/`**。 | §6 |
| **【决策5】终态权威** | `error` 通知**永不直接终态**：只写 RawTrace + 置失败候选。终态一律由 `turn/completed{status}`（completed→RUN_FINISHED / failed→RUN_ERROR）或进程无终态而死（→候选转 RUN_ERROR）决定；终态后的迟到 error/warning 一律吞掉。 | §10.1、§14 |
| **【决策6】审批槽位** | **单槽串行**：并发的 app-server approval server-request 用 per-thread 队列串行成一次一个 `RUN_FINISHED{interrupt}`（沿用 Claude `permissionQueues` 同款）。resume 保持单槽（`resume[0]` / 按 threadId resolve）。 | §11.5、Ticket 05 |
| **【决策7】等价验收** | Ticket 03 的"与 SDK 等价"**不比逐事件序列**（ID 方案/富 item 不同，做不到）。改成两层：(a) 每个 fixture 独立过 AG-UI verifier + Message snapshot；(b) 跨 adapter **只断言最终落库 Message 等价**（assistant 文本 + tool calls，忽略 ID 与 app-server 独有额外 item）。 | Ticket 03 |
| **【决策8】SDK 回退** | 旧 SDK adapter 保留为回退，经 factory + env 切换；app-server 默认验证稳定后（Ticket 08）再单独 PR 删除。 | §12、Ticket 08 |

---

## 3. 目标架构

```text
Web / assistant-ui
      ^  AG-UI / SSE
AgeWork Server（Run / Conversation / RunEvent）
      ^  Worker Protocol
Worker（RunnerManager → runner 进程）
      +-- Claude Runner → Claude Agent SDK
      +-- Codex Runner
            -> CodexAppServerAdapter（base/business 两层，【决策4】）
                -> CodexAppServerClient（JSON-RPC over stdio）
                    -> spawn `<codexPath> app-server`（newline-delimited JSON）
                        -> Codex engine
```

数据流与初版一致；审批双向流见 §11。

---

## 4. 领域映射

| AgeWork | Codex app-server | 说明 |
|---|---|---|
| Workspace | `cwd`（`thread/start`/`turn/start`） | 执行目录，必须来自已校验的 Runtime Workspace 路径 |
| Conversation | Thread | 长期会话 |
| `Conversation.agentSessionId` | `threadId` | 跨 runner 恢复的锚点（**用 `thread.id`，不是 `sessionId`；fork 才有 sessionId≠id，本版不 fork**） |
| Run | 一次逻辑任务 | 产品侧一次任务 |
| Turn（codex） | 一次执行段 | **Turn : AG-UI run = 1:N**：一个 codex Turn 可跨初始 run + 审批后 continuation run |
| Message | Agent/User Item 投影 | 历史 UI 读模型（落库 Message 是 reload 权威，见【决策7】） |
| Tool Call | commandExecution / fileChange / mcpToolCall / … Item | AG-UI 工具展示 |
| PendingUserAction（粗状态） | — | 只是"有待处理 HITL"标志（【决策3】），值恒为 `"question"` |
| PendingCodexRequest（持 rpcId） | server request | 活在 **runner 进程内 adapter**，非 server |
| RunEvent | 关键 Thread/Turn/Item 事实 | 复用现有规范化 type/origin/target/refs（§13） |
| Raw Trace | 原始 JSON-RPC 消息 | 走现有 `AgentTraceSink` → `sdk.raw` JSONL 文件（§15） |

### 4.1 Thread 规则
- 新 Conversation 首次运行 `thread/start`；已有 `agentSessionId` 走 `thread/resume`。
- Thread ID 只由 Codex 产生（`thread/started` 通知里的 `thread.id`），经现有 `agent.sessionId` Custom Event 上报，AgeWork 不伪造。
- **Thread 恢复失败不得静默新建**：返回明确错误，由上层决定是否清 session。
- ⚠️ **新发现（必须处理）**：codex thread 持久化为 runtime 文件系统上的 JSONL rollout（`~/.codex/sessions`）。跨 runner 进程 `thread/resume` 依赖该目录在同一 runtime 上**跨 run 存活**。Managed-local 天然同 home；**Docker/容器若在 run 间 destroy 会丢 session**——必须确认 codex sessions 目录落在 stop（留）而非 destroy（删）的载体范围内（见 worker-manager ADR-0002 stop vs destroy）。Ticket 04 验收纳入。

### 4.2 Turn 规则
- 普通用户消息 → 一个 `turn/start`（`input: Array<UserInput>`，文本用 `{type:"text", text, text_elements:[]}`）。
- 审批回答**不创建新 Codex Turn**，是响应当前 pending server request。
- 审批后 continuation segment 仍属同一 Codex Turn（AG-UI 侧是新 run/resumeRunId）。
- `turn/interrupt` 取消当前 Turn（成功 `{}`，Turn 以 `status:"interrupted"` 收尾）。
- 第一阶段 `turnId` **不进 Run 表必填列**；存 live state / RawTrace / RunEvent refs。

---

## 5. 已验证协议要点（0.144.1，配合 `docs/codex-app-server.md`）

> 只列实现关键点与"文档初版猜错/需注意"处。完整定义查 `docs/codex-app-server.md` 与 generate-ts。

**帧 / 握手**
- stdio **newline-delimited JSON（JSONL）**，无 Content-Length。请求 `{method,id,params}`，响应 `{id,result|error}`，通知 `{method,params}`。**`jsonrpc:"2.0"` 在线上省略**（初版文档此点正确）。
- `initialize`(req) → `initialized`(notify)。握手前任何请求得 `Not initialized`；重复 `initialize` 得 `Already initialized`。
- `initialize.params = { clientInfo:{name,title,version}, capabilities? }`。`capabilities.experimentalApi` 默认省略/false=稳定面，实验方法被拒（`<descriptor> requires experimentalApi capability`）。**第一版 experimentalApi=false**（【决策1】阶段划分）。`clientInfo.name` 用于 OpenAI 合规日志标识，设 `"agework"`。

**Client→Server 我们只用这些方法（其余一律不发、不暴露）**
`initialize` / `thread/start` / `thread/resume` / `turn/start` / `turn/interrupt`（Phase2：`turn/steer`）。

**Server→Client 通知（真实方法名，映射见 §10）**
`thread/started`、`turn/started`、`turn/completed`、`turn/diff/updated`、`turn/plan/updated`、`item/started`、`item/completed`、`item/agentMessage/delta`、`item/reasoning/summaryTextDelta`、`item/reasoning/summaryPartAdded`、`item/reasoning/textDelta`、`item/commandExecution/outputDelta`、`item/fileChange/patchUpdated`、`thread/tokenUsage/updated`、`error`、`warning`、`serverRequest/resolved`、`thread/status/changed`。

**Server→Client 请求（审批/HITL，双向）**
- Phase1：`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`。
- Phase2：`item/tool/requestUserInput`、`mcpServer/elicitation/request`、`item/tool/call`(dynamic)。

**审批 decision 形状（generate-ts 实测，修正初版 §11.4）**
- 命令：`CommandExecutionApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel" | { acceptWithExecpolicyAmendment:{execpolicy_amendment} } | { applyNetworkPolicyAmendment:{network_policy_amendment} }`。响应 `{ decision }`。请求 params 带 `availableDecisions`——**UI 只渲染 server 给的这几项**（初版 §11.4 要求，用这个字段实现）。
- 文件：`FileChangeApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel"`。响应 `{ decision }`。
- 权限：**不是 decision 枚举**。`item/permissions/requestApproval` 响应 `{ permissions:GrantedPermissionProfile, scope:"session"|"turn", strictAutoReview? }`——回授予的子集 + 作用域。**初版把三者混为一个 decision 模型，错**；permission 单独处理。
- 命令审批可能带 `networkApprovalContext`（host/protocol）——这是**网络访问**提示不是 shell 命令；codex 按目的地分组，一个提示可解多个排队请求。UI 要能区分。

**收尾/幂等**
- `serverRequest/resolved{threadId,requestId}`：pending server-request 被应答**或**被 turn start/complete/interrupt 清理时都发。→ 收到即清本地 pending，避免重复应答同一 rpcId（【决策6】幂等）。
- `turn/completed.turn.status ∈ completed|interrupted|failed`；failed 带 `error:{message,codexErrorInfo?,additionalDetails?}`（httpStatusCode 在 codexErrorInfo 上）。

**已废弃、别用（修正初版）**
- `item/fileChange/outputDelta` 已废弃 → 用 `fileChange` item + `turn/diff/updated`。
- `thread/compacted` 通知已废弃 → 用 `contextCompaction` item。
- `agentMessage` item 带 `phase?: "commentary" | "final_answer"`（Responses API 值）——落库权威文本取 `item/completed` 的最终 item；注意 `phase` 语义，别把 commentary 当最终答案（Ticket 03 处理）。

---

## 6. 目录设计（【决策4】base/business 两层）

```text
packages/adapters/src/codex/
  base/                              # 框架无关纯协议→AG-UI（禁 @nestjs/*）
    adapter.ts                       # 现有 SDK 版，迁移期保留
    app-server/
      adapter.ts                     # AbstractAgent 实现（app-server 版）
      client.ts                      # JSON-RPC client（id/pending/timeout/notify/serverRequest 路由/initialize 状态机）
      event-translator.ts            # server notification → AG-UI
      approval-bridge.ts             # server request 收发 + pending 单槽 registry（【决策6】）
      item-mapper.ts                 # ThreadItem → tool/message 描述
      result-mapper.ts               # Turn status/usage/error → 终态（【决策5】）
      types.ts                       # 本模块内部类型
      generated/                     # codex app-server generate-ts 输出（§9）
      fixtures/                      # 真实 app-server JSONL（Ticket 01/03 用）
      *.spec.ts
  business/
    codex-agent.adapter.ts           # 现有 SDK 业务子类
    codex-app-server.adapter.ts      # app-server 业务子类：spawn/env 白名单/codexPath/Logger/脱敏
  factory.ts                         # 按 backend 选 sdk|app-server（§12；若已有工厂则复用，不新建）
```

**process 归属**：spawn `<codexPath> app-server` + env 白名单 + 子进程 kill 属执行关切，放 `business/`（可拆 `business/codex-app-server-process.ts`）。`base/app-server/client.ts` 只持有已建好的 stdin/stdout 做协议，不认 NestJS/spawn。

禁止：`domain/` `application/` `infrastructure/` `use-cases/` `manager/` `engine/`，以及扁平 `app-server/`（违反 base/ 框架无关边界）。

---

## 7. AppServerProcess（放 business/）

职责：解析并校验 codex 路径（复用 worker 现有 `codexExecutablePath` 解析，`agent/index.ts:131` 那条）；`spawn(codexPath, ["app-server"], { cwd, env, stdio:["pipe","pipe","pipe"], shell:false })`；暴露 stdio；监听 exit/error；优雅关闭+强杀；**不解析业务事件**。

硬约束：禁 `shell:true`、禁字符串拼命令；`cwd` 来自已校验 Workspace；env 沿用 Runner 显式白名单（`pickSafeEnv`）；stderr 进 worker 日志前过现有脱敏；**子进程退出必须 reject 全部 pending JSON-RPC**。

关闭策略：正常→关 stdin→短超时→SIGTERM→再超时→SIGKILL。取消→先 `turn/interrupt`→等 `turn/completed(interrupted)` 或 `serverRequest/resolved`→runner 清理时再关 app-server。异常→标 RUN_ERROR→reject 所有 pending→清子进程。

> **必须照做（§7 关键）**：子进程 kill 要挂进 runner 现有强制收尾——`worker.ts` 的 `forceExitAfterInterrupt` / parent-disconnect 路径必须显式杀掉 spawn 的 app-server，镜像 `runner-manager.ts` 的 SIGTERM→SIGKILL，否则孤儿进程。

---

## 8. CodexAppServerClient（放 base/app-server/）

- 单调递增 request id；`pendingRequests: Map<id,{resolve,reject,timer}>`。
- 分流 Response / Notification / ServerRequest（ServerRequest 有 `id`+`method`，走 approval-bridge 回调）。
- 请求级超时（`AGEWORK_CODEX_APP_SERVER_REQUEST_TIMEOUT_MS`，默认 30000）。
- 进程退出统一 reject 全部 pending。
- 非法 JSON 不得静默崩 worker：记录 + 计数 + 丢弃该行，继续读。
- **逐行流式解析 stdout，不整段缓存**；单行上限，超限写 Raw 文件并返回结构化错误。
- 每条输入输出进 Raw Trace（§15）。
- 初始化状态机：`created→process_started→initialize_sent→initialize_resolved→initialized_sent→ready→closing→closed`。**ready 前不允许 Thread/Turn 方法**。

初始化：
```ts
await client.request("initialize", { clientInfo:{ name:"agework", title:"AgeWork", version:AGEWORK_VERSION }, capabilities:{ experimentalApi:false } });
client.notify("initialized", {});
// 记录响应里的 codexVersion / platform（【决策1】版本 gate）
```

---

## 9. Schema 与版本（【决策1】）

- 用与 Managed runtime **锁定版本一致**的 codex 跑 `codex app-server generate-ts --out packages/adapters/src/codex/base/app-server/generated`。当前锁定 **0.144.1**（`packages/adapters/package.json` 的 `@openai/codex-sdk@^0.144.1`；平台二进制在 `apps/runtime` 由 `install-sdk-deps.mjs` 装）。
- 生成物提交入库；CI 加 **schema drift 检查**：临时 regen → 与库内 `generated/` diff，有差异则 CI 失败。
- `initialize` 记录运行期 `codexVersion` + `protocolBackend=app-server` 进 RawTrace/RunEvent。
- **版本 gate**：运行期 `codexVersion` ≠ 生成版本时——已知兼容按 capability 表降级；不兼容 `RUN_ERROR(version_mismatch)`；Registered/自带 codex best-effort 不阻塞。
- 发现不支持的方法/字段按 capability 降级，**不伪造成功**。

升级流程：更新 codex 版本 → regen → 查 diff → 更 mapper → 跑 fixtures → 真实 smoke → 才合并。

---

## 10. app-server → AG-UI 映射（真实方法名）

### 10.1 Turn 生命周期（【决策5】）
| app-server | AG-UI / AgeWork |
|---|---|
| `turn/started` | `RUN_STARTED` |
| `turn/completed`(status=completed) | `RUN_FINISHED` |
| `turn/completed`(status=interrupted) | Cancelled/Interrupted 终态 |
| `turn/completed`(status=failed) | `RUN_ERROR`（用 `turn.error`） |
| `error`(notify) | **只写 RawTrace + 置失败候选，不发终态** |
| 进程无终态而死 | `RUN_ERROR`（失败候选 ?? `process_exited`） |

规则：`error` 永不直接终态；终态只认 `turn/completed` / 进程死；终态后迟到 error/warning 一律吞。所有文本/Reasoning/Tool 流必须在 RUN_FINISHED/RUN_ERROR 前闭合。

### 10.2 Agent Message
`item/started(agentMessage)`→`TEXT_MESSAGE_START`；`item/agentMessage/delta`(`{itemId,delta}`)→`TEXT_MESSAGE_CONTENT`；`item/completed(agentMessage)`→补齐最终文本 + `TEXT_MESSAGE_END`。最终 item 是权威文本（注意 `phase`：commentary 非最终答案）。Message ID 用 app-server item id 加 run/turn 前缀防跨 turn 冲突。

### 10.3 Reasoning
`item/started(reasoning)`→`REASONING_START`+`REASONING_MESSAGE_START`；`item/reasoning/summaryTextDelta`→`REASONING_MESSAGE_CONTENT`（`summaryIndex` 增表新段）；`summaryPartAdded`→分段边界；`textDelta`→仅允许显示 raw 时用；`item/completed(reasoning)`→`REASONING_MESSAGE_END`+`REASONING_END`。默认展示 summary，不默认 raw。

### 10.4 Command Execution
`item/started(commandExecution)`→`TOOL_CALL_START`+`TOOL_CALL_ARGS(command,cwd)`；`item/commandExecution/outputDelta`→工具输出流式增量（优先 AG-UI tool result streaming，不支持则 Custom Event + RawTrace）；`item/completed(commandExecution)`→`TOOL_CALL_RESULT(status,exitCode,aggregatedOutput,durationMs)`+`TOOL_CALL_END`。

### 10.5 File Change
`item/started(fileChange)`→`TOOL_CALL_START(name=file_change)`；`turn/diff/updated`(`{threadId,turnId,diff}`)→AgeWork Changes Snapshot / Custom Event（Turn 聚合 diff，服务实时变更面板）；`item/completed(fileChange)`→`TOOL_CALL_RESULT(changes,status)`+`TOOL_CALL_END`（工具历史）。两者分工不可互替。⚠️ `item/fileChange/outputDelta` 已废弃勿用。

### 10.6 MCP / Dynamic / Collab / 其它 Item
Tool 名建议：`mcpToolCall`→`${server}.${tool}`；`dynamicToolCall`→`dynamic:${tool}`；`collabToolCall`→`collab:${tool}`；`webSearch`→`web_search`；`imageView`→`image_view`；`enteredReviewMode`/`exitedReviewMode`→`review_started`/`review_finished` Custom Event；`contextCompaction`→`context_compaction` Custom Event（⚠️ 用 item，不用已废弃的 `thread/compacted`）。未知 item：写 RawTrace + warning + **不失败 Turn + 不伪装已知工具**。

### 10.7 Plan / Usage
`turn/plan/updated`(`{turnId,explanation?,plan:[{step,status}]}`)→Plan State / Custom Event；`thread/tokenUsage/updated`(`{threadId,turnId,tokenUsage}`)→Context Meter / Usage State；`turn/completed` 的 usage→Run 最终 Usage。实时可更新前端，最终以 Turn 完成为准。

---

## 11. Approval Bridge 与 HITL（核心）

### 11.1 前提（已核实）
现有 terminal interrupt 模型是**表象终态 / 实质 pause**（ADR `0001-question-interrupt-terminal-model`）：adapter `next(RUN_FINISHED{outcome:interrupt})` 但**不 complete observable**，runner 保活等答复。Codex 用真实 pending JSON-RPC id 比 Claude 的假挂起 promise 更贴这个模型。→ 文档初版 §11.3 "发 RUN_FINISHED 但不关 runner/app-server" **成立**。

### 11.2 PendingCodexRequest（活在 runner 进程内 adapter）
```ts
type PendingCodexRequest = {
  rpcId: RequestId; method: string;       // e.g. "item/commandExecution/requestApproval"
  threadId: string; turnId: string; itemId: string;
  approvalId?: string | null;              // 命令审批的 zsh-exec-bridge 路由消歧
  createdAt: number; request: unknown;
  availableDecisions?: string[];           // 命令审批：只让 UI 展示这些
};
```

### 11.3 收到审批请求（单槽，【决策6】）
1. 若对应 item 未展示，补合成 AG-UI Tool Call。
2. 入 per-thread 单槽队列；一次只开一个。
3. 发 `RUN_FINISHED{outcome:{type:"interrupt", interrupts:[...]}}`；**不 complete observable、不关 app-server、不应答 rpc**。同时置 `pendingUserAction`（【决策3】恒 `"question"`）。
4. `AgUiInterrupt` 承载种类：`reason`（command/file→`confirmation`；tool input→`input_required`）、`metadata`（命令/diff/`availableDecisions`）、`responseSchema`。等用户答复。

### 11.4 用户答复（【决策2】泛化 resume 契约）
线上 `AgUiResumeEntry = { interruptId, status:"resolved"|"cancelled", payload? }` 本就 provider 无关。**要改的是 server 侧两处**：
- `extractResumeAnswers`（`run.service.ts`）：从"只输出 `answers`、只认 `status:resolved`"→**透传不透明 `payload`，并接受 `status:"cancelled"`**（映射为 decline/cancel）。
- `approval_resolved` 命令：从 `{answers,resumeRunId}`→`{payload,resumeRunId}`（payload 不透明，Claude 问答仍可放 `{answers}`）。

adapter 侧：
1. 校验答复属当前 thread/turn/item（单槽按 threadId）。
2. 校验 decision 在 `availableDecisions` 内（命令）；权限走 `{permissions,scope}` 形状。
3. 按方法回对应 JSON-RPC response（命令/文件 `{decision}`；权限 `{permissions,scope,strictAutoReview?}`）。
4. 发 continuation `RUN_STARTED`（resumeRunId），继续消费同一 Turn。
5. item 完成后发 Tool Result/End。

### 11.5 超时/取消/幂等
- Pending Approval 不设短业务超时，由 Run/Worker 生命周期管。
- Runner 收 Cancel：有 pending 先按协议回 `cancel`（若 `availableDecisions` 含）→ 调 `turn/interrupt` → 等 `turn/completed(interrupted)`。
- app-server 退出：所有 Pending 转 Run Error。
- **幂等**：收到 `serverRequest/resolved{requestId}` 即清本地 pending；不得对同一 rpcId 应答两次。

### 11.6 决策映射（真实值，修正初版）
- 命令：`accept | acceptForSession | decline | cancel | {acceptWithExecpolicyAmendment} | {applyNetworkPolicyAmendment}`。
- 文件：`accept | acceptForSession | decline | cancel`。
- 权限：非枚举，回 `{permissions, scope:"session"|"turn", strictAutoReview?}`。
- **UI 不得展示 server 未在 `availableDecisions`/策略里给的选项。**

---

## 12. Backend 切换（【决策8】）

现状**无工厂**，backend 分支是 `worker/src/agent/index.ts:createAgentDriver` 里 `if agentType==="claude" … else new CodexAgentAdapter`。新增：
```ts
// packages/adapters/src/codex/factory.ts
function createCodexAdapter(cfg) {
  return cfg.backend === "app-server" ? new CodexAppServerAdapter(cfg) : new CodexAgentAdapter(cfg);
}
```
worker 只调工厂，不知具体 backend。配置：
```text
AGEWORK_CODEX_BACKEND=sdk|app-server            # 迁移期默认 sdk，Ticket 08 改 app-server
AGEWORK_CODEX_APP_SERVER_EXPERIMENTAL=false
AGEWORK_CODEX_APP_SERVER_REQUEST_TIMEOUT_MS=30000
AGEWORK_CODEX_APP_SERVER_SHUTDOWN_TIMEOUT_MS=5000
```
能力声明（前端只展示实际支持）：`CodexCapabilities = { backend, approvals, userInput, steering, threadFork, review, plan, diff, contextUsage }`。

---

## 13. 状态 / 事实源 / RunEvent

事实源不变：产品数据在 AgeWork DB；codex 会话上下文在 codex Thread Store（runtime 文件系统 JSONL）；历史 UI Message 在 AgeWork Message；审计在 RunEvent；原始协议在 Raw JSONL。

不允许：用 `thread/list` 替代 Conversation 列表；用 codex thread 权限替代 Workspace 权限；靠重放全部 AG-UI event 恢复 server 状态；把 app-server item 原样全塞 RunEvent 表。

RunEvent：复用 `packages/shared/src/protocol/run-events.ts` 现有词汇——`permission_request` target、`permission.requested/resolved` type、`RunEventRefs.providerRequestId/sessionId` 都已存在。Codex 原始方法名放 `data`，**不无限增 Codex 专属 type**。建议事实：`codex.thread.started/resumed`、`codex.turn.started/interrupted/completed`、`codex.approval.requested/resolved`、`codex.process.exited`、`codex.protocol.warning`（映射到规范化 type/origin/target/refs）。

---

## 14. 错误处理（【决策5】）

错误分类 `CodexAppServerErrorKind`：`spawn_failed | initialize_failed | protocol_parse_failed | request_timeout | request_rejected | process_exited | thread_not_found | turn_failed | turn_interrupted | unsupported_method | version_mismatch`。

保留官方 `codexErrorInfo`（`ContextWindowExceeded | UsageLimitExceeded | HttpConnectionFailed | ResponseStreamConnectionFailed | ResponseStreamDisconnected | ResponseTooManyFailedAttempts | BadRequest | Unauthorized | SandboxError | InternalServerError | Other`，`httpStatusCode` 在其上）写入 RawTrace + RunEvent data，前端按类型给可操作提示。**不要只存 message。**

终态规则见 §10.1：`turn/completed` 是唯一终态权威；`error`/warning 非终态；终态后迟到消息不覆盖。

---

## 15. Raw Trace 与日志

复用现有链路：adapter `config.trace?.(...)` → worker `TraceLogWriter`（`worker.ts` 建，`apps/runtime/src/worker/logging/trace.ts`）→ `sdk.raw` JSONL append 到 `rawRuntimeFilePath`，admin 端点读回。**不新建并行 trace 管道。** 每条 JSON-RPC 消息形如：
```ts
type CodexAppServerTrace = { timestamp; direction:"client_to_server"|"server_to_client"; kind:"request"|"response"|"notification"|"server_request"; method?; id?; threadId?; turnId?; itemId?; payload };
```
脱敏：移除 API Key/Bearer/OAuth；env 仅白名单；命令可留但守大小限；大 MCP result/命令输出/diff 截断或转 Raw 文件；stderr 过脱敏。Raw 写失败不阻塞 Turn，但记 warning。

---

## 16. 分阶段 Tickets

> 关键路径到审批：01→02→03→04→05。06/07 可选（价值检查点后）。08 收尾。

### Ticket 01 — AppServerProcess + JSON-RPC Client（离线可单测）
范围：`business` 的 process（spawn/kill/stdio/exit）+ `base/app-server/client.ts`（id/pending/timeout/notify/serverRequest 路由/initialize 状态机）+ RawTrace 接口。
验收：测启动参数（`["app-server"]`、`shell:false`）；initialize 前禁业务请求；Response 正确关联 Request（乱序）；超时清 pending；进程退出 reject 全部 pending；非法 JSON 不静默吞。**不接 AG-UI、不接真 run。**

### Ticket 02 — 生成 Schema + Thread/Turn API + 版本 gate（【决策1】）
范围：generate-ts 提交 `generated/`；`thread/start`、`thread/resume`、`turn/start`、`turn/interrupt`；`thread.id` 上报；`initialize` 记 codexVersion + 版本 gate。
验收：新 Thread 成功；已有 Thread resume 成功；不存在 Thread 明确失败（**不静默新建**）；interrupt 后收 `turn/completed(interrupted)`；版本不符按 gate 行为（降级/`version_mismatch`）。

### Ticket 03 — 事件转换到 AG-UI（【决策5】【决策7】）
范围：§10 全部（Turn 生命周期、agentMessage/reasoning delta、command/file/mcp/webSearch item、usage、error 终态收敛、MESSAGES_SNAPSHOT 兼容）。
验收：(a) 每 fixture 独立过 AG-UI verifier（Start 都有 End、终态最后）+ Message snapshot；(b) **跨 adapter 只断言最终落库 Message 等价**（文本+tool calls，忽略 ID/额外 item）；(c) 最终 Message 能落库并重载。

### Ticket 04 — 真 Runner + SDK 回退 factory + 进程清理（【决策8】）
范围：`factory.ts` + env；runner 建 app-server adapter；Cancel 路由；子进程清理挂 `forceExitAfterInterrupt`/disconnect。
验收：`sdk` 模式无回归；`app-server` 模式完成真实 Codex Run；刷新后用 `agentSessionId` 续 Thread；Runner 退出后无残留 app-server 进程；**Docker：确认 codex sessions 目录跨 run 存活（stop 非 destroy），resume 不丢上下文**（§4.1 ⚠️）。

### Ticket 05 — Command/File/Permission 审批（核心 + 跨包，【决策2】【决策6】）
范围：`approval-bridge`（单槽 pending registry）+ AG-UI interrupt 发送 + **server 侧 resume 契约泛化**（`extractResumeAnswers`/`approval_resolved` 透传 payload + 接受 cancelled）+ shared/web 相应改动 + Decline/Cancel + 幂等（`serverRequest/resolved`）。
验收：Allow once / Allow for session / Decline / Cancel / 权限 `{permissions,scope}` 各通；重复回答被幂等拒；回答前刷新/断开状态明确；回答后同 Turn 继续；`availableDecisions` 外的选项 UI 不展示。

### Ticket 06 —（可选）Plan/Diff/实时 Usage/富 Item
`turn/plan/updated`、`turn/diff/updated`、`thread/tokenUsage/updated`、review/compaction/collab 基础映射。验收：Plan 实时且最终态正确；Diff 面板不靠扫本地文件；Context Meter 实时；未知 item 不致失败。

### Ticket 07 —（可选）实验能力
capability 开关 + `turn/steer` + `tool/requestUserInput` + MCP elicitation + 可选 Thread fork/read。验收：experimentalApi 关时 UI 不展示不支持能力；开时 Question 走现有 terminal interrupt + internal pause；codex 升级致实验方法变化在契约测试失败而非线上静默。

### Ticket 08 — 切默认 + 清理（【决策8】）✅
前置：CI 全绿；Native(mac/linux)+Docker 真实测试过；≥1 轮长期 Session Resume；审批/Interrupt/Error 均过。操作：默认 backend 改 app-server；SDK 留一个发布周期；更新 README/config 文档；稳定后单独 PR 删旧 SDK adapter。

**实施状态**：
- ✅ 默认 backend 已为 `app-server`（`factory.ts` `resolveCodexBackend` 默认返回 `"app-server"`）
- ✅ SDK 回退保留（`AGEWORK_CODEX_BACKEND=sdk` 切换）
- ✅ ADR-0001 状态更新为「已实施」
- ✅ `docs/config.md` 新增 Codex backend 配置说明
- ⏳ SDK adapter 删除留待稳定后单独 PR

---

## 17. 测试

- **单测**：Client（id 递增/乱序响应/超时/server error/notify 分发/serverRequest 分发/退出清理/非法消息）；Translator（文本 delta 与最终一致/最终修正 delta/reasoning 多段/命令多 chunk/file change/mcp/未知 item/turn success·fail·interrupted/Start-End 平衡）；ApprovalBridge（request→pending/allow·decline·cancel/权限形状/非法 decision/重复 decision 幂等/错 thread·turn·item/app-server 退出）。
- **Fixture 契约**：真实 app-server JSONL（basic-turn / reasoning-turn / command-execution / command-approval / file-change / file-approval / permission-request / mcp-tool-call / interrupted-turn / failed-turn / usage-limit / context-window-exceeded）；每个走 原始协议→Adapter→AG-UI verifier→Message snapshot。**用 spike 抓的真实 JSONL，不手搓过简对象。**
- **集成**（真 codex，可在无凭证 CI 跳过 + 单独 secret job）：initialize / 新建 Thread / 简单 Prompt / Resume / Interrupt / Command Approval / app-server 崩溃。
- **E2E**：选 Codex → 提交改文件任务 → 看 Reasoning/Plan/Command → 处理 Approval → 看 Diff → 完成 → 刷新一致 → 追问 resume 同 Thread。
- **Runtime 矩阵（第一阶段必测）**：Managed Native macOS / Managed Native Linux / Managed Docker Linux。后续：Registered Native（Beta）、OpenSandbox（不阻塞首版）。
- CI 扩展：`pnpm --filter @agework/adapters typecheck|test`、`@agework/runtime-host typecheck|test`、`server test`、`web test`、`pnpm build`、**Codex Schema drift check**（§9）。真实模型 smoke 独立触发/nightly，不卡普通 PR。

---

## 18. 安全（关键：双向协议的攻击面）

app-server 方法面巨大且危险（`command/exec`、`process/spawn`、`fs/*`、`config/value/write`、`thread/shellCommand`——**后者跑在沙箱外全权限**、`account/*`）。硬约束：
- app-server 仅 stdio，不开 TCP 端口，不暴露给浏览器。
- **AgeWork adapter 只发 §5 白名单那几个方法**（initialize/thread.start·resume/turn.start·interrupt[·steer]），并只**响应** server request；**其余方法一律不发**。
- 不接受前端任意 JSON-RPC 方法透传；前端只经 AgeWork 已定义命令/DTO 触发；`forwardedProps` 不得覆盖 app-server 方法/路径/安全策略。
- 所有 Approval 校验当前用户对 Conversation/Workspace 所有权；`cwd` 过现有路径安全校验；env 白名单；RawTrace 脱敏。
- `command/exec`、`fs/*`、config write、`process/*`、`thread/shellCommand` 第一版**不对前端开放**。Experimental API 默认关。

---

## 19. 性能 / 资源

stdout 逐行流式解析不整段缓存；单行上限超限转 Raw；命令输出不无限累积；大 diff/MCP 结果截断（完整入 RawTrace）；处理前端/worker 慢消费背压；Runner 完成确认 app-server 退出。指标：`codex.app_server.start_ms`、`codex.thread.resume_ms`、`codex.turn.first_event_ms`、`codex.turn.duration_ms`、`codex.approval.wait_ms`、`codex.protocol.parse_error_count`、`codex.process.unexpected_exit_count`。

---

## 20. 文档更新 + ADR

完成后更新 README（Codex 集成）、`docs/config.md`（backend 配置）、`CONTEXT-MAP.md`（codex adapter context）。新增/合并 ADR `packages/adapters/src/codex/docs/adr/0001-codex-app-server-first-class-backend.md`，记：为什么 SDK 不足（单向）、为什么仍投影 AG-UI、为什么每 Runner 一个 app-server、**为什么锁 Managed 版本 + 握手 gate（【决策1】）**、为什么保留 SDK 回退、何时重评 Worker 级共享。另在 `apps/server/src/run/docs/adr/` 补一条 resume 契约泛化（承接 `0001-question-interrupt-terminal-model`，记为什么 payload 透传 + 为什么接受 cancelled，【决策2】）。

---

## 21. 回滚

保留 `AGEWORK_CODEX_BACKEND=sdk`。以下立即回退 SDK：app-server 目标平台无法稳定启动 / Approval 致 Turn 永久挂起 / Thread Resume 上下文错 / AG-UI 序列频繁不合法 / codex 版本更新协议不兼容 / 子进程不可控泄漏。回滚只切 backend，不回滚数据模型。

---

## 22. Spike 复现（本文协议事实来源）

```bash
# 0.144.1 真实二进制（apps/runtime 装的平台包）
CODEX=node_modules/.pnpm/@openai+codex@0.144.1-darwin-arm64/node_modules/@openai/codex/vendor/aarch64-apple-darwin/bin/codex
"$CODEX" --version                      # codex-cli 0.144.1
"$CODEX" app-server generate-ts --out /tmp/gen   # → 顶层 ~90 类型 + v2/ 510 类型
# 方法名注册表:
cat /tmp/gen/ClientRequest.ts /tmp/gen/ServerRequest.ts /tmp/gen/ServerNotification.ts /tmp/gen/ClientNotification.ts
```
握手/审批 fixture 抓取需 codex 登录（`codex login`）后手动驱动 `initialize→initialized→thread/start→turn/start→触发命令审批`，逐行 stdout 存为 fixtures（Ticket 01/03）。协议全文见 `docs/codex-app-server.md`。

---

## 23. 最终目标

```text
Claude → Claude Agent SDK   → First-class
Codex  → Codex app-server   → First-class（本次）
其它    → 未来 ACP Adapter   → Compatible / Experimental
统一前端 → AG-UI → assistant-ui
```
AgeWork 不重实现 Agent Loop：官方 Agent 负责怎么完成任务；AgeWork 负责它们在哪运行、过程如何交互、权限如何控制、历史如何保存、结果如何审查。
