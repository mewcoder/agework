# AionUi 对 AgeWork 的架构启示

> 从 AionUi 源码中提炼出对 AgeWork（TypeScript + NestJS + Prisma + AG-UI）有借鉴价值的设计。
> AionUi 是一个 Electron 桌面端 AI Agent 工作台，支持 19+ CLI Agent、多 Agent 团队协作、文档生成、定时任务等。
> 按 AgeWork 的实际需求和优先级排列。

---

## 优先级定义

| 级别 | 含义 | 预期收益 |
|------|------|---------|
| **P0** | 核心架构升级，直接影响系统能力 | 高 |
| **P1** | 重要能力补充，显著提升竞争力 | 中高 |
| **P2** | 锦上添花，可在 P0/P1 稳定后推进 | 中 |
| **P3** | 长期愿景，需要前置条件 | 低（短期） |

---

## P0：核心架构升级

### 1. Agent Adapter 统一注册与发现机制

**现状**：AgeWork 目前有 `ClaudeAgentAdapter` 和 `CodexAgentAdapter`，硬编码在 worker 中。新增 agent 需要修改 worker 代码。

**AionUi 做法**：

AionUi 定义了 `DetectedAgentKind` 五种执行引擎类型：

```typescript
// detectedAgent.ts
type DetectedAgentKind = 'acp' | 'remote' | 'aionrs' | 'openclaw-gateway' | 'nanobot';
```

每个 agent 通过 `AgentMetadata` 注册到统一存储：

```typescript
type AgentMetadata = {
  id: string;
  name: string;
  backend?: string;           // 厂商标签，如 "claude"
  agent_type: AgentType;       // 'acp' | 'remote' | 'aionrs' | ...
  agent_source: AgentSource;   // 'internal' | 'builtin' | 'extension' | 'custom'
  enabled: boolean;
  available: boolean;
  command?: string;            // 启动命令
  args?: string[];
  env?: AgentEnvEntry[];
  behavior_policy?: BehaviorPolicy;
  yolo_id?: string;            // 各 agent 自己的"全自动模式" ID
  handshake?: AgentHandshake;  // 缓存的 ACP 初始化响应
};
```

Agent 来源分四层：

| 来源 | 说明 | 示例 |
|------|------|------|
| `internal` | 内置引擎 | aionrs |
| `builtin` | 随应用分发 | claude, codex, gemini |
| `extension` | 扩展市场安装 | 第三方 agent |
| `custom` | 用户自定义 | 通过编辑器添加 |

每个 agent 有自己的"全自动模式" ID 映射：

```typescript
const FULL_AUTO_MODE: Record<string, string> = {
  claude: 'bypassPermissions',
  qwen: 'yolo',
  codex: CODEX_MODE_NATIVE_FULL_ACCESS,
  cursor: 'agent',
  gemini: 'yolo',
  aionrs: 'yolo',
};
```

**建议**：

```typescript
// packages/shared/src/agent-registry.ts
interface AgentAdapterManifest {
  id: string;
  name: string;
  backend: string;
  source: 'builtin' | 'extension' | 'custom';
  enabled: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  yoloModeId?: string;
  behaviorPolicy?: { supportsSideQuestion?: boolean };
}

interface AgentAdapterRegistry {
  register(manifest: AgentAdapterManifest): void;
  resolve(agentId: string): AgentAdapterManifest | null;
  listByBackend(backend: string): AgentAdapterManifest[];
  listEnabled(): AgentAdapterManifest[];
}
```

**收益**：
- 新增 agent 只需注册 manifest，不改 worker 代码
- 支持用户自定义 agent（指定命令、参数、环境变量）
- 为扩展市场打基础

**实施难度**：中

---

### 2. ACP 协议：统一的 Agent 通信接口

**现状**：AgeWork 的 agent adapter 直接调用各 SDK（Claude SDK、Codex SDK），接口不统一。新增 agent 需要实现整个 adapter。

**AionUi 做法**：

