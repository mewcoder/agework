# Agent 日志与事件查看指南

> 本文是 [agent-event-trace-logging-plan.md](./agent-event-trace-logging-plan.md) Logging-only MVP 落地后的实操指南：出问题时去哪看、怎么看、怎么用。
> 设计背景和字段定义见 [agework-agent-event-protocol-design.md](./agework-agent-event-protocol-design.md)；ENV 默认值表见 [config.md](./config.md)。

## 总览：四个落点

一次 run 的过程会同时出现在四个地方，定位字段统一是 `runId / seq / source / eventType`：

| 落点 | 内容 | 默认是否开启 | 适合干什么 |
| --- | --- | --- | --- |
| 管理端 Run 时间线（DB `RunEvent` 表） | 事件摘要（标题/级别/summary，不含完整 payload） | 始终开启 | **第一步排查**，按时间线看一次 run 经过了哪些阶段 |
| API 进程控制台日志 | 事件分发、去重、seq gap、终态处理的 Nest 日志 | 始终开启 | 看 API 侧是否正确处理上行事件 |
| Worker 本地 JSONL 日志 | worker 进程内部的结构化日志（emit/control/adapter 等） | 始终开启 | 需要看 worker 侧细节、emit 失败、control 处理时 |
| Raw payload 文件（`*.raw.jsonl` / `*.agui.jsonl`） | SDK 原始消息 / AG-UI 原始事件全文 | 受 `AGEWORK_AGENT_EVENT_TRACE_ENABLED` 控制，默认开 | 需要还原某条消息/工具调用的完整原文时 |

排查顺序建议：**先看管理端时间线定位大致阶段 → 怀疑 worker 侧问题翻 worker JSONL → 需要原始数据再开 raw payload 文件**。API 控制台日志全程都在，随时可以对照。

下面 1-4 节都是面向开发者/管理员的排查手段。**普通登录用户没有这些入口**，看不到任何"日志"或事件细节，只能在产品 UI 上看到几种有限状态，见下一节。

## 普通用户能看到什么

普通用户（非 admin）能看到的只有产品 UI 上这三处，全部是被动展示，没有主动查询入口：

| 位置 | 看到什么 | 看不到什么 |
| --- | --- | --- |
| 侧边栏对话列表的状态 Badge | "运行中" / "待处理" / "错误" / "已完成" 四种汇总状态 | 具体处于哪个内部阶段（queued/preparing/cancelling 等）、错误堆栈、token 用量 |
| 聊天消息流里自动生成的错误消息（run 失败时） | 一条红框样式的 assistant 消息：`**{Claude/Codex} 运行失败**` + 错误文案 + 可选 `错误代码` | 完整堆栈、`seq`、是哪个 `source` 报的错 |
| 输入框上方的待处理操作卡片（`requires_action` 时出现） | 当前需要用户回答的问题本身 | run 为什么停在这一步、内部还有哪些待处理项 |

对应代码位置（普通用户不会直接接触，列出来方便你或同事核对实现）：

- 状态 Badge：`apps/web/src/components/sidebar/conversation-list-item.tsx`
- 错误消息文案与渲染：`apps/web/src/lib/runtime/agent-run-interceptor.ts`（把 `RUN_ERROR` 事件转成上面那条文本消息）、样式见 `apps/web/src/components/assistant-ui/assistant-message/message-error.tsx`
- 待处理操作卡片：`apps/web/src/components/assistant-ui/pending-question-panel.tsx`

后端目前**没有面向普通用户的 run 详情或事件接口**：`GET /api/v1/conversations/list`、`/conversations/query`、`POST /conversations/statuses/query` 只返回 `activeRunStatus`/`pendingUserAction` 两个汇总字段，不包含事件、错误详情或诊断信息。要看完整信息，只能走下面的管理端入口，需要 admin 角色——如果你需要排查某个普通用户报告的问题，实际上也是你（或拥有 admin 权限的同事）去管理端查，不是让那个用户自己查。

## 1. 管理端 Run 时间线

