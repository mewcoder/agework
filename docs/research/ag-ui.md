# ag-ui

AG-UI（Agent-User Interaction Protocol）是前后端 Agent 通信的协议库，定义了消息格式、事件流、以及客户端 Agent 抽象。

## 包结构

| 包 | 作用 |
|----|------|
| `@ag-ui/core` | 事件类型定义、数据结构（`EventType`、`RunAgentInput` 等） |
| `@ag-ui/client` | 客户端 Agent 基类（`AbstractAgent`、`HttpAgent`）、中间件 |

## 核心概念

### RunAgentInput

每次 run 发起时传给后端的请求体：

```ts
{
  threadId: string      // AG-UI 协议字段，AgeWork 内部对应 conversationId
  runId: string         // 本次执行 ID，由 AbstractAgent 自动生成（uuid v4）
  messages: Message[]   // 消息历史
  state: any            // Agent 状态
  tools: Tool[]         // 可用工具
  forwardedProps: {}    // 透传给后端的自定义字段（如 agentType）
}
```

### EventType（后端 SSE 流返回的事件类型）

**生命周期**
- `RUN_STARTED` / `RUN_FINISHED` / `RUN_ERROR`
- `STEP_STARTED` / `STEP_FINISHED`

**文本消息**
- `TEXT_MESSAGE_START` → `TEXT_MESSAGE_CONTENT`（可多次）→ `TEXT_MESSAGE_END`

**工具调用**
- `TOOL_CALL_START` → `TOOL_CALL_ARGS`（流式）→ `TOOL_CALL_END` → `TOOL_CALL_RESULT`

**推理过程**
- `REASONING_START` → `REASONING_MESSAGE_*` → `REASONING_END`

**状态同步**
- `STATE_SNAPSHOT` / `STATE_DELTA`

**自定义**
- `CUSTOM`：后端可通过 `name` 字段传递业务事件（如 `agent.resumeId`、`system:init`）

## HttpAgent

前端通过 `HttpAgent` 与后端通信：

```ts
const agent = new HttpAgent({
  url: "/api/v1/agent/run",
  headers: { Authorization: `Bearer ${token}` },
});
```

`HttpAgent` 继承自 `AbstractAgent`，调用 `run(input)` 时：
1. `prepareRunAgentInput()` 自动补全 `runId`（uuid v4）
2. 发起 `POST` 请求，`Accept: text/event-stream`
3. 返回 `Observable<BaseEvent>`，事件按 SSE 格式流式解析

## 中间件

`AbstractAgent` 支持 `.use(middleware)` 注入中间件，在事件流上做变换：

- `FilterToolCallsMiddleware`：过滤允许/禁止的工具调用
- `FunctionMiddleware`：用函数快速创建中间件
- 内置向后兼容中间件（`BackwardCompatibility_0_0_39/45/47`）

## 在项目中的使用

见 `apps/web/src/components/MyRuntimeProvider.tsx`：

- 创建 `HttpAgent` 实例，包装 `run()` 方法注入 `threadId`（AG-UI 协议字段，值等于 AgeWork `conversationId`）、`agentType`
- 传给 `useAgUiRuntime`，由 assistant-ui 框架驱动调用
- 后端 `AgentController` 接收请求，根据 `agentType` 选择 `CodexAgentAdapter` 或 `ClaudeAgentAdapter` 执行