AionUi 定义了 ACP（Agent Communication Protocol）作为统一的 agent 通信协议。所有 ACP 类 agent 共享同一个协议接口：

#### 初始化握手

```typescript
// acpTypes.ts
type AcpInitializeResult = {
  protocolVersion: number;
  capabilities: {
    loadSession: boolean;
    promptCapabilities: { image: boolean; audio: boolean; embeddedContext: boolean };
    mcpCapabilities: { stdio: boolean; http: boolean; sse: boolean };
    sessionCapabilities: { fork: Record<string, unknown> | null; resume: ...; list: ...; close: ... };
    _meta: Record<string, unknown>;
  };
  agentInfo: { name: string; version: string; title?: string } | null;
  auth_methods: Array<{ id: string; name: string; description?: string }>;
};
```

#### Session 生命周期

```
initialize → session/new → session/send (循环) → session/close
                          ↕
                    session 通知流 (tool_call, plan, permission)
```

#### 核心事件类型

ACP 协议定义了三种结构化的 session update：

**Tool Call**：
```typescript
interface ToolCallUpdate {
  session_id: string;
  update: {
    sessionUpdate: 'tool_call' | 'tool_call_update';
    tool_call_id: string;
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
    title: string;
    kind: 'read' | 'edit' | 'execute';
    rawInput?: Record<string, unknown>;
    rawOutput?: { saved_path?: string; image?: { path: string; mime_type?: string }; ... };
    content?: Array<{ type: 'content' | 'diff'; content?: { type: 'text'; text: string }; path?: string; ... }>;
    locations?: Array<{ path: string }>;
  };
}
```

**Plan**：
```typescript
interface PlanUpdate {
  session_id: string;
  update: {
    sessionUpdate: 'plan';
    entries: Array<{
      content: string;
      status: 'pending' | 'in_progress' | 'completed';
      priority?: 'low' | 'medium' | 'high';
    }>;
  };
}
```

**Permission Request**：
```typescript
interface AcpPermissionRequest {
  session_id: string;
  options: Array<{
    option_id: string;
    name: string;
    kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
  }>;
  tool_call: {
    tool_call_id: string;
    raw_input?: { command?: string; description?: string; ... };
    title?: string;
    kind?: string;
    content?: ToolCallContentItem[];
  };
}
```

#### 动态配置

Session 创建时 agent 可暴露配置选项：

```typescript
interface AcpSessionConfigOption {
  id: string;
  name?: string;
  type: 'select' | 'boolean' | 'string';
  current_value?: string;
  options?: Array<{ value: string; name?: string; label?: string }>;
}
```

**对 AgeWork 的启示**：

AgeWork 已经使用 AG-UI 协议，但 AG-UI 是更底层的事件流协议。可以参考 ACP 在 AG-UI 之上增加：
1. **能力协商**（initialize 握手）—— agent 告诉平台它支持什么
2. **结构化 tool call**（kind + status 生命周期）—— 比纯文本事件更丰富
3. **动态配置**（session 级 config options）—— 用户可以在运行时调整 agent 行为

**实施难度**：高（需要在 AG-UI 之上定义扩展层）

---

### 3. 多 Agent 事件格式归一化

**现状**：AgeWork 的 AG-UI 事件来自不同 adapter，格式可能不一致。

**AionUi 的教训**：

AionUi 在这个问题上**没有做到完全统一**，而是走了"wire envelope 统一 + 前端归一化"的路线。这是一个值得借鉴但也值得改进的设计。

#### Wire Envelope（统一）

所有 agent 事件都通过同一个 WebSocket 通道 `message.stream` 推送：

```typescript
interface IResponseMessage {
  type: string;        // 消息类型（值不统一！）
  data: unknown;       // 载荷（结构取决于 type）
  msg_id: string;
  turn_id?: string;
  conversation_id: string;
  created_at?: number;
}
```

#### 但 type 和 data 不统一

不同 agent 种类产生不同的 type 值和 data 结构：