路径：登录管理员账号 → 设置 → **运行日志**（仅 admin 可见，对应前端 `apps/web/src/pages/admin/runs.tsx`）。列表选中一个 run 后，下方会按时间顺序渲染事件卡片。

每条事件展示：

- 级别 Badge：`debug` / `info` / `warn` / `error`（`error` 显眼标红）
- `source` Badge：`agui` / `sdk` / `runtime` / `control` / `system`
- `eventType`：如 `run.status.running`、`TOOL_CALL_START`、`worker.seq_gap`
- `seq`（如果有）
- 标题 + summary（不是完整 payload，只是摘要/预览）

背后接口：

```text
GET /api/v1/admin/runs/list?status=&pageNo=&pageSize=
GET /api/v1/admin/runs/query?id=<runId>
```

**已知限制**：`query` 接口的 `events` 目前固定取最早 200 条，没有分页/按 `source`/`eventType` 过滤的 UI——这是计划里 Phase 1 才会补的能力，当前 MVP 没做。如果一个 run 的事件超过 200 条（比如长对话、很多工具调用），后面的事件在这个时间线里看不到，需要去 worker JSONL 或 raw payload 文件里翻。

## 2. API 进程控制台日志

没有独立文件，就是 `pnpm dev:api`（或生产进程）终端里滚动的 Nest 日志，级别由 `AGEWORK_LOG_LEVEL` 控制（`debug`/`warn`/`error`/`verbose`，开发默认 `debug`）。

重点看 `RuntimeEventProcessor` 打的几类日志，现在都带 `runId/seq/source/eventType`：

```text
publish envelope {"runId":"...","seq":3,"lastSeq":2,"type":"agui.event","payload":{...}}
drop duplicate envelope {"runId":"...","seq":2,"lastSeq":2,"source":"runtime","eventType":"agui.event"}
seq gap detected {"runId":"...","expected":4,"got":6,"source":"runtime","eventType":"agui.event"}
run status {"runId":"...","status":"finished"}
```

`seq gap detected` 出现时，管理端时间线里同时会有一条 `eventType: "worker.seq_gap"` 的摘要事件（这次改造新增的），不需要只靠翻控制台日志才能发现 gap。

## 3. Worker 本地 JSONL 日志

文件路径：

```text
~/.agework/logs/runtime/<conversationId>.worker.log     # 每个会话一个文件
/tmp/agework-worker.log                                  # 未指定会话文件路径时的兜底（AGEWORK_INTERNAL_WORKER_LOG_FILE 可改）
```

`local`（fork 子进程）、`docker`、`opensandbox` 三种 runtime 写的都是这个 host 路径（容器内通过 volume mount 落到同一目录），所以不用区分 runtime 类型去找文件。

**这次改造后，每一行都是合法的单行 JSON（JSONL）**，可以直接用 `jq` 过滤，不用再用文本正则抠字段：

```bash
# 实时跟随
tail -f ~/.agework/logs/runtime/<conversationId>.worker.log | jq .

# 只看某个 run
cat ~/.agework/logs/runtime/<conversationId>.worker.log | jq 'select(.runId == "run-xxx")'

# 只看错误
cat ~/.agework/logs/runtime/<conversationId>.worker.log | jq 'select(.level == "error")'

# 只看 emit 失败/重试（worker 上报事件给 API 失败时打的标记）
cat ~/.agework/logs/runtime/<conversationId>.worker.log | jq 'select(.eventType | test("^emit\\."))'
```

每行字段：`time/level/message` 是固定的，其余字段视调用点而定，常见的有 `runId/conversationId/workspaceId/agentType/seq/source/eventType/commandId/attempt/status`。

> 注意：这里的 `source`/`eventType` 是写日志时手动打的自由字段（比如 `source: "worker"`、`eventType: "emit.failed"`），用来配合 `jq`/`grep` 过滤，**不是**管理端 `RunEvent.source` 那个固定枚举（`agui/sdk/runtime/control/system`）。两边目前是两套独立的标签体系，按场景对应着看就行，不要混用枚举去筛 worker 日志。

