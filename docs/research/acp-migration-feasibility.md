# agework Agent 适配层架构研究：ACP 迁移可行性与方案探讨

> 研究日期：2026-06-26
> 研究范围：ACP (Agent Client Protocol) 替代现有 vendor SDK 直接调用的可行性，AG-UI 协议的定位与去留
> 参考源码：`reference-source-code/` (ACP/AG-UI/Claude/Codex SDK) + `/Users/mew/code/agent-project/software-agent-sdk/` (OpenHands 源码)

---

## 1. 背景与现状

### 1.1 当前架构

```
┌─────────────────────────────────────────────────────────┐
│  Frontend (React)                                        │
│  @assistant-ui/react + @assistant-ui/react-ag-ui         │
│  useAgUiRuntime(agent: AbstractAgent)                    │
└──────────────────────┬──────────────────────────────────┘
                       │ AG-UI Observable<BaseEvent>
┌──────────────────────┴──────────────────────────────────┐
│  packages/adapters                                        │
│  ClaudeAgentAdapter / CodexAgentAdapter                   │
│  extends AbstractAgent from @ag-ui/client                │
│  直接调用 vendor SDK，事件流 → AG-UI events               │
└──────────────────────┬──────────────────────────────────┘
                       │ vendor SDK (claude-agent-sdk / codex-sdk)
┌──────────────────────┴──────────────────────────────────┐
│  apps/worker                                              │
│  单次模式: IPC / 持久模式: HTTP long-poll                  │
│  RunRouter 按 AgentType 路由                              │
└──────────────────────┬──────────────────────────────────┘
                       │ RuntimeChannel
┌──────────────────────┴──────────────────────────────────┐
│  apps/api (NestJS)                                        │
│  Run 生命周期管理、事件持久化、Worker 控制                   │
└─────────────────────────────────────────────────────────┘
```

**关键组件**：

| 组件 | 路径 | 职责 |
|---|---|---|
| Claude 适配器 (Base) | `packages/adapters/src/claude/base/adapter.ts` | Claude SDK → AG-UI 事件转换 |
| Claude 适配器 (Business) | `packages/adapters/src/claude/business/claude-agent.adapter.ts` | 权限处理、环境配置、日志 |
| Codex 适配器 (Base) | `packages/adapters/src/codex/base/adapter.ts` | Codex SDK → AG-UI 事件转换 |
| Codex 适配器 (Business) | `packages/adapters/src/codex/business/codex-agent.adapter.ts` | Provider 注入、沙箱配置 |
| AG-UI Runtime | `packages/react-ag-ui/src/useAgUiRuntime.ts` | AG-UI events → assistant-ui runtime |
| Worker 主入口 | `apps/worker/src/main.ts` | 适配器创建、IPC/HTTP 通道 |
| RunRouter | `apps/worker/src/run-router.ts` | 按 agentType 路由 run 到适配器 |

**当前适配器的核心职责**：
1. 启动 vendor SDK 会话（`claude-agent-sdk` 的 `query()` / `codex-sdk` 的 `Codex.startThread()`）
2. 将 vendor SDK 的流式事件转换为 AG-UI 的 ~30 种 `BaseEvent`
3. 管理 session 生命周期（创建、恢复、过期清理）
4. 处理权限请求（`canUseTool` callback → `pendingQuestions` Map）
5. 注入环境变量和配置

### 1.2 引入 ACP 的动机

- **标准化**：ACP 是 Zed Industries 主导的开放协议，已有 Claude 和 Codex 官方适配器
- **编辑器生态兼容**：与 Zed、VS Code 等编辑器共享 agent 配置
- **MCP 兼容**：ACP 复用 MCP 的 ContentBlock 类型，便于集成 MCP 工具生态
- **减少维护**：理论上可复用官方 ACP 适配器，减少自建适配器的维护负担

---

## 2. 协议对比分析

### 2.1 ACP (Agent Client Protocol)

**来源**：Zed Industries，Apache-2.0 许可
**版本**：Protocol v1，SDK v1.0.0 (2026-06-24)
**包名**：`@agentclientprotocol/sdk`

**传输层**：
- stdio（唯一稳定传输）
- HTTP streaming（草案阶段）
- WebSocket（草案阶段）

**通信模型**：JSON-RPC 2.0，双向调用

**Agent 端方法**（Client → Agent）：

| 方法 | 用途 |
|---|---|
| `initialize` | 握手、协议版本协商、能力交换 |
| `authenticate` | 认证流程 |
| `session/new` | 创建会话 |
| `session/load` | 加载已有会话 |
| `session/resume` | 恢复会话 |
| `session/prompt` | 发送用户 prompt，获取流式响应 |
| `session/cancel` | 取消活跃 prompt |
| `session/close` | 关闭会话 |
| `session/set_config_option` | 会话配置 |
| `providers/list` | 列出可用模型 |
| `providers/set` | 选择模型 |

**Client 端方法**（Agent → Client）：