| type | 来源 | data 结构 |
|------|------|-----------|
| `tool_group` | aionrs (内置) | `Array<{ name, call_id, status: 'Success'\|'Error'\|'Executing', confirmationDetails, result_display }>` |
| `acp_tool_call` | ACP 类 Agent | `{ session_id, update: { sessionUpdate, tool_call_id, status: 'pending'\|'in_progress'\|'completed'\|'failed', title, kind, rawInput, rawOutput, content } }` |
| `tool_call` | 旧格式 | `{ call_id, name, status, input, output, args, description }` |

三种 tool call 的状态值都不一样：

```
tool_group (aionrs):  'Success' | 'Error' | 'Canceled' | 'Pending' | 'Executing' | 'Confirming'
acp_tool_call (ACP):  'pending' | 'in_progress' | 'completed' | 'failed'
tool_call (旧格式):   'completed' | 'error' | 'running' | undefined
```

#### 前端归一化层

`normalizeToolMessages()` 在渲染层做三合一：

```typescript
// normalizeToolCall.ts
interface NormalizedToolCall {
  key: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'error' | 'canceled';
  description?: string;
  input?: string;
  output?: string;
  truncated?: boolean;
  imagePath?: string;
}

function normalizeToolMessages(messages: ToolMessage[]): NormalizedToolCall[] {
  return messages.flatMap((m) => {
    if (m.type === 'tool_group') return normalizeToolGroup(m);
    if (m.type === 'acp_tool_call') return normalizeAcpToolCall(m);
    if (m.type === 'tool_call') return normalizeToolCall(m);
    return undefined;
  });
}
```

**建议**：

AgeWork 应该**在后端归一化**，而不是学 AionUi 在前端做：

```typescript
// packages/shared/src/events.ts — 统一事件模型
interface UnifiedToolEvent {
  kind: 'tool_call';
  toolCallId: string;
  toolName: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'canceled';
  category: 'read' | 'edit' | 'execute' | 'search' | 'other';
  input?: Record<string, unknown>;
  output?: { text?: string; diff?: { path: string; oldText: string; newText: string }; imagePath?: string };
  locations?: Array<{ path: string }>;
  startedAt?: number;
  completedAt?: number;
}
```

在 `RuntimeEventProcessor.publish()` 层，各 adapter 的原始事件统一转换为此格式后再推送给前端。

**收益**：
- 前端只处理一种格式，代码量减少 60%+
- 新增 agent adapter 不需要前端改动
- 状态机可统一管理

**实施难度**：中

---

### 4. 消息合并引擎（流式场景）

**现状**：AgeWork 的流式消息合并逻辑需要确认是否完善。

**AionUi 做法**：

`composeMessage()` 根据消息类型使用不同的合并策略，处理流式场景：

```typescript
// chatLib.ts
function composeMessage(messages: TMessage[], incoming: TMessage): TMessage[] {
  switch (incoming.type) {
    case 'text':
      // 按 msg_id 匹配最后一条，拼接流式文本块
      return mergeTextMessageContent(messages, incoming);

    case 'tool_call':
      // 按 call_id 匹配，就地更新工具状态
      return mergeById(messages, incoming, 'call_id');

    case 'tool_group':
      // 按 call_id 匹配数组中的工具，就地更新或追加
      return mergeToolGroup(messages, incoming);

    case 'acp_tool_call':
      // 按 tool_call_id 匹配，深度合并
      return mergeAcpToolCall(messages, incoming);

    case 'thinking':
      // 按 msg_id 匹配连续块，拼接文本；done 状态终结
      return mergeThinking(messages, incoming);

    case 'plan':
      // 按 session_id 匹配，覆盖或追加
      return mergePlan(messages, incoming);
  }
}
```

关键优化：`composeMessageWithIndex()` 使用 `WeakMap` 缓存索引，实现 O(1) 查找：

```typescript
// hooks.ts
function composeMessageWithIndex(messages: TMessage[], incoming: TMessage): TMessage[] {
  // 用 WeakMap 缓存 msg_id -> index, call_id -> index, tool_call_id -> index
  // 避免每次 O(n) 扫描
}
```

**建议**：

