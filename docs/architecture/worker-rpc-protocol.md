# Worker JSON-RPC 通信边界

> 当前结论：API 和 worker 的线缆协议只使用 JSON-RPC 2.0 形状；内部归一后的
> run-scoped 消息记录叫 `RunChannelMessage`。

## 1. 分层

```text
Browser
  ↓ AG-UI / SSE
API
  ↓ JSON-RPC over IPC or HTTP poll/post
Worker
  ↓ SDK / ACP / other agent driver
Agent
```

这几个名字不要混用：

- **JSON-RPC**：API 和 worker 之间的通信形状。它只定义 request / response / notification / batch。
- **AG-UI**：平台 UI 事件。worker 可以上报 `run.aguiEvent`，API 再投给前端。
- **SDK raw trace**：调试和审计事实，由 worker 直写 raw trace 文件，并可上报 `trace.sdkRaw` 索引事件。
- **RunChannelMessage**：API / worker 内部归一后的 run-scoped 消息记录。它不是 wire fallback。
- **AgentDriver**：worker 内部执行 agent 的能力边界。Claude/Codex SDK driver 和未来 ACP driver 都在这一层。

## 2. Transport

当前保留两种传输，协议形状一致：

| 场景 | Transport | 下行 | 上行 |
| --- | --- | --- | --- |
| local one-run worker | Node IPC | API `child.send(RpcNotification/RpcRequest)` | worker `process.send(RpcNotification/RpcResponse)` |
| persistent/sandbox worker | HTTP poll/post | worker `GET /worker/owners/:ownerId/commands` | worker `POST /worker/runs/:runId/events` |

HTTP 仍然是 polling，不引入 WebSocket。长期连接以后可以换，但不改变消息语义。

## 3. 下行命令

`GET /worker/owners/:ownerId/commands?afterSeq=N` 返回：

```json
{
  "messages": [
    {
      "jsonrpc": "2.0",
      "id": "cmd-1",
      "method": "run.cancel",
      "params": {
        "runId": "run-1",
        "conversationId": "conversation-1"
      },
      "meta": {
        "runId": "run-1",
        "seq": 12,
        "ts": "2026-06-27T00:00:00.000Z"
      }
    }
  ]
}
```

支持的 request method：

| Method | 语义 |
| --- | --- |
| `run.start` | persistent worker 收到新 turn，启动一次 run |
| `run.cancel` | 取消指定 run |
| `run.interrupt` | 中断指定 run 的当前 agent 执行 |
| `control.resolve` | 回传 human-in-the-loop / approval 结果 |

`id` 是 `commandId`，worker 处理后必须用同一个 `id` 回 `RpcResponse`。

## 4. 上行事件

`POST /worker/runs/:runId/events` 接受单条 RPC notification / response，或标准 JSON-RPC
batch 数组：

```json
[
  { "jsonrpc": "2.0", "method": "run.status", "params": {}, "meta": {} },
  { "jsonrpc": "2.0", "id": "cmd-1", "result": {}, "meta": {} }
]
```

支持的 notification method：

| Method | API 内部事件 |
| --- | --- |
| `run.status` | `run.status` |
| `run.aguiEvent` | `agui.event` |
| `trace.sdkRaw` | `sdk.raw` |
| `artifact.ref` | `artifact.ref` |
| `command.trace` | `command.trace` |

命令闭环用 JSON-RPC response：

```json
{
  "jsonrpc": "2.0",
  "id": "cmd-1",
  "result": {
    "ok": true,
    "runId": "run-1",
    "commandType": "cancel"
  },
  "meta": {
    "runId": "run-1",
    "seq": 13,
    "ts": "2026-06-27T00:00:01.000Z"
  }
}
```

`command.trace` 继续用于 timeline/diagnostics；业务闭环看 response 转出来的
`command.result`。

## 5. 校验策略

worker wire 边界只接受 RPC 消息：

- `jsonrpc` 必须等于 `"2.0"`。
- request 必须有合法 `id`、`method`、`params`。
- notification 必须有合法 `method`、`params`，且不能有 `id`。
- response 必须有合法 `id` 和 `result` 或 `error`。
- batch 必须是非空、非嵌套的 JSON-RPC 消息数组；任一 item 非法时整批拒绝，
  不做部分接收。
- `POST /worker/runs/:runId/events` 是 run-scoped 端点；每条消息归一后的
  `runId` 必须等于 route `:runId`，否则整批拒绝。
- `meta.runId` / `meta.seq` / `meta.ts` 若存在，类型必须正确。
- legacy message shape、legacy wrapper body、旧 `{ commands }` / 上行 `{ messages }`
  都不再接受。

payload 只做边界需要的最低结构校验：例如 `run.aguiEvent.event.type` 必须是字符串，
`run.status.status.status` 必须是合法 run status，`run.interrupt.runId` 必须存在，
`control.resolve.answers` 必须是 `Record<string, string | string[]>`。`input`、raw trace
payload、AG-UI 扩展字段继续透传。

## 6. Raw Trace

raw trace 不由 API 回拉再写。worker 持有 `agentEventTrace.rawRuntimeFilePath` 和
`aguiRuntimeFilePath` 时直接写 JSONL：

```text
Worker -> raw SDK JSONL
Worker -> AG-UI JSONL
Worker -> RPC trace/sdk index event
```

API 只处理平台事件和索引事件，不理解 Claude/Codex SDK 的所有原始细节。

## 7. ACP 的位置

ACP 可以作为未来 `AcpAgentDriver` 的 agent-side 实现，但不作为 AgeWork 的底层 wire
协议。原因是 ACP 解决的是 client ↔ agent 子进程这一跳；AgeWork 还需要 API ↔ worker
的多租户 run 生命周期、trace、AG-UI 投影、HITL resume 和 sandbox 边界。

因此目标是：

```text
Worker wire: JSON-RPC
Worker execution: AgentDriver
Agent breadth option: AcpAgentDriver
UI contract: AG-UI / platform events
```