| 方法 | 用途 |
|---|---|
| `session/update` | 流式会话更新（agent_message_chunk, tool_call, tool_call_update 等） |
| `session/request_permission` | 工具执行权限请求 |
| `fs/read_text_file` | 文件读取 |
| `fs/write_text_file` | 文件写入 |
| `terminal/create` | 创建终端 |
| `terminal/output` | 终端输出 |
| `elicitation/create` | 交互式表单输入 |

**事件类型**（`session/update` payload）：
- `agent_message_chunk` — 文本片段
- `tool_call` — 工具调用开始/更新
- `tool_call_update` — 工具调用状态更新
- `agent_thought_chunk` — 推理片段
- `plan` — 计划更新
- `usage_update` — token 用量
- `mode_change` — 模式切换

### 2.2 AG-UI (Agent-User Interaction Protocol)

**来源**：CopilotKit，开源
**包名**：`@ag-ui/client`, `@ag-ui/core`

**传输层**：SSE、WebSocket、HTTP binary (protobuf)、webhooks

**通信模型**：事件流（Observable），单向（Agent → Client）

**事件类型（~30 种）**：

| 类别 | 事件 |
|---|---|
| 生命周期 | `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR`, `STEP_STARTED`, `STEP_FINISHED` |
| 文本 | `TEXT_MESSAGE_START`, `TEXT_MESSAGE_CONTENT`, `TEXT_MESSAGE_END`, `TEXT_MESSAGE_CHUNK` |
| 工具 | `TOOL_CALL_START`, `TOOL_CALL_ARGS`, `TOOL_CALL_END`, `TOOL_CALL_CHUNK`, `TOOL_CALL_RESULT` |
| 状态 | `STATE_SNAPSHOT`, `STATE_DELTA`, `MESSAGES_SNAPSHOT` |
| 推理 | `REASONING_START`, `REASONING_MESSAGE_START/CONTENT/END`, `REASONING_END` |
| 活动 | `ACTIVITY_SNAPSHOT`, `ACTIVITY_DELTA` |
| 元数据 | `RAW`, `CUSTOM` |

**核心类型**：
- `RunAgentInput` — `{ threadId, runId, messages, tools, context, state, forwardedProps }`
- `AbstractAgent` — 基类，`run(input) → Observable<BaseEvent>`
- `Message` — 消息联合类型（developer, system, assistant, user, tool, activity, reasoning）
- `Interrupt` — 人机交互中断协议

### 2.3 对比总结

| 维度 | ACP | AG-UI |
|---|---|---|
| **设计目标** | 编辑器 ↔ Coding Agent | 应用 ↔ 任意 AI Agent |
| **通信模型** | 双向 JSON-RPC (请求/响应 + 通知) | 单向事件流 (Agent → Client) |
| **传输** | stdio (稳定)，HTTP/WS (草案) | SSE, WS, HTTP binary, webhooks |
| **会话模型** | 显式 Session 生命周期 (new/load/resume/close) | Thread-based + Run ID |
| **状态管理** | Agent 管理 session，Client 获取更新 | 共享状态 (STATE_SNAPSHOT/STATE_DELTA) |
| **工具模型** | Agent 持有工具，Client 提供权限 | Client 提供工具给 Agent |
| **人机交互** | Permission requests + Elicitation forms | Interrupt 协议 |
| **适用场景** | 本地编码 agent，编辑器集成 | Web 应用，任意 agent 后端 |
| **成熟度** | SDK v1.0.0，协议 v1 | 已有多个框架集成 (LangGraph, CrewAI, Mastra) |

**核心差异**：ACP 和 AG-UI 服务于不同架构层次。ACP 解决 "编辑器如何与编码 agent 通信"，AG-UI 解决 "应用如何与 agent 交互并展示结果"。两者不是替代关系，而是可以互补。

---

## 3. 参考实现：OpenHands 的 ACP 架构（基于源码分析）