AgeWork 的 AG-UI 事件流也需要类似的合并引擎，特别是：
- 流式文本拼接（同一个 msg_id 的 chunk 合并）
- Tool call 状态就地更新（避免重复创建新条目）
- Thinking 块的生命周期管理

**实施难度**：中

---

## P1：重要能力补充

### 5. Team Mode：多 Agent 协作编排

**现状**：AgeWork 暂无多 Agent 协作模式。

**AionUi 做法**：

Team Mode 实现了 Leader-Teammate 编排：

```
Leader Agent（任务分解）
  ├── Teammate A（并行执行子任务 1）
  ├── Teammate B（并行执行子任务 2）
  └── Teammate C（并行执行子任务 3）
```

核心类型：

```typescript
// teamTypes.ts
type TeamSlot = {
  slot_id: string;
  role: 'leader' | 'teammate';
  agent_type: string;           // 可以用不同后端的 agent
  conversation_id: string;
  workspace_mode: 'shared' | 'isolated';
};

type ITeamMessageEvent = {
  team_id: string;
  slot_id: string;
  type: string;                 // 与 IResponseMessage 相同的 wire type
  data: unknown;
  msg_id: string;
  conversation_id: string;
};
```

关键设计决策：
- **编排逻辑在后端**，不在 Electron 主进程。Renderer 通过 `/api/teams/*` 和 WebSocket `team.*` 事件通信
- **每个 Teammate 有独立的 conversation**，通过 `slot_id` 关联到 team
- **Workspace 可共享或隔离**（`shared` vs `isolated`）
- **权限传播**：`propagateMode()` 将 session_mode 持久化到 team 记录，新 agent 继承
- **消息归属**：`IMessageText` 增加 `teammateMessage`、`senderName`、`senderAgentType`、`senderConversationId` 字段

UI 层提供：
- Team 创建对话框（选择 Leader + 添加 Teammate）
- Tab 切换（Leader 始终第一个，Teammate 可拖拽排序）
- 每个 slot 的权限确认计数徽章
- Sidebar 的 team 列表和状态

**建议**：

AgeWork 的 Workspace 已经是多 conversation 的容器，天然适合扩展为 team 模式：
1. 在 Workspace 上增加 `team_config`（leader slot + teammate slots）
2. 每个 slot 关联一个 conversation + agent adapter
3. `RuntimeEventProcessor` 增加 team 级事件路由
4. 前端增加 team 编排 UI

**实施难度**：高

---

### 6. Skill / 插件系统

**现状**：AgeWork 暂无 skill 系统。

**AionUi 做法**：

四层 Skill 来源：

| 层级 | source 值 | 来源 | 用户操作 |
|------|-----------|------|----------|
| 内置自动注入 | `builtin` (auto-inject/) | 随应用分发 | 始终启用，不可关闭 |
| 内置可选 | `builtin` (其他路径) | 随应用分发 | 可启用/禁用 |
| 用户自定义 | `custom` | 用户导入（文件夹、zip、拖拽） | 完整 CRUD |
| 扩展贡献 | `extension` | 扩展市场安装 | 只读，通过扩展生命周期管理 |
| Cron 生成 | `cron` | AI 在定时任务中建议 | 隐藏在"My Skills"之外 |

Skill 本身是 Markdown 文件（`SKILL.md`），YAML frontmatter 包含 `name` 和 `description`，body 是给 AI agent 的指令。

每个 Assistant 持有三个 skill 数组：

```typescript
type Assistant = {
  // ...
  enabled_skills: string[];           // 启用的 skill
  custom_skill_names: string[];       // 用户添加的自定义 skill
  disabled_builtin_skills: string[];  // 用户关闭的内置 skill
};
```

AI 可以在对话中建议新 skill，通过 `[SKILL_SUGGEST]...[/SKILL_SUGGEST]` 标记块，UI 渲染为保存/忽略卡片。

扩展通过 `contributes/skills.json` 声明 skill：

```json
[
  { "name": "hello-quick-summary", "description": "...", "file": "skills/quick-summary.md" }
]
```