控制日志详细程度的开关：

| ENV | 作用 |
| --- | --- |
| `AGEWORK_WORKER_LOG_LEVEL` | `debug`/`info`/`warn`/`error`，开发默认 `debug`，生产默认 `info` |
| `AGEWORK_WORKER_LOG_MAX_FILE_MB` | 单文件大小上限（默认 50MB），超过后停止写入并打一行 `truncated` 标记 |

## 4. Raw payload 文件（SDK 原始消息 / AG-UI 原始事件）

文件路径同上目录：

```text
~/.agework/logs/runtime/<conversationId>.raw.jsonl    # SDK 原始消息（Claude/Codex adapter 的原始事件流）
~/.agework/logs/runtime/<conversationId>.agui.jsonl   # AG-UI 协议原始事件（RUN_STARTED/TOOL_CALL_*/TEXT_MESSAGE_* 等全文）
```

开关：

| ENV | 作用 |
| --- | --- |
| `AGEWORK_AGENT_EVENT_TRACE_ENABLED` | 是否生成上面两个文件，默认开 |
| `AGEWORK_AGENT_EVENT_TRACE_MAX_FILE_MB` | 单文件大小上限（默认 50MB） |

**语义要点**：这个开关只决定「要不要把完整原始 payload 落盘」。关掉它之后：

- 管理端 Run 时间线照常显示（DB `RunEvent` 摘要索引和这个开关无关，始终记录）。
- worker JSONL 日志照常记录。
- 只是这两个 `.raw.jsonl` / `.agui.jsonl` 文件不会生成，看不到完整原文，只能看摘要。

什么时候需要开：复现一个具体的工具调用参数/结果，或者怀疑 adapter 给的原始事件本身有问题（比如 AG-UI 事件类型不对、字段缺失），需要对照原文排查时。

## 5. 排查场景速查

**一次 run 表现异常（卡住/报错/取消没生效），从哪开始查：**

1. 管理端时间线看这个 run 最后落在哪个 `eventType`，`run.status.*` 是不是按预期推进。
2. 如果时间线里有 `worker.seq_gap` 或卡在某个 `agui.*` 事件不动，去 worker JSONL 按 `runId` 过滤，看 worker 是否真的发出了后续事件、有没有 `emit.retry`/`emit.failed`。
3. 如果 worker 日志显示发出去了但管理端没收到，去 API 控制台搜这个 `runId`，看有没有 `drop duplicate envelope` 或异常报错。
4. 需要还原某条工具调用的具体参数/结果原文，开 `AGEWORK_AGENT_EVENT_TRACE_ENABLED` 后从 `.agui.jsonl` 里按 `toolCallId` 找。

**怀疑事件丢失/乱序：**

```bash
# API 控制台搜这个 run 的 gap
grep "seq gap detected" <api日志> | grep "<runId>"
# 或直接在管理端时间线找 eventType = worker.seq_gap 的事件
```

**怀疑 worker 上报失败（终态卡在 running，或某条事件没出现在管理端）：**

```bash
cat ~/.agework/logs/runtime/<conversationId>.worker.log \
  | jq 'select(.eventType == "emit.failed" or .eventType == "status.terminal_failed")'
```

出现 `emit.failed` 时该条事件已经永久丢失（重试用尽或服务端 4xx 拒绝），不会自动补偿——这是当前 MVP 的已知限制，完整的可靠性保障（本地 spool / 强制终态）属于后续 Phase 5，没有在这轮做。

## 相关文档

- [agent-event-trace-logging-plan.md](./agent-event-trace-logging-plan.md) — 本轮改造的范围、决策和未来阶段规划
- [agework-agent-event-protocol-design.md](./agework-agent-event-protocol-design.md) — 事件协议设计背景
- [agent-event-system-review.md](./agent-event-system-review.md) — 改造前的体系评审
- [config.md](./config.md) — 全部 ENV 默认值参考表