> 源码位置：`/Users/mew/code/agent-project/software-agent-sdk/`
> 仓库：[OpenHands/software-agent-sdk](https://github.com/OpenHands/software-agent-sdk) (843 stars) + [OpenHands/agent-canvas](https://github.com/OpenHands/agent-canvas)
> OpenHands 78.4k stars，已在生产环境中采用 ACP 作为可选 agent 后端

### 3.1 整体架构

```
┌─────────────────────────────────────────────────────────┐
│  Agent Canvas (前端, @openhands/agent-canvas)            │
│  React UI, 可连接多个 Agent Server backend               │
└──────────────────────┬──────────────────────────────────┘
                       │ HTTP REST + WebSocket
┌──────────────────────┴──────────────────────────────────┐
│  Agent Server (FastAPI, openhands/agent_server)          │
│  ConversationService → EventService → PubSub[Event]     │
├──────────────────────────────────────────────────────────┤
│  SDK 层 (openhands-sdk)                                  │
│  ┌─ Agent (内置 LLM agent, 直接调用 LLM API)             │
│  └─ ACPAgent (ACP 子进程代理)                             │
│       └─ _OpenHandsACPBridge (JSON-RPC client)           │
├──────────────────────────────────────────────────────────┤
│  Workspace 层 (openhands-workspace)                      │
│  LocalWorkspace / DockerWorkspace / APIRemoteWorkspace   │
└─────────────────────────────────────────────────────────┘
```

**源码包结构**：

| 包 | 路径 | 职责 |
|---|---|---|
| `openhands-sdk` | `openhands-sdk/openhands/sdk/` | 核心抽象：Agent、Conversation、Event、Tool |
| `openhands-agent-server` | `openhands-agent-server/openhands/agent_server/` | FastAPI REST API + WebSocket |
| `openhands-workspace` | `openhands-workspace/openhands/workspace/` | Docker/Apptainer/Cloud workspace 实现 |

### 3.2 Agent 多态设计

OpenHands 的核心设计是 **Agent 多态**：`Agent`（内置 LLM agent）和 `ACPAgent`（ACP 子进程代理）共享同一个 `AgentBase` 接口，`LocalConversation` 对两者透明处理。

```
AgentBase (抽象基类)
├── Agent         — 直接调用 LLM API，内置工具执行
└── ACPAgent      — 通过 JSON-RPC over stdio 与外部 ACP agent 通信
```

**关键源码**：
- `openhands-sdk/openhands/sdk/conversation/impl/local_conversation.py` — 同时处理 Agent 和 ACPAgent
- `ACPAgent.init_state()` 负责启动 ACP 子进程
- `ACPAgent.step()` 将用户消息推送给 ACP agent 并等待响应

### 3.3 ACP 子进程管理（源码级细节）

**子进程启动流程**（`ACPAgent._start_acp_server()`）：

1. 构建子进程环境：`default_environment()` → overlay `os.environ` → 剥离 npm 变量 → 注入 `secret_registry` 值 → 物理化文件 secret → 隔离数据目录 → 剥离冲突环境变量
2. `asyncio.create_subprocess_exec(command, *args, stdin=PIPE, stdout=PIPE, stderr=PIPE, env=env)`
3. 安装 `_filter_jsonrpc_lines` 协程过滤非 JSON-RPC 的 stdout 噪音
4. 创建 `ClientSideConnection(client, process.stdin, filtered_reader)`
5. `conn.initialize(protocol_version=1)` — 发现服务端身份
6. `conn.authenticate(method_id=...)` — 如服务端需要认证
7. `conn.load_session(cwd, session_id, mcp_servers)` 或 `conn.new_session(cwd, mcp_servers, **meta)` — 创建/恢复 ACP session
8. 设置 session mode，应用模型选择

**ACP Provider 注册表**（`openhands-sdk/openhands/sdk/settings/acp_providers.py`）：

```python
ACP_PROVIDERS = MappingProxyType({
    "claude-code": ACPProviderInfo(
        display_name="Claude Code",
        default_command="npx -y @agentclientprotocol/claude-agent-acp@0.44.0",
        api_key_env="ANTHROPIC_API_KEY",
        session_mode="bypassPermissions",
        binary="claude-agent-acp",
        data_dir_env="CLAUDE_CONFIG_DIR",
        # ...
    ),
    "codex": ACPProviderInfo(
        display_name="Codex",
        default_command="npx -y @zed-industries/codex-acp@0.16.0",
        api_key_env="OPENAI_API_KEY",
        session_mode="full-access",
        binary="codex-acp",
        data_dir_env="CODEX_HOME",
        # ...
    ),
    "gemini-cli": ACPProviderInfo(
        display_name="Gemini CLI",
        default_command="npx -y @google/gemini-cli@0.46.0 --acp",
        api_key_env="GEMINI_API_KEY",
        session_mode="default",
        binary="gemini",
        data_dir_env="HOME",
        # ...
    ),
})
```

### 3.4 ACP → OpenHands 事件映射（源码级）

**桥接类**：`_OpenHandsACPBridge`（`ACPAgent` 的内部类）实现 ACP `Client` 协议。

`session_update()` 方法接收 ACP 通知并映射：

| ACP 通知类型 | OpenHands 事件 | 处理逻辑 |
|---|---|---|
| `AgentMessageChunk` (TextContentBlock) | 通过 `on_token` 回调流式传递 + 累积到 `accumulated_text` | 经过 secret masking |
| `AgentThoughtChunk` (TextContentBlock) | 累积到 `accumulated_thoughts` | 最终合并为 `ActionEvent.reasoning_content` |
| `ToolCallStart` | `ACPToolCallEvent`（早期 "started" 事件） | 按 `tool_call_id` 去重 |
| `ToolCallProgress` (terminal status) | `ACPToolCallEvent`（终态事件） | 仅在首次转换到 `completed`/`failed` 时发出 |
| `UsageUpdate` | 存储用于 `_record_usage()` | cost, tokens, context window |
| `PromptResponse` | `FinishAction` + `FinishObservation` + `ActionEvent` + `ObservationEvent` | 一个完整的 assistant turn |

**`ACPToolCallEvent` 特点**（`openhands-sdk/openhands/sdk/event/acp_tool_call.py`）：
- 字段：`tool_call_id`, `title`, `status`, `tool_kind`, `raw_input`, `raw_output`, `content`, `is_error`
- `is_patch_edit` 属性：检测 content 或 raw_input 中的 diff 块
- **不是** `LLMConvertibleEvent` — 不参与 LLM 消息转换
- 下游去重：`RemoteEventsList._add_event_unsafe()` 按 `tool_call_id` 合并，用终态替换 "started"

**Secret Masking**：每个 ACP 事件在到达 `on_token`/`on_event` 前都经过 `state.secret_registry.mask_secrets_in_output` 处理。

### 3.5 Conversation 双路径设计

| 维度 | LocalConversation | RemoteConversation |
|---|---|---|
| 执行位置 | 进程内 `agent.step()` | 委托给 Agent Server (REST/WS) |
| 状态访问 | 直接 `ConversationState` | `RemoteState` (REST + WS 缓存) |
| 事件存储 | `EventLog` (append-only list) | `RemoteEventsList` (REST 同步 + WS) |
| Hooks | 本地加载执行 | 发送到服务端执行 |
| ACP 子进程 | 由 `ACPAgent` 本地启动 | 在服务端启动 |
| 模型切换 | 直接 `agent.set_acp_model()` | REST 调用服务端 |

**远程对话流程**：
1. `RemoteConversation` 构造函数通过 `POST /api/conversations` 在服务端创建对话
2. 启动 `WebSocketCallbackClient`，连接 `ws://host/sockets/events/{conversation_id}`
3. 等待初始 `ConversationStateUpdateEvent`（全状态快照）作为就绪信号
4. 协调事件（REST fetch + WS merge）捕获 REST 同步和 WS 订阅之间的遗漏事件
5. `send_message()` POST 到 events endpoint
6. `run()` POST 到 run endpoint，然后通过 WS 队列等待终态 `ConversationStateUpdateEvent`

### 3.6 Workspace 抽象

```
BaseWorkspace (abstract)
├── LocalWorkspace       — 直接文件系统操作
└── RemoteWorkspace      — HTTP 客户端到 Agent Server
    ├── DockerWorkspace  — 管理 Docker 容器生命周期
    └── APIRemoteWorkspace — 连接远程 sandbox API
```

同一 SDK API 跨所有 workspace 类型 — 切换只需更换 workspace 参数，代码无需修改。

### 3.7 Settings 驱动的 Agent 配置

```python
# 判别联合体，按 agent_kind 选择
AgentSettingsConfig = Annotated[
    OpenHandsAgentSettings | ACPAgentSettings,
    Discriminator(_agent_settings_discriminator),
]
```

`ACPAgentSettings` 关键字段：
- `acp_server`: `"claude-code" | "codex" | "gemini-cli" | "custom"`
- `acp_command`: 可选的显式命令覆盖
- `acp_model`: 模型标识
- `acp_session_mode`: session mode ID
- `acp_prompt_timeout`: 不活动超时（默认 1800s）
- `mcp_config`: 转发给 ACP 子进程的 MCP servers
- `acp_isolate_data_dir`: 每对话 CLI 数据目录隔离

### 3.8 OpenHands 与 agework 的架构对比

| 维度 | OpenHands | agework |
|---|---|---|
| **语言** | Python (FastAPI) | TypeScript (NestJS) |
| **前端** | Agent Canvas (React, npm) | assistant-ui + react-ag-ui |
| **Agent 通信** | ACP (stdio) 或内置 SDK | 直接调用 vendor SDK (TS) |
| **Agent 多态** | `AgentBase` 接口，`Agent`/`ACPAgent` 实现 | `AbstractAgent` 基类，各 adapter 独立实现 |
| **事件系统** | 统一 `Event` 层次 + PubSub + WebSocket | AG-UI `BaseEvent` Observable + IPC/HTTP |
| **Workspace** | 抽象层 (local/Docker/remote) | Worker 进程绑定 workspace |
| **子进程管理** | `ACPAgent._start_acp_server()` 统一管理 | Worker 通过 vendor SDK 管理 |
| **Agent 切换** | 按 backend 配置，UI 可切换 | 按 run 配置，RunRouter 路由 |
| **会话持久化** | `ConversationState` + `EventLog` | Prisma DB + 事件溯源 |
| **协议** | REST + WebSocket | AG-UI Observable + IPC/HTTP |

### 3.9 OpenHands 方案的关键启示

**值得借鉴的模式**：

1. **ACP 作为可选插件，非强制替换**：内置 `Agent` 仍然使用自己的 LLM SDK，`ACPAgent` 是平等的替代选项。这避免了全面迁移的风险。

2. **Agent 多态接口**：`AgentBase` 统一了两种 agent 的调用方式，`LocalConversation` 无需关心底层是哪种 agent。agework 的 `AbstractAgent` 已有类似设计。

3. **事件映射层隔离**：`_OpenHandsACPBridge` 将 ACP 事件转换封装在 ACPAgent 内部，不污染上层事件系统。AG-UI 的 `BaseEvent` 也可以用类似方式从 ACP 生成。

4. **Settings 驱动配置**：`AgentSettingsConfig` 判别联合体按 `agent_kind` 选择配置，`ACP_PROVIDERS` 注册表集中管理所有 ACP provider 元数据。agework 的 `AgentProviderConfig` 已有类似结构。

5. **Secret 管理**：ACP 子进程的环境变量注入、secret masking、数据目录隔离等细节，是生产环境必须处理的。

**与 agework 的关键差异**：

| 差异点 | 影响 |
|---|---|
| OpenHands 是 Python，ACP SDK 是 TypeScript | agework 是 TypeScript 全栈，ACP SDK 原生可用，无需跨语言桥接 |
| OpenHands Agent Server 是单机 REST API | agework 是分布式 Worker 架构，ACP 子进程需要在 Worker 内管理 |
| OpenHands 前端通过 WebSocket 接收原始 Event | agework 前端通过 AG-UI Observable 接收 BaseEvent，需要桥接层 |
| OpenHands 的 ACP 子进程在 Agent Server 内启动 | agework 的 Worker 已有进程管理（IPC/HTTP），需要适配 |

---

## 4. 方案探讨

### 4.1 方案 A：保持现状（推荐）

**架构**：维持现有直接 SDK 调用方式不变

```
Frontend → AG-UI → Adapter (extends AbstractAgent) → Vendor SDK → Agent
```

**优势**：
- 架构简洁，无额外间接层
- 直接使用 vendor SDK，调试链路短
- Worker 已有成熟的 IPC/HTTP 通道管理
- 适配器代码已有完整实现（Claude ~1700 行，Codex ~800 行）

**劣势**：
- 每个新 agent 需要自建适配器
- 无法与编辑器生态共享 agent 配置
- vendor SDK 变更时需要同步更新适配器

**适用场景**：当前阶段，无编辑器集成需求

---

### 4.2 方案 B：底层替换为 ACP，保留 AG-UI

**架构**：

```
Frontend → AG-UI → ACP-to-AGUI Bridge → ACP Client → stdio → ACP Agent Server
```

**具体变更**：

1. **新增 ACP-to-AGUI 桥接层**：将 ACP `session/update` 事件映射为 AG-UI `BaseEvent`
2. **新增 ACP 子进程管理**：在 Worker 中启动和管理 ACP agent server 子进程
3. **适配器重构**：`ClaudeAgentAdapter`/`CodexAgentAdapter` 改为 ACP 客户端

**ACP → AG-UI 事件映射**：

| ACP session/update 类型 | AG-UI 事件 |
|---|---|
| `agent_message_chunk` | `TEXT_MESSAGE_START` + `TEXT_MESSAGE_CONTENT` + `TEXT_MESSAGE_END` |
| `tool_call` (status: pending) | `TOOL_CALL_START` + `TOOL_CALL_ARGS` |
| `tool_call_update` (status: in_progress) | `TOOL_CALL_ARGS` (增量) |
| `tool_call_update` (status: completed) | `TOOL_CALL_END` |
| `tool_call_update` (status: failed) | `TOOL_CALL_END` (with error) |
| `agent_thought_chunk` | `REASONING_MESSAGE_START` + `REASONING_MESSAGE_CONTENT` + `REASONING_MESSAGE_END` |
| `plan` | `CUSTOM` (plan update) |
| `usage_update` | `CUSTOM` (usage data) |
| `mode_change` | `CUSTOM` (mode data) |

**需要新增的 AG-UI 事件**（ACP 中无直接对应）：
- `RUN_STARTED` / `RUN_FINISHED` / `RUN_ERROR` — 由桥接层根据 ACP session 状态生成
- `STEP_STARTED` / `STEP_FINISHED` — 需要从 ACP tool_call 边界推断
- `STATE_SNAPSHOT` / `STATE_DELTA` — ACP 无共享状态概念，需要桥接层维护
- `MESSAGES_SNAPSHOT` — 需要桥接层累积消息并定期快照

**优势**：
- 复用官方 ACP 适配器，减少 agent 端维护
- 标准化协议，与编辑器生态兼容
- 保留 AG-UI 前端集成，前端零改动
- MCP 内容类型兼容

**劣势**：
- 每个 agent 需要独立子进程，增加进程管理复杂度
- stdio 通信比直接 SDK 调用多一跳，增加延迟
- ACP session 生命周期与 agework thread/run 生命周期需要映射
- 桥接层事件映射复杂度高（ACP ~6 种 update 类型 vs AG-UI ~30 种事件）
- 子进程崩溃恢复需要额外实现
- 调试链路变长（前端 → AG-UI → Bridge → ACP → Agent SDK）

**适用场景**：需要与 Zed 等编辑器集成，或需要标准化 agent 协议

---

### 4.3 方案 C：完全替换为 ACP，移除 AG-UI

**架构**：

```
Frontend → ACP Client Runtime (新) → stdio → ACP Agent Server
```

**具体变更**：

1. **移除** `packages/adapters/`、`packages/react-ag-ui/`
2. **新增** ACP 客户端 runtime for assistant-ui：直接将 ACP session/update 转换为 `@assistant-ui/core` ThreadMessage
3. **新增** ACP 子进程管理
4. **重构前端**：替换 `useAgUiRuntime()` 为 `useAcpRuntime()`

**优势**：
- 架构最简化，移除一层协议转换
- 直接使用 ACP 的标准化事件模型

**劣势**：
- 需要重写前端 runtime 集成（`@assistant-ui/react-ag-ui` 的全部功能）
- 失去 AG-UI 的中间件系统、状态管理、中断协议
- ACP 的事件类型不足以覆盖 AG-UI 的所有功能（如 STATE_SNAPSHOT/DELTA、ACTIVITY、RUN 步骤管理）
- 无法使用 AG-UI 生态的其他适配器（LangGraph, CrewAI 等）
- ACP 的 session 模型与 assistant-ui 的 thread 模型差异较大
- stdio 传输不适合 Web 应用（浏览器无法直接使用 stdio）

**适用场景**：不推荐。除非 agework 完全放弃 Web 前端，转型为纯编辑器工具。

---

### 4.4 方案 D：混合架构 — ACP 作为可选 agent 后端

**架构**：

```
                        ┌─ Vendor SDK Agent (现有) ──→ Agent 实例
Frontend → AG-UI → Adapter Layer ─┤
                        └─ ACP Agent (新增) ────stdio──→ ACP Agent Server
```

**具体变更**：

1. **保留** 现有适配器不变
2. **新增** `AcpAgentAdapter`：作为第三种 agent 类型，通过 ACP 协议连接外部 agent
3. **新增** AgentType: `"claude" | "codex" | "acp"`
4. Worker 的 `RunRouter` 增加 ACP 路由

**优势**：
- 渐进式迁移，零破坏性变更
- 现有功能不受影响
- 可按需引入 ACP agent（如连接 Zed 配置的 agent）
- 为未来编辑器集成保留可能性

**劣势**：
- 两套并行的 agent 连接方式，增加维护成本
- ACP agent 的功能受限于 ACP 协议能力
- 需要维护 ACP-to-AGUI 桥接层

**适用场景**：需要渐进式引入 ACP 支持，同时保持现有功能稳定

---

### 4.5 方案 E：抽象适配器接口 + 可插拔协议

**架构**：

```
Frontend → AG-UI → AgentAdapter Interface ─┬─ VendorSdkAdapter (现有)
                                           ├─ AcpAdapter (新增)
                                           └─ 未来协议适配器
```

**具体变更**：

1. **定义** `AgentAdapter` 接口，抽象适配器的公共行为
2. **重构** 现有适配器实现该接口
3. **新增** `AcpAdapter` 实现同一接口
4. **Worker** 通过工厂模式创建适配器

**接口设计草案**：

```typescript
interface AgentAdapter {
  type: AgentType;
  
  // 生命周期
  initialize(config: AgentConfig): Promise<void>;
  shutdown(): Promise<void>;
  
  // 执行
  run(input: RunAgentInput): Observable<BaseEvent>;
  interrupt(threadId?: string): Promise<void>;
  
  // 会话管理
  createSession(config: SessionConfig): Promise<SessionHandle>;
  resumeSession(sessionId: string): Promise<SessionHandle>;
  closeSession(sessionId: string): Promise<void>;
}
```

**优势**：
- 清晰的接口边界，便于测试和扩展
- 新增 agent 类型只需实现接口
- 现有代码改动最小（提取接口，不改逻辑）
- 为 ACP、未来协议预留扩展点

**劣势**：
- 接口设计需要覆盖所有 agent 的共性，抽象难度高
- 不同 agent 的能力差异大（如 Claude 的 permission model vs Codex 的 sandbox model）
- 接口过宽失去抽象意义，过窄限制功能

**适用场景**：长期规划，建立可扩展的适配器架构

---

## 5. 技术细节深入

### 5.1 ACP 子进程管理

ACP agent server 作为 stdio 子进程运行，需要处理：

**启动**：
```typescript
import { spawn } from 'child_process';
import { client } from '@agentclientprotocol/sdk';

const agentProcess = spawn('node', ['@agentclientprotocol/claude-agent-acp'], {
  stdio: ['pipe', 'pipe', 'pipe'],  // stdin, stdout for ACP, stderr for logs
});

const acpClient = client();
await acpClient.connect({
  stdin: agentProcess.stdout,
  stdout: agentProcess.stdin,
});
```

**生命周期管理**：
- 进程启动超时检测
- 进程崩溃检测和自动重启
- 优雅关闭（SIGTERM → 等待 → SIGKILL）
- 资源清理（文件描述符、子进程的子进程）

**与现有 Worker 架构的冲突**：
- 现有 Worker 已有进程管理（单次模式的 fork、持久模式的容器）
- ACP 子进程是 Worker 内部的子子进程，增加嵌套层级
- 持久模式下，每个 workspace 可能需要独立的 ACP agent 进程

### 5.2 ACP Session 与 agework Thread/Run 的映射

| agework 概念 | ACP 概念 | 映射关系 |
|---|---|---|
| `Thread` (conversation) | `Session` | 1:1，一个 thread 对应一个 ACP session |
| `Run` (single execution) | `session/prompt` | 1:1，一个 run 对应一次 prompt turn |
| `RunAgentInput.messages` | `session/prompt` message | 需要将 AG-UI Message 转换为 ACP 消息格式 |
| `ThreadHistoryAdapter` | `session/load` + `session/resume` | ACP 支持会话持久化 |
| `Cancel` | `session/cancel` | 直接映射 |

**关键差异**：
- ACP session 是 agent 端管理的，agework thread 是 API 端管理的
- ACP session 的持久化由 agent 实现决定，agework 需要自己的持久化
- ACP 的 `session/list` 返回的是 agent 端的 session 列表，与 agework 的 thread 列表需要同步

### 5.3 权限模型映射

**ACP 权限模型**：
- `session/request_permission` 方法
- 选项：`allow_once`, `allow_always`, `reject_once`, `reject_always`
- 通过 `session/update` 的 `tool_call` 事件携带权限请求

**agework 权限模型**：
- `canUseTool` callback（Claude adapter）
- `pendingQuestions` Map
- 通过 `RuntimeChannel` 发送 `approval_resolved` control

**映射方案**：
```
ACP session/request_permission
  → 桥接层转换为 AG-UI 的 TOOL_CALL_START (with permission metadata)
    → useAgUiRuntime 的 interrupt 机制
      → 用户操作
        → approval_resolved control
          → 桥接层转换为 ACP permission response
```

### 5.4 AG-UI 独有能力（ACP 中无对应）

| AG-UI 能力 | 说明 | ACP 中的替代方案 |
|---|---|---|
| `STATE_SNAPSHOT/DELTA` | Agent 与 UI 共享状态 | 无直接对应，需要桥接层维护 |
| `ACTIVITY_SNAPSHOT/DELTA` | Agent 活动状态展示 | 无直接对应 |
| `STEP_STARTED/FINISHED` | Run 内步骤追踪 | 可从 tool_call 边界推断 |
| `MESSAGES_SNAPSHOT` | 完整消息列表同步 | 需要桥接层累积 |
| 中间件系统 | 事件过滤/转换管道 | 无对应，需自建 |
| `forwardedProps` | 每次运行的自定义属性 | ACP `session/set_config_option` 部分覆盖 |

如果移除 AG-UI，这些能力需要在 ACP runtime 中重新实现。

---

## 6. 风险评估

### 6.1 技术风险

| 风险 | 影响 | 概率 | 缓解措施 |
|---|---|---|---|
| ACP stdio 传输在生产环境的稳定性 | 高 | 中 | 实现进程健康检查和自动重启 |
| ACP session 与 agework thread 状态不一致 | 高 | 中 | 设计明确的状态同步机制 |
| 子进程资源泄漏（fd、内存） | 中 | 中 | 严格的生命周期管理和资源审计 |
| ACP SDK 重大 breaking changes | 中 | 低 | 版本锁定，关注 changelog |
| 桥接层事件映射遗漏 | 中 | 高 | 全面的事件映射测试 |

### 6.2 架构风险

| 风险 | 影响 | 概率 | 缓解措施 |
|---|---|---|---|
| 嵌套进程管理复杂度 | 高 | 高 | 统一进程管理策略 |
| 调试链路变长 | 中 | 高 | 完善日志和 tracing |
| 两套协议并行维护成本 | 中 | 中 (方案 D/E) | 明确的接口边界 |
| ACP 远程传输不成熟 | 高 | 高 | 仅使用 stdio，远程场景等待稳定 |

---

## 7. 建议

### 7.1 短期（当前）：保持现状

**推荐方案 A**。理由：

1. 现有架构已完整实现，适配器代码经过生产验证
2. ACP 的核心收益（标准化、编辑器兼容）当前无明确需求
3. ACP 引入的复杂度（子进程管理、协议桥接）大于收益
4. vendor SDK 直接调用的调试体验优于 JSON-RPC over stdio

### 7.2 中期（条件触发）：方案 D 或 E

如果出现以下条件之一，启动评估：
- 需要与 Zed/VS Code 等编辑器集成
- ACP 远程传输（HTTP/WS）稳定并发布
- MCP 工具生态成为核心需求
- 需要支持第三方 ACP agent

**推荐方案 E**（抽象适配器接口）：
1. 定义 `AgentAdapter` 接口
2. 现有适配器提取实现
3. 新增 `AcpAdapter` 作为可选实现
4. 保持 AG-UI 作为前端协议层

### 7.3 长期：视生态演进

- 如果 ACP 成为行业标准且远程传输成熟，可考虑全面迁移
- 如果 AG-UI 生态壮大（更多框架集成），保持 AG-UI 作为核心协议
- 两者可能长期共存：ACP 负责 agent 通信，AG-UI 负责用户交互

---

## 8. 参考来源

| 来源 | URL | 类型 |
|---|---|---|
| ACP 协议文档 | https://agentclientprotocol.com/get-started/introduction | Primary |
| ACP TypeScript SDK | https://agentclientprotocol.com/libraries/typescript | Primary |
| ACP 协议规范 | https://agentclientprotocol.com/protocol/overview | Primary |
| claude-agent-acp | https://github.com/agentclientprotocol/claude-agent-acp | Primary |
| codex-acp | https://github.com/agentclientprotocol/codex-acp | Primary |
| ACP 传输层 | https://agentclientprotocol.com/protocol/v1/transports | Primary |
| AG-UI 协议定位 | https://docs.ag-ui.com/agentic-protocols | Primary |
| AG-UI 架构 | https://docs.ag-ui.com/concepts/architecture | Primary |
| AG-UI 事件类型 | https://docs.ag-ui.com/concepts/events | Primary |
| AG-UI Agent 概念 | https://docs.ag-ui.com/concepts/agents | Primary |
| OpenHands README | https://github.com/All-Hands-AI/OpenHands | Primary |
| OpenHands Agent Server SDK | https://github.com/OpenHands/software-agent-sdk | Primary (源码) |
| OpenHands ACP Agents 文档 | https://docs.openhands.dev/openhands/usage/agent-canvas/acp-agents | Primary |
| OpenHands Agent Server 概览 | https://docs.openhands.dev/sdk/guides/agent-server/overview | Primary |
| OpenHands 源码 (本地) | `/Users/mew/code/agent-project/software-agent-sdk/` | Primary (源码) |

---

## 附录 A：ACP Session Update → AG-UI 事件映射详表

| ACP session/update | AG-UI Event | 转换逻辑 |
|---|---|---|
| `agent_message_chunk` (start) | `TEXT_MESSAGE_START` | 生成 messageId, role=assistant |
| `agent_message_chunk` (delta) | `TEXT_MESSAGE_CONTENT` | 直接传递 delta text |
| `agent_message_chunk` (end) | `TEXT_MESSAGE_END` | 关闭消息 |
| `tool_call` (pending) | `TOOL_CALL_START` + `TOOL_CALL_ARGS` | 提取 tool name, input |
| `tool_call_update` (in_progress) | `TOOL_CALL_ARGS` (增量) | 传递增量参数 |
| `tool_call_update` (completed) | `TOOL_CALL_END` + `TOOL_CALL_RESULT` | 提取 output |
| `tool_call_update` (failed) | `TOOL_CALL_END` (with error) | 提取 error |
| `agent_thought_chunk` | `REASONING_MESSAGE_*` | 包裹 START/CONTENT/END |
| `plan` | `CUSTOM` (type: plan) | 自定义事件 |
| `usage_update` | `CUSTOM` (type: usage) | 自定义事件 |
| `mode_change` | `CUSTOM` (type: mode) | 自定义事件 |
| (session created) | `RUN_STARTED` | 桥接层在 session/new 成功后生成 |
| (session closed) | `RUN_FINISHED` | 桥接层在 turn 完成后生成 |
| (session error) | `RUN_ERROR` | 桥接层在错误时生成 |

## 附录 B：ACP 子进程生命周期状态机

```
                    ┌──────────┐
                    │  Idle    │
                    └────┬─────┘
                         │ spawn agent process
                         ▼
                    ┌──────────┐
                    │ Starting │──timeout──→ Failed
                    └────┬─────┘
                         │ initialize() 成功
                         ▼
                    ┌──────────┐
                    │  Ready   │◄─────────────┐
                    └────┬─────┘              │
                         │ session/new        │ session/close
                         ▼                    │
                    ┌──────────┐              │
                    │  Active  │──────────────┘
                    └────┬─────┘
                         │ process crash / SIGTERM
                         ▼
                    ┌──────────┐
                    │  Dead    │──restart──→ Starting
                    └──────────┘
```

## 附录 C：方案决策矩阵

| 维度 | 方案 A (现状) | 方案 B (ACP+AGUI) | 方案 C (纯ACP) | 方案 D (混合) | 方案 E (抽象接口) |
|---|---|---|---|---|---|
| 实现成本 | 无 | 高 | 极高 | 中 | 中 |
| 前端改动 | 无 | 无 | 大 | 无 | 无 |
| 后端改动 | 无 | 大 | 大 | 小 | 小 |
| 标准化收益 | 无 | 高 | 高 | 中 | 中 |
| 调试体验 | 优 | 中 | 中 | 优/中 | 优/中 |
| 扩展性 | 中 | 高 | 中 | 高 | 高 |
| 运维复杂度 | 低 | 高 | 高 | 中 | 中 |
| 编辑器兼容 | 否 | 是 | 是 | 部分 | 部分 |
| **推荐度** | **★★★★★** | **★★★☆☆** | **★☆☆☆☆** | **★★★★☆** | **★★★★☆** |