**建议**：

AgeWork 可以设计类似的 skill 系统，但更适合 web 场景：
1. Skill 存储在数据库（而非文件系统），支持多用户共享
2. 通过 API 端点管理 CRUD
3. Workspace 级别的 skill 绑定（而非 Assistant 级别）
4. Skill marketplace 作为未来的扩展方向

**实施难度**：中

---

### 7. 定时任务系统（Cron）

**现状**：AgeWork 暂无定时任务。

**AionUi 做法**：

三种调度模式：

```typescript
type ICronSchedule =
  | { kind: 'at'; atMs: number; description: string }           // 一次性
  | { kind: 'every'; everyMs: number; description: string }     // 固定间隔
  | { kind: 'cron'; expr: string; tz?: string; description: string } // 标准 cron 表达式
```

Job 完整结构：

```typescript
interface ICronJob {
  id: string;
  name: string;
  description: string;
  enabled: boolean;                    // 暂停/恢复
  schedule: ICronSchedule;
  payload: string;                     // 消息文本
  execution_mode: 'existing' | 'new_conversation';  // 发送到已有对话 or 新建
  conversation_id: string;
  agent_type: string;
  created_by: 'user' | 'agent';       // 用户创建 or AI 建议
  agent_config: ICronAgentConfigWrite; // 指定用哪个 assistant/model
  next_run_at_ms: number;
  last_run_at_ms: number;
  last_status: 'ok' | 'error' | 'skipped' | 'missed';
  run_count: number;
  retry_count: number;
  max_retries: number;
}
```

每个 Job 可附带独立的 Skill（`SKILL.md`），在执行时注入给 agent。

四种 React Hook 管理状态：
- `useCronJobs(conversation_id)` — 单对话范围
- `useAllCronJobs()` — 全局范围
- `useCronJobsMap()` — 按对话分组，支持 sidebar 展示
- `useCronJobConversations(job_id)` — 获取 job 生成的对话列表

**建议**：

定时任务对 AgeWork 的团队场景很有价值（定期报告、自动检查等）。建议：
1. 后端用 `node-cron` 或数据库驱动的调度器
2. Job 绑定到 Workspace（而非单个 conversation）
3. 支持 `execution_mode: 'new_conversation'`，每次执行生成独立 conversation
4. 前端增加 Job 管理页面

**实施难度**：中

---

### 8. Agent 生命周期管理

**现状**：AgeWork 的 agent 生命周期由 worker 管理，但 warmup/reconnect 等细节需要完善。

**AionUi 做法**：

#### Warmup（预热）

```typescript
// warmupConversation.ts
async function warmupConversation(conversationId: string) {
  // 1. 合并并发 warmup 请求（同一 conversation 只 warmup 一次）
  // 2. POST /api/conversations/{id}/warmup
  // 3. 状态: idle → preparing → ready | error
}
```

#### 连接状态追踪

```typescript
// useAcpMessage.ts
type AcpStatus = 'connecting' | 'connected' | 'authenticated' | 'session_active'
               | 'disconnected' | 'error';

// 状态转换:
// connecting → connected → authenticated → session_active (成功)
// connecting → disconnected / error (失败)
```

#### Turn 生命周期

```
start → (thought | text | tool_call | plan)* → finish
                                                  ↓
                                            重置所有状态
```

#### WebSocket 重连

```typescript
// browser.ts — 指数退避，最大 8 秒
const scheduleReconnect = () => {
  reconnectDelay = Math.min(reconnectDelay * 2, 8000);
  setTimeout(connect, reconnectDelay);
};
```

#### 断连错误处理

```typescript
// buildSendFailureError.ts
function isAgentDisconnectedError(error: unknown): boolean {
  return error.backendMessage.includes('acp protocol is not connected');
  // → 产生 USER_AGENT_DISCONNECTED 错误，retryable: true
}
```

**建议**：

AgeWork 应该完善：
1. Agent warmup 机制（预连接、预认证）
2. 连接状态机（connecting → connected → ready → error）
3. 指数退避重连
4. 用户友好的断连错误提示（带重试按钮）

**实施难度**：低-中

---

## P2：锦上添花

### 9. Preview Panel（文件预览）

**现状**：AgeWork 暂无文件预览面板。

**AionUi 做法**：

支持 10 种内容类型的预览和编辑：

| 类型 | 渲染技术 | 可编辑 |
|------|----------|--------|
| Markdown | Streamdown + remark/rehype + KaTeX + Shiki | ✅ 分屏编辑+预览 |
| Diff | diff2html（side-by-side / unified） | ❌ |
| Code | CodeMirror 6 | ✅ |
| PDF | Electron webview + file:// URL | ❌ |
| PPT/Word/Excel | OfficeCLI 本地服务器 + webview | ❌ |
| Image | Arco Image 组件 + base64 | ❌ |
| HTML | iframe + inspect mode | ✅ 分屏 |
| URL | WebviewHost 内置浏览器 | ❌ |

关键特性：
- **实时更新**：订阅 `fileStream.contentUpdate`，agent 写文件时自动刷新（500ms debounce）
- **外部变更检测**：每 1 秒轮询活跃 tab 的文件 mtime
- **Git 版本历史**：`usePreviewHistory` hook 支持快照列表、保存、恢复
- **分屏编辑**：Markdown 和 HTML 支持编辑器+预览并排，带滚动同步
- **大文件处理**：120K 字符以上禁用预览，30K 以上禁用语法高亮
- **Tab 持久化**：文本类型 tab 存 localStorage（内容上限 80K 字符）

**建议**：

AgeWork 作为 web 应用，可以实现轻量版：
1. Markdown 预览（react-markdown + 代码高亮）
2. Code 预览（Monaco Editor 或 CodeMirror）
3. Diff 预览（diff2html）
4. Image 预览
5. 通过 WebSocket 接收 agent 的文件变更事件，实时刷新

**实施难度**：中-高

---

### 10. IPC/传输抽象层

**现状**：AgeWork 已有 `IpcTransport`（本地）和 `HttpTransport`（Docker），设计合理。

**AionUi 做法**：

AionUi 有三层传输抽象：

1. **Main-process bridge**（`main.ts`）：序列化事件 → `webContents.send()` 广播到所有窗口 + WebSocket 客户端，50MB 载荷保护
2. **Browser bridge**（`browser.ts`）：Electron 用 `win.electronAPI` IPC；Web 用 WebSocket + 指数退避重连（最大 8 秒）
3. **HTTP bridge**（`httpBridge.ts`）：REST 工厂函数（`httpGet`, `httpPost`...）+ WebSocket 事件，base URL 自动解析

**可借鉴点**：
- **载荷保护**：50MB 上限防止大消息阻塞 IPC
- **双模 bridge**：同一套 API 在 Electron 和 Web 模式下都能工作
- **WebSocket 心跳**：ping/pong + auth 过期处理

**建议**：

AgeWork 的传输层已经比 AionUi 更清晰（Provider → Transport → Adapter 分层）。可参考增加：
- 载荷大小保护
- WebSocket 心跳和重连
- 传输层健康检查

**实施难度**：低

---

### 11. 文档生成能力

**现状**：AgeWork 暂无文档生成。

**AionUi 做法**：

AionUi 通过 OfficeCLI 集成实现了专业级文档生成：
- PPTX（含 Morph 动画转场）
- DOCX
- XLSX
- PDF

但这是**桌面端强耦合**的能力——依赖本地文件系统访问和 OfficeCLI 进程。

**建议**：

AgeWork 作为 web-first 应用，应该走服务端渲染路线：
1. `docx` npm 包生成 Word
2. `pptxgenjs` 生成 PPT
3. `xlsx` npm 包生成 Excel
4. Puppeteer/Playwright 生成 PDF

这些都可以在 worker 中运行，不需要桌面文件系统。

**实施难度**：中

---

### 12. 权限确认流程

**现状**：AgeWork 有基础的权限确认，但需要完善。

**AionUi 做法**：

ACP 协议定义了结构化的权限请求：

```typescript
interface AcpPermissionRequest {
  session_id: string;
  options: Array<{
    option_id: string;
    name: string;
    kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
  }>;
  tool_call: {
    tool_call_id: string;
    raw_input?: { command?: string; description?: string };
    title?: string;
    kind?: string;  // 'read' | 'edit' | 'execute'
  };
}
```

关键设计：
- **四种操作**：允许一次、始终允许、拒绝一次、始终拒绝
- **附带上下文**：权限请求包含 tool_call 详情（命令、文件路径等）
- **记忆机制**：`ApprovalStore` 记住"始终允许"的决策，避免重复确认
- **Team 模式传播**：`propagateMode()` 将权限模式持久化到 team 记录

**建议**：

AgeWork 可参考增加：
- "始终允许"记忆（按 tool 类型 + agent 维度）
- 权限请求附带完整上下文（不只是"是否允许"，还要展示具体操作）
- Team/Workspace 级别的权限策略

**实施难度**：低-中

---

## P3：长期愿景

### 13. 扩展市场（Hub）

**AionUi 做法**：

扩展通过 `HubContributes` 声明能力：

```typescript
type HubContributes = {
  acpAdapters?: string[];   // 贡献 agent adapter
  skills?: string[];        // 贡献 skill
  // ... 其他类型
};
```

扩展安装流程：Hub 列表 → 安装 → 启用 → 贡献的 adapter/skill 自动注册。

**建议**：作为 AgeWork 的长期方向，但需要先完成 adapter 注册和 skill 系统。

**实施难度**：高

---

### 14. 桌面宠物 / 个性化

AionUi 有桌面宠物功能（独立窗口、preload 脚本、设置页面）。这是纯桌面端的娱乐功能，对 AgeWork 的团队/企业定位参考价值有限。

---

## AgeWork 已有的优势（无需参考 AionUi）

| 能力 | AgeWork | AionUi |
|------|---------|--------|
| **执行沙箱** | ✅ Docker 容器隔离 | ❌ 无真正沙箱 |
| **多用户支持** | ✅ JWT 鉴权 + 团队 | ❌ 单用户桌面 |
| **数据持久化** | ✅ Prisma (SQLite/PG) | ⚠️ SQLite 单文件 |
| **事件协议** | ✅ AG-UI（标准协议） | ⚠️ 自定义 IResponseMessage |
| **传输层抽象** | ✅ Provider → Transport 分离 | ⚠️ 三层 bridge 较复杂 |
| **API-first** | ✅ REST API + SSE | ❌ Electron IPC 为主 |

---

## 实施路线图

```
Phase 1（1-2 月）：P0 核心架构
├── 1.1 Agent Adapter 注册表
├── 1.2 后端事件归一化（统一 tool call 格式）
└── 1.3 消息合并引擎

Phase 2（2-4 月）：P1 能力补充
├── 2.1 Agent 生命周期管理（warmup、重连、状态机）
├── 2.2 权限确认流程增强
└── 2.3 定时任务系统

Phase 3（4-6 月）：P1 + P2
├── 3.1 Team Mode（多 Agent 协作）
├── 3.2 Skill 系统
└── 3.3 Preview Panel（文件预览）

Phase 4（6+ 月）：P2 + P3
├── 4.1 文档生成
├── 4.2 ACP 协议扩展层
└── 4.3 扩展市场
```

---

## 一句话总结

> **AionUi 最值得借鉴的三点：（1）统一的 Agent 注册与发现机制，（2）结构化的 ACP 通信协议（能力协商 + 生命周期 + 动态配置），（3）前端消息归一化管线。**
>
> **但 AgeWork 应该在后端做归一化（而非学 AionUi 在前端做），并利用已有的 Docker 沙箱和 AG-UI 协议作为基础。**
>
> **AionUi 最大的教训：wire format 统一但 type/data 不统一，导致前端需要维护三套 tool call 解析逻辑——这是 AgeWork 应该避免的。**
