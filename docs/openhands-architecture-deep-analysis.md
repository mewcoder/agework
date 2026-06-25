# OpenHands 架构深度分析（源码层）

> 基于 `../agent-project/OpenHands/`、`../agent-project/software-agent-sdk/`、`../agent-project/agent-canvas/` 真实源码 + 5 份分析文档（`openhands-core-4.md` / `openhands-sdk-blueprint.md` / `openhands-event-mechanism-deep.md` / `openhands-database-design.md` / `openhands-sdk-note.md`）。
>
> 目标：理解 OpenHands 作为"agent 平台"的设计，对照 AgeWork 找出可借鉴的具体设计。

---

## 0. 全景：四层金字塔

```
┌──────────────────────────────────────────────────────────────────────┐
│  L4 enterprise  (PostgreSQL · 44 张表 · 多租户 SaaS)                 │
│      /Users/.../agent-project/OpenHands/enterprise/                  │
│  → 用户/组织/计费/集成/审计/feedback                                  │
├──────────────────────────────────────────────────────────────────────┤
│  L3 app_server  (SQLite/PostgreSQL · 6 张核心表)                     │
│      /Users/.../agent-project/OpenHands/openhands/app_server/        │
│  → 会话元数据、sandbox 注册、event_callback、pending_messages        │
├──────────────────────────────────────────────────────────────────────┤
│  L2 agent_server (FastAPI + WebSocket · 文件版 persistence)          │
│      .../software-agent-sdk/openhands-agent-server/openhands/        │
│  → 真正的运行时：HTTP/WS 入口 + EventService + ConversationService   │
│  → 把 SDK 暴露成网络服务                                              │
├──────────────────────────────────────────────────────────────────────┤
│  L1 SDK         (纯 Python 库 · 零 IO)                              │
│      .../openhands-sdk/openhands/sdk/                                │
│  → Event / State / Conversation 主循环 / Agent 接口 / Tool / Hook    │
└──────────────────────────────────────────────────────────────────────┘
```

**L1 是系统本体**（"agent 平台"），L2 是入口（"网络壳"），L3/L4 是元数据/多租户管理。L2/L3/L4 都可以被换掉而不影响 L1。

---

## 1. SDK 域模型：4 个原语（最重要）

```
State (持 FIFOLock)
├── execution_status: 8 态 (IDLE/RUNNING/PAUSED/WAITING_FOR_CONFIRMATION/FINISHED/ERROR/STUCK/DELETING)
├── agent: AgentBase ─────────┐
├── workspace: BaseWorkspace  │  (实现见 L2 workspace 包)
└── events: EventLog ─────┐   │
       ↑                  │   │
       │ append (frozen)   │   │
       │                  │   │
   Event  ────────────────┘   │
   (id, ts, source, kind)     │
       │                       │
       │ step()                │
       ▼                       │
   AgentBase.step(state) ─────┘
        │  平台只调 step()，agent 决定干什么
        ▼
   AgentStepResult(events=[...])
```

**4 个原语**（缺一不可）：

| # | 概念 | 类 | 文件 | 关键点 |
|---|---|---|---|---|
| 1 | **Event** | `class Event(DiscriminatedUnionMixin, ABC)` | `event/base.py` | `frozen=True` + `kind` discriminator + `extra="forbid"`；序列化带 `kind` → 反序列化按 `kind` 路由到具体子类 |
| 2 | **State** | `class ConversationState(OpenHandsModel)` | `conversation/state.py:82` | 8 态枚举；`events: EventLog` 是真源；其他字段是 events replay 出的快照 |
| 3 | **Conversation** | `class LocalConversation` | `conversation/impl/local_conversation.py` | 持 FIFOLock + 跑主循环：`while status==RUNNING: agent.step(state) → 写 events → 状态转移` |
| 4 | **Agent** | `class AgentBase` | `agent/base.py` | 接口只有 `step(state) → AgentStepResult`；**平台对 agent 实现一无所知** |

**AgeWork 同与异**：

| OpenHands 概念 | agework 现状 | 评价 |
|---|---|---|
| Event append-only log | `RunEvent` 表（seq + source + level + payload） | ✅ 已有 |
| State 状态机 | `Run.status`（queued→preparing→running→requires_action→…→finished/error/cancelled） | ✅ 已有 |
| 主循环 | `RuntimeRunner` + `RuntimeEventProcessor` | ✅ 平台不跑 agent 循环（ACP 风格） |
| Agent step | `AbstractAgent.run(input) → Observable<AG-UI Event>` | ✅ 流式版，**不要倒退回 step** |
| Workspace 抽象 | `RuntimeProvider`（local / sandbox） | ✅ 等价 |

**关键结论**：agework 本质上**已经是 OpenHands 的 ACP 路径**。但缺了 OpenHands 在 ACP 之上的横切能力（错误分类、stuck 检测、webhook、metadata 富化、pending messages、condenser 等）。

---

## 2. Event 系统：三路分离

```
agent.step() 产出
  ActionEvent 等
       │
       ├── A. 持久化通路（durable）
       │     EventLog.append(event) ──── 每个事件一个 JSON 文件
       │                                  append-only + flock
       │                                  id↔idx 双向索引
       │
       ├── B. 广播通路（transient）
       │     on_event callback chain ──── visualizer
       │                                  user callbacks
       │                                  default: state.events.append
       │
       └── C. 流式通路（ephemeral）
             on_token / StreamingDelta ── PubSub
                                            不落 EventLog
```

### 2.1 Event 基类

```python
class Event(DiscriminatedUnionMixin, ABC):
    model_config = ConfigDict(extra="forbid", frozen=True)
    id: EventID            # uuid4
    timestamp: str         # ISO
    source: SourceType     # "agent" | "user" | "environment" | "hook"
```

- `frozen=True` + `extra="forbid"` = 事件一旦产生即不可变事实
- `kind` 字段 = `__class__.__name__`（自动加），反序列化按 `kind` 路由
- 缓存 `_get_checked_concrete_subclasses` 减少 ~47% per-step CPU

### 2.2 18 个事件类型

| 组 | 事件 |
|---|---|
| LLMConvertible（6，进 LLM context） | `MessageEvent`, `ActionEvent`, `ObservationEvent`, `AgentErrorEvent`, `UserRejectObservation`, `SystemPromptEvent` |
| ACP 专用（1） | `ACPToolCallEvent` — 不回灌 LLM |
| 用户控制（2） | `PauseEvent`, `InterruptEvent` |
| 终态/错误（1） | `ConversationErrorEvent` — 会话级，不回灌 LLM |
| 运行时/可观测（8） | `StreamingDeltaEvent`（不持久化）, `TokenEvent`, `CondensationRequest/Summary`, `ConversationStateUpdateEvent`, `HookExecutionEvent`, `LLMCompletionLogEvent` |

### 2.3 EventLog：append-only + 跨进程 flock

```python
def append(self, event):
    with self._fs.lock(self._lock_path, timeout=30):  # flock
        disk_length = self._count_events_on_disk()     # 防止别进程写了
        if disk_length > self._length:
            self._sync_from_disk(disk_length)          # 同步
        if evt_id in self._id_to_idx:
            raise ValueError(f"Event with ID '{evt_id}' already exists")
        self._fs.write(target_path, payload)
        self._idx_to_id[self._length] = evt_id
        self._length += 1
```

物理布局：`persistence_dir/<conversation_id>/events/event-{idx:06d}-{event_id}.json`（**每事件一文件**，不是大 JSONL）。

**三重保护**：
1. flock（跨进程）
2. 写前重数（防锁等待期间被写）
3. id 去重（同事件绝不写两次）

### 2.4 Action / Observation 配对

`ActionEvent.tool_call_id == ObservationEvent.tool_call_id` + `ObservationEvent.action_id == ActionEvent.id`。

**关键不变量**：中断时 `_emit_orphaned_action_errors` 给没配对的 Action 补发 `AgentErrorEvent`（不补 LLM history 会损坏）。

### 2.5 StreamingDelta 不入库

```python
class StreamingDeltaEvent(Event):
    """Transient LLM token delta for real-time WebSocket delivery.
    Not persisted to the conversation event log: these events are published
    directly to PubSub, bypassing the callback chain that writes to
    ConversationState.events."""
```

明确决策：delta 是 UX 抖动，不入历史。重连只看聚合后的 `MessageEvent`。

**AgeWork 差异**：agework 把 `TEXT_MESSAGE_CONTENT` delta 也写 `RunEvent` 表。用 `MESSAGES_SNAPSHOT` 解决重连（本质是 checkpoint 思路）。

---

## 3. Conversation 主循环 + FIFOLock

```python
def run(self):
    with self._state:                       # FIFOLock 持锁
        self._state.execution_status = RUNNING
        while self._state.execution_status == RUNNING:
            # 1. pause / stuck / finished 检查
            if status in [PAUSED, STUCK]: break
            if status == FINISHED:
                # stop hook 可以否决 finished，注入 feedback 让它继续
                if hook_processor and not hook_processor.run_stop(...):
                    status = RUNNING; continue
                break
            # 2. stuck 检测
            if stuck_detector.is_stuck(): status = STUCK; continue
            # 3. 调 agent.step —— 事件在这里产生
            self.agent.step(self, on_event=self._on_event, on_token=self._on_token)
            # 4. WAITING_FOR_CONFIRMATION → 退出等用户
            if status == WAITING_FOR_CONFIRMATION: break
            # 5. budget 上限
            if budget_exceeded: emit ConversationErrorEvent; break
            # 6. 迭代上限
            if iteration >= max_iteration_per_run:
                emit ConversationErrorEvent(code="MaxIterationsReached"); break
```

**ACP 路径特殊处理**（`arun`）：ACPAgent 的 step 是远端 prompt round-trip，可能好几分钟。**step 期间释放 state 锁**（`_on_event_with_state_lock` 临时拿锁）— 让用户能插队发消息。

**ACP 一次 step = 一次远端 turn**（`agent/acp_agent.py` 伪码）：

```python
class ACPAgent(AgentBase):
    def step(self, state):
        prompt = self._build_prompt(state.events)
        response = await self._conn.session_prompt(prompt)   # stdio JSON-RPC
        events = [self._translate(u) for u in self._bridge.accumulated_updates]
        events.append(FinishAction(...))  # 必须 emit 标记 turn 结束
        return AgentStepResult(events=events)
```

---

## 4. Agent 协议：stdin/stdout + JSON-RPC

```
OpenHands SDK                    ACP server（远端进程）
┌──────────────┐                 ┌──────────────┐
│ ACPAgent     │ ──spawn──▶      │ claude-code  │
│              │                 │ -acp         │
│              │ ◀─stdio+JSON-RPC─┤              │
│              │                 │  - 自己的 LLM │
│              │                 │  - 自己的工具│
│              │                 │  - 自己的循环│
└──────────────┘                 └──────────────┘
```

协议时序：
1. `spawn claude-code-acp / codex-acp / gemini-cli --acp`
2. `initialize`（握手 + auth methods）
3. `authenticate`（注入凭据）
4. `session/new`（或 `session/load` 恢复）
5. `session/prompt(messages)` →
   - session_update 通知流：`AgentMessageChunk` / `AgentThoughtChunk` / `ToolCallStart` / `ToolCallProgress` / `UsageUpdate`
   - `PromptResponse` 返回
6. 把累积内容转成 OpenHands Event 写入 state

**ACPAgent 翻译 ACP 通知 → OpenHands Event**（`acp_agent.py:on_event`）：
- `AgentThoughtChunk` → 累积思考
- `ToolCallStart` → `ACPToolCallEvent`
- `ToolCallProgress` → 更新
- `AgentMessageChunk` → 累积文本
- `UsageUpdate` → token 统计

**ACP 错误分类**（文档 §6.4）：

| 错误 | 含义 | 客户端动作 |
|---|---|---|
| `ACPAuthRequired` | 凭据失败 | 弹重认证 |
| `ACPSpawnError` | CLI 没装 | 提示安装 |
| `ACPInitError` | 握手失败 | 重试 |
| `UsagePolicyRefusal` | 内容政策拒绝 | 不可重试 |
| `ACPPromptError` | 其他 | 报失败 |

ACP server 把 401/403 折叠成 `-32603`，**客户端必须扫错误消息**识别认证失败。

---

## 5. agent-server：把 SDK 暴露成 HTTP/WS

`software-agent-sdk/openhands-agent-server/openhands/agent_server/`

### 5.1 架构

```
FastAPI app
├── /conversations         POST start / GET search / GET {id} / DELETE {id}
├── /conversations/{id}/events  GET search / POST send_message
├── /conversations/{id}/events/socket  WebSocket
├── /workspaces, /git, /bash, /files, /tools, /skills, /mcp, ...
└── PubSub[Event]           ← 一个 EventService 一份订阅
```

### 5.2 EventService — 单个会话的服务端表示

`agent_server/event_service.py:71`（1500+ 行）：

```python
@dataclass
class EventService:
    stored: StoredConversation
    _conversation: LocalConversation | None       # 持 SDK 会话
    _pub_sub: PubSub[Event] = PubSub(max_subscribers=50)  # 订阅中枢
    _run_task: asyncio.Task | None
    _lease: ConversationLease | None
    _lease_generation: int | None
    ...
    
    async def subscribe_to_events(self, subscriber: Subscriber[Event]) -> UUID:
        subscriber_id = self._pub_sub.subscribe(subscriber)
        if self._conversation:
            # 立即推一次 state snapshot（限 0.5s 超时，避免 WS 拥塞阻塞）
            state_update_event = await self._create_state_update_event()
            await asyncio.wait_for(subscriber(state_update_event),
                                   timeout=0.5)
        return subscriber_id
```

### 5.3 PubSub（关键抽象）

`pub_sub.py`：

```python
@dataclass
class PubSub[T]:
    _subscribers: dict[UUID, Subscriber[T]]
    max_subscribers: int | None
    
    async def __call__(self, event: T) -> None:
        """并发通知所有订阅者；单订阅者慢不阻塞其他"""
        subscribers = list(self._subscribers.items())
        async def _notify(sid, sub):
            try: await sub(event)
            except Exception as e: logger.error(...)
        await asyncio.gather(*[_notify(sid, sub) for sid, sub in subscribers])
```

### 5.4 WebSocket 路径

`sockets.py:189 events_socket`：

```python
async def events_socket(conversation_id, websocket, session_api_key, 
                        resend_mode, after_timestamp, resend_all):
    if not await _accept_authenticated_websocket(websocket, session_api_key): return
    event_service = await conversation_service.get_event_service(conversation_id)
    if event_service is None: close(4004, "Conversation not found"); return
    
    subscriber_id = await event_service.subscribe_to_events(
        _WebSocketSubscriber(websocket)        # 把 WS 包装成 Subscriber
    )
    
    # 补发历史（'all' / 'since'）
    if effective_mode == "all":
        async for event in page_iterator(event_service.search_events):
            await _send_event(event, websocket)
    
    # 之后阻塞接收客户端消息（用于发 user_message / pause / interrupt）
    while True:
        data = await websocket.receive_json()
        if _is_auth_control_message(data): continue
        ...

@dataclass
class _WebSocketSubscriber(Subscriber):
    websocket: WebSocket
    async def __call__(self, event: Event):
        await _send_event(event, self.websocket)
```

### 5.5 ConversationLease — 跨实例 ownership

`conversation_lease.py`（OpenHands 多实例部署的关键）：

```python
class ConversationLease:
    """通过 owner_lease.json 文件 + FileLock 协调多实例 ownership。"""
    def claim(self) -> LeaseClaim:
        # FileLock + 读 payload
        # 1. 没人认领 → generation=1, takeover=False
        # 2. 同实例 → generation 不变
        # 3. 不同实例 + 未过期 + owner 还活着 → 抛 ConversationLeaseHeldError
        # 4. 不同实例 + owner 死了 → takeover, generation+1
    
    def renew(self, generation): ...   # 后台 15s 续约
    def guarded_write(self, generation): ...  # 写 meta.json 时验证 ownership
    def release(self, generation): ...
```

**配合：dead owner 检测**（`_owner_is_dead`）：lease 里记 `owner_host` + `owner_pid`，同主机下用 `os.kill(pid, 0)` 探活，死了就 takeover。**NFS 上 flock 不可靠，文档直说**。

### 5.6 ConversationService 启动

`conversation_service.py:659 _start_conversation`：

```python
async def _start_conversation(self, request: StartConversationRequest):
    conversation_id = request.conversation_id or uuid4()
    # 1. 查/复用 EventService
    existing = self._event_services.get(conversation_id)
    if existing and existing.is_open(): return ...compose..., False
    
    # 2. profile 解析（async → to_thread）
    if request.agent_profile_id is not None:
        resolved_agent, launched_profile = await asyncio.to_thread(
            _resolve_agent_from_profile, request.agent_profile_id, self.cipher, mcp_config
        )
        request = request.model_copy(update={"agent": resolved_agent})
    
    # 3. worktree 准备（git worktree per conversation）
    request = _prepare_request_workspace(request, conversation_id)
    
    # 4. 动态注册 client tools
    if request.tool_module_qualnames:
        for tool_name, mod in request.tool_module_qualnames.items():
            importlib.import_module(mod)   # 触发 tool 自注册
    if request.client_tools:
        new_tools = register_client_tools(request.client_tools)
        request.agent = request.agent.model_copy(update={"tools": [...request.agent.tools, ...new_tools]})
    
    # 5. 持久化
    request_data = request.model_dump(mode="json", context={"expose_secrets": True})
    stored = StoredConversation(id=conversation_id, **request_data)
    
    # 6. 启动 EventService（关键！）
    event_service = await self._start_event_service(stored)
    
    # 7. 投递 initial_message
    if initial_message:
        message = Message(role=initial_message.role, content=initial_message.content)
        await event_service.send_message(message, True)
    
    # 8. 通知 webhook
    await self._notify_conversation_webhooks(_compose_webhook_conversation_info(...))
    
    return conversation_info, True
```

---

## 6. app_server：会话元数据 + Webhook 入口

`OpenHands/openhands/app_server/`（SAAS 元数据层）

### 6.1 Sandbox 管理

`sandbox/sandbox_service.py:30`（抽象基类），`sandbox/docker_sandbox_service.py:83`（Docker 实现）：

```python
class SandboxStatus(Enum):
    STARTING = 'STARTING'
    RUNNING = 'RUNNING'
    PAUSED = 'PAUSED'
    ERROR = 'ERROR'
    MISSING = 'MISSING'

class SandboxInfo(BaseModel):
    id: str
    created_by_user_id: str | None
    sandbox_spec_id: str
    status: SandboxStatus
    session_api_key: str | None           # 关键鉴权
    exposed_urls: list[ExposedUrl] | None  # 暴露的 URL（VSCode/Worker 等）
    created_at: datetime

class DockerSandboxService(SandboxService):
    """Sandbox service built on docker. The Docker API does not currently 
    support async operations, so some of these operations will block."""
    sandbox_spec_service: SandboxSpecService
    container_name_prefix: str
    host_port: int
    container_url_pattern: str
    mounts: list[VolumeMount]
    exposed_ports: list[ExposedPort]    # AGENT_SERVER / VSCODE / WORKER_1 / WORKER_2
    health_check_path: str | None
    httpx_client: httpx.AsyncClient
    max_num_sandboxes: int
    
    def _find_unused_port(self) -> int: ...   # 找主机空闲端口
    def _docker_status_to_sandbox_status(self, docker_status) -> SandboxStatus: ...
    async def _container_to_sandbox_info(self, container) -> SandboxInfo | None: ...
```

**关键模型字段**：
- `session_api_key`：agent-server 鉴权用 `X-Session-API-Key` header
- `exposed_urls`：含 `AGENT_SERVER`（标准名）— 用来定位 runtime 入口
- `exposed_ports` 标准名：`AGENT_SERVER`, `VSCODE`, `WORKER_1`, `WORKER_2`

**等待 sandbox 起来**（`sandbox_service.py:93`）：
```python
async def wait_for_sandbox_running(self, sandbox_id, timeout=120, 
                                   poll_interval=2, httpx_client=None):
    while time.time() - start <= timeout:
        sandbox = await self.get_sandbox(sandbox_id)
        if sandbox.status == ERROR: raise SandboxError(...)
        if sandbox.status == RUNNING:
            if httpx_client and sandbox.exposed_urls:
                if await self._check_agent_server_alive(sandbox, httpx_client):
                    return sandbox
            else: return sandbox
        await asyncio.sleep(poll_interval)
```

### 6.2 AppConversation 启动（异步任务模型）

`app_conversation/app_conversation_models.py:262`：

```python
class AppConversationStartTaskStatus(Enum):
    WORKING = 'WORKING'
    WAITING_FOR_SANDBOX = 'WAITING_FOR_SANDBOX'
    PREPARING_REPOSITORY = 'PREPARING_REPOSITORY'
    RUNNING_SETUP_SCRIPT = 'RUNNING_SETUP_SCRIPT'
    SETTING_UP_GIT_HOOKS = 'SETTING_UP_GIT_HOOKS'
    SETTING_UP_SKILLS = 'SETTING_UP_SKILLS'
    STARTING_CONVERSATION = 'STARTING_CONVERSATION'
    READY = 'READY'
    ERROR = 'ERROR'

class AppConversationStartTask(OpenHandsModel):
    id: UUID
    created_by_user_id: str | None
    status: AppConversationStartTaskStatus = WORKING
    detail: str | None
    app_conversation_id: UUID | None
    sandbox_id: str | None
    agent_server_url: str | None
    request: AppConversationStartRequest
```

**`start_app_conversation` 是 async generator**（`app_conversation_service.py:82`）：

```python
async def start_app_conversation(self, request) -> AsyncGenerator[...]:
    """调用方持续 iterate 直到 status ∈ {READY, ERROR}"""
    async for task in service.start_app_conversation(request):
        if task.status in (READY, ERROR): break
```

**完整 9 步状态机**：WORKING → WAITING_FOR_SANDBOX → PREPARING_REPOSITORY → RUNNING_SETUP_SCRIPT → SETTING_UP_GIT_HOOKS → SETTING_UP_SKILLS → STARTING_CONVERSATION → READY (or ERROR at any point)。

### 6.3 Event Callback（Webhook 入口）

`event_callback/event_callback_models.py:40`：

```python
class EventCallbackProcessor(DiscriminatedUnionMixin, ABC):
    event_kind: ClassVar[EventKind] = 'MessageEvent'
    
    @abstractmethod
    async def __call__(self, conversation_id, callback, event) -> EventCallbackResult | None:
        """处理一个事件，返回结果（成功/失败/响应）"""

class LoggingCallbackProcessor(EventCallbackProcessor):
    """示例：只 log"""

class SetTitleCallbackProcessor(EventCallbackProcessor):
    """新会话自动起标题（用 LLM 截第一条 user message）"""
```

**`webhook_router.py:on_event`** — agent-server 推送事件 → app_server：

```python
@router.post('/events/{conversation_id}')
async def on_event(events: list[Event], conversation_id, ...):
    # 1. 落库
    await asyncio.gather(*[event_service.save_event(conversation_id, e) for e in events])
    
    # 2. 处理 stats 事件
    for event in events:
        if isinstance(event, ConversationStateUpdateEvent) and event.key == 'stats':
            await app_conversation_info_service.process_stats_event(event, conversation_id)
    
    # 3. 异步跑所有 callback（顺序，保留因果）
    asyncio.create_task(_run_callbacks_in_bg_and_close(
        conversation_id, app_conversation_info.created_by_user_id, events
    ))
```

`on_conversation_update` 处理 sandbox start/pause/resume/delete 状态变化（`webhook_router.py:333`）。

**`app_conversation/app_conversation_router.py:25+ `** — admin / 用户查询接口。

---

## 7. 数据库设计：4 层持久化金字塔

| 层 | 存储 | 存什么 | 关键不变量 |
|---|---|---|---|
| 1 SDK | JSONL 文件 | 事件流 | append-only + flock + id 去重 |
| 2 agent-server | FileStore（JSON） | settings / secrets / workspaces | 接口设计成 SQL 抽象（待切真 SQL） |
| 3 app_server | SQLite/PostgreSQL | 6 张核心表 | **事件不在这**，只存元数据 |
| 4 enterprise | PostgreSQL · 44 张表 | 多租户全量 | 继承 app_server 表 + 加 SaaS 字段 |

### 7.1 L3 app_server 的 6 张核心表

| 表 | 关键字段 |
|---|---|
| `conversation_metadata` | `conversation_id` (PK), `selected_repository/branch`, `git_provider`, `title`, `trigger` (UI/GitHub/Slack), `pr_number[]`, `sandbox_id` (FK), `parent_conversation_id` (subagent), **`agent_kind`** (`codeact`/`acp`), `tags[]`, `accumulated_cost`, `prompt/completion/cache_read/cache_write/reasoning_tokens` |
| `app_conversation_start_task` | 异步启动任务（status PENDING/RUNNING/COMPLETED/ERROR）|
| `event_callback` | `conversation_id?` (null=全局), `event_kind`, `processor_type` (webhook/logging/setTitle), `processor_config Json`, `status` (active/disabled/completed/error) |
| `event_callback_result` | `callback_id` (FK), `event_id`, `status` (pending/success/error), `response Json?`, `error` |
| `pending_messages` | `conversation_id`, `role`, `content Json` (list[TextContent\|ImageContent]), `status` (pending/delivered) |
| `v1_remote_sandbox` | `id`, `created_by_user_id`, `sandbox_spec_id`, `status`, **`session_api_key_hash`**, `runtime_url`, `exposed_urls Json` |

**模式**：每种集成 = 3 张表（`{x}_users` / `{x}_workspaces` / `{x}_conversations`），把外部实体映射到 OpenHands 内部。

### 7.2 L4 enterprise 的 44 张表（6 组）

| 组 | 内容 |
|---|---|
| A. 用户与组织 | `user`, `org`, `org_member`, `org_invitation`, `role`, `user_authorizations` 等 7 张 |
| B. 会话元数据 | `conversation_metadata_saas`, `conversation_feedback`, `feedback`, `proactive_conversation_table`, `conversation_work` |
| C. 工作与任务 | `maintenance_tasks`, `script_results`（状态机：INACTIVE → PENDING → WORKING → COMPLETED/ERROR）|
| D. 集成（外部系统）| 21 张（GitHub/GitLab/Bitbucket/Jira/Linear/Slack …） |
| E. 计费与认证 | 订阅/计费/credit |
| F. 审计与日志 | 操作审计、analytics 事件 |

**多租户靠 `user.current_org_id` 实现** — 所有查询带 org 过滤。

---

## 8. 一次完整 run（5 个进程边界）

场景：用户在浏览器问"当前文件路径是什么？"，Claude ACP 模式：

```
┌─────────────┐  HTTP/WS   ┌──────────────────┐  函数调用  ┌──────────────┐
│  浏览器      │ ◀────────▶ │  agent-server     │ ◀───────▶ │  SDK         │
│  agent-     │            │  (FastAPI 进程)    │  同进程    │  (被 server  │
│  canvas     │            │                    │            │   import)    │
└─────────────┘            └──────────────────┘            └────┬─────────┘
                                                                   │ stdio +
                                                                   │ JSON-RPC
                                                                   ▼
                                                           ┌────────────────┐
                                                           │ claude-code-acp│
                                                           │ (子进程)        │
                                                           └────────┬───────┘
                                                                    │ HTTPS
                                                                    ▼
                                                           ┌────────────────┐
                                                           │ Anthropic API  │
                                                           └────────────────┘
```

**5 步时序**（简化）：

| 阶段 | 进程 | 文件 | 动作 |
|---|---|---|---|
| 1 | 浏览器 | `agent-canvas` | `POST /api/conversations/{id}/prompt` |
| 2 | server | `conversation_router.py` | FastAPI 路由 → `EventService.send_message` → 构造 `MessageEvent` append 到 `state.events` |
| 3 | SDK | `local_conversation.py:run` | status IDLE → RUNNING；while 循环调 `agent.step` |
| 4 | SDK | `acp_agent.py:ACPAgent.step` | 拼 prompt → stdio JSON-RPC `session/prompt` → 收 session_update 通知流 → 翻译成 OpenHands Event |
| 5 | SDK | `local_conversation.py:run` | events 写 jsonl + 广播 WS + 状态转移 → WS 推浏览器 |

**数据边界汇总**：

| 边界 | 协议 | 数据 |
|---|---|---|
| 浏览器 ↔ server | HTTP / WebSocket | JSON |
| server ↔ SDK | **函数调用**（同进程） | Python 对象 |
| SDK ↔ 子进程 | stdio + JSON-RPC 2.0 | JSON |
| 子进程 ↔ OS | subprocess | shell |
| 子进程 ↔ Anthropic | HTTPS | JSON |

---

## 9. 前端：useWebSocket + ConversationWebSocketProvider

`OpenHands/frontend/src/hooks/use-websocket.ts`（192 行）：

- React hook 包原生 `new WebSocket(url)`
- 状态机：`isConnected` / `lastMessage` / `messages` / `isReconnecting` / `error`
- **重连策略**：3s 延迟 + `attemptCountRef < maxAttempts`（默认无限）
- 用 `WeakSet<WebSocket>` 跟踪"哪些实例允许重连"（disconnect 路径排除自己）
- `shouldReconnectRef` 是 module-level flag（只由 `disconnect()` 翻成 false）

`use-send-message.ts`：

```ts
// V0：Socket.IO (useWsClient)
// V1：原生 WebSocket (useConversationWebSocket)
const v1Context = useConversationWebSocket();
```

V0/V1 两套并存（V0 是历史协议，V1 是 agent-server 新协议）。

**event-service.api.ts** 走 V1：调用 `runtimeUrl/api/conversations/{id}/events/...`（用 `conversationUrl` + `session_api_key` 鉴权）。

---

## 10. AgeWork vs OpenHands：核心对照 + 改造建议

### 10.1 已对齐（**不要重做**）

| OpenHands 概念 | agework 现状 |
|---|---|
| Event append-only log | `RunEvent` 表（seq + source + level + payload） |
| State 状态机 | `Run.status`（8 态） |
| 主循环 | `RuntimeRunner` + `RuntimeEventProcessor`（ACP 风格） |
| Agent step | `AbstractAgent.run(input) → Observable<AG-UI Event>` |
| Workspace 抽象 | `RuntimeProvider`（local / sandbox） |
| ACP session resume | adapter `rememberSession` + TTL/LRU |
| Envelope 有序投递 | `Envelope{runId,seq,ts}` + 去重 + 顺序校验 |
| Approval / confirmation | `pendingUserAction` + `approval_resolved` control |
| 心跳 / 孤儿恢复 | `heartbeat` + `HeartbeatWatchdog` + `RuntimeResource` |

### 10.2 真正缺失（按优先级）

| P | 主题 | 价值 | 工作量 | 风险 |
|---|---|---|---|---|
| **P0** | ACP 错误分类法 + 统一失败语义 | 🔥 极高 | 小 | 低 |
| **P0** | Stuck 检测 + 平台级迭代/时长上限 | 🔥 高 | 中 | 低 |
| **P0** | 会话元数据富化（trigger/repo·PR/自动标题/tags） | 高 | 中 | 低 |
| **P1** | Event Callback 订阅 + Webhook 处理器 | 高 | 中 | 低 |
| **P1** | Pending messages 队列 | 中高 | 小 | 低 |
| **P1** | Hook 系统（pre/post action，blocked_actions/messages） | 高 | 中 | 中 |
| **P2** | Context condenser | 中 | 大 | 中 |
| **P2** | MCP client | 中 | 中 | 低 |
| **P2** | Skills 渐进式披露 | 中 | 大 | 中 |
| **P3** | Subagent / delegate | 中 | 大 | 中 |
| **P3** | Event store 冷热分层 | 低 | 大 | 中 |
| **P3** | Agent profiles / 工具 preset | 低 | 小 | 低 |

### 10.3 P0-1：ACP 错误分类法

OpenHands 提示：ACP server 把 401/403 折叠成 `-32603`，**必须扫错误消息**才能识别。

**建议落地**：
- `packages/shared/src/protocol/agent-error.ts`：`AgentErrorCode` 枚举 + `AgentError` 类型（code/message/retryable/provider/raw）
- Claude/Codex adapter 在 catch 归一化，通过新 `run.error` envelope 上报
- `RuntimeEventProcessor` 收到 → 写 `RunEvent{level:error, payload:{code}}` → 透传 `RUN_ERROR.code`
- 前端 `run-aggregator.ts` 按 `code` 分流渲染

### 10.4 P0-2：Stuck 检测

OpenHands 有 `stuck_detector.py` + `MAX_EVENTS_TO_SCAN=20`，5 种 pattern：

1. **action-observation 重复**：最近 N 个 action 相同 **且** 最近 N 个 observation 相同
2. **action-error 循环**：最近 N 个 action 相同 **且** observation 全是 AgentErrorEvent
3. **自言自语**：最后一条 user message 后连续 N 条 agent message
4. **交替循环**：[A,B,A,B,A,B] 模式：action[i]==action[i+2] 且 obs[i]==obs[i+2]
5. **context window 错误循环**：重复 condensation 无其他事件（TODO，未实现）

**事件相等性比较**忽略 ID（`tool_call_id`, `llm_response_id`, `action_id`）— 因为同一动作重复时 ID 不同但语义相同。

**stuck 后果**：`execution_status = STUCK`（终态）。`STUCK` 是终态（`is_terminal()` 返回 true），但发新 user message 能重置回 IDLE。

**纯算法，agent 无关，可直接照搬到 `RuntimeEventProcessor` 之上**。

### 10.5 P0-3：会话元数据富化

`Conversation` 表加：

```prisma
model Conversation {
  // 已有字段...
  title            String?
  trigger          String?            // "ui" | "github_webhook" | "slack" | "api" | "schedule"
  selectedRepo     String?            // "owner/repo"
  selectedBranch   String?
  gitProvider      String?            // "github" | "gitlab"
  prNumbers        Int[]              // 关联 PR（可多个）
  tags             String[]
  parentConversationId String?        // subagent 父会话
  agentKind        String?            // "codeact" | "acp"（目前 agework 都是 acp，预留）
  accumulatedCostUsd Float   @default(0)
}
```

**配套**：
- 自动标题：在第一个 `TEXT_MESSAGE_END`（assistant）后，异步触发（简单版：截首条用户消息；增强版：调一次 cheap LLM）。等价于 `SetTitleCallbackProcessor`。
- `RunUsage` 聚合：Run 终态时把 `usage.totalCostUsd` 累加到 `Conversation.accumulatedCostUsd`。

### 10.6 P1-1：Event Callback + Webhook

```prisma
model EventCallback {
  id              String   @id @default(cuid())
  conversationId  String?  // null = 全局
  eventKind       String   // "RunEvent.eventType" 或 "MessageEvent" 等
  processorType   String   // "webhook" | "logging" | "setTitle"
  processorConfig Json     // webhook: {url, secret}；setTitle: {}
  status          String   @default("active") // active | disabled | error
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
}

model EventCallbackResult {
  id          String  @id @default(cuid())
  callbackId  String
  eventId     String
  status      String  // pending | success | error
  response    Json?
  error       String?
  createdAt   DateTime @default(now())
}
```

`RuntimeEventProcessor` 写完 `RunEvent` 后按 `eventKind` 匹配 callback 投递；处理器先做 `webhook`（HMAC 签名 + 重试 + 超时）和 `setTitle`（复用 P0-3 的自动标题）。

**验证**：注册一个 webhook callback → 产生对应事件 → 断言收到带签名的 POST + `EventCallbackResult.status=success`。

### 10.7 P1-2：Pending messages 队列

```prisma
model PendingMessage {
  id              String  @id @default(cuid())
  conversationId  String
  role            String  @default("user")
  content         Json    // AG-UI content
  status          String  @default("pending") // pending | delivered
  createdAt       DateTime @default(now())
}
```

`/api/v1/agent/run` 或 `/reply` 收到消息时，若 `activeRunStatus ∈ {preparing, running, requires_action}` → 写 `PendingMessage`；Run 终态或进入 `requires_action` 时 flush 队列。

### 10.8 一些更细的借鉴点

1. **delta 该不该入库**：OpenHands 不入，agework 入。短期保留，长期可考虑只入聚合 Message。
2. **错误事件分级**：`AgentErrorEvent`（tool 级，回灌 LLM，对话继续）vs `ConversationErrorEvent`（会话级，不回灌）。建议在 `RunEvent.payload` 加 `errorLevel` + `code` 分类。
3. **Action/Observation 配对不变量**：cancel 路径补"orphaned tool call"（给未完成 `TOOL_CALL_START` 补 `TOOL_CALL_RESULT(content="cancelled")`）。
4. **事件的 `kind` discriminator**：`RunEvent.eventType` 是字符串 + `payload: Json` — 缺类型化。建议在 `packages/shared` 定义 discriminated union。
5. **`llm_response_id` 合并 parallel tool call**：AG-UI 的 `parentMessageId` 类似但不完整。

---

## 11. 总结：OpenHands 给 agework 的核心启示

> **不是"复刻 OpenHands"，而是"补齐 OpenHands 在 ACP 路径之上的横切能力"。**

### 4 个最该抄的具体设计

1. **错误事件两级分级**（`errorLevel: "tool" | "conversation"` + `code` 分类）
2. **orphaned tool call 兜底**（cancel 路径补全 `TOOL_CALL_RESULT`）
3. **Stuck 检测 5 种 pattern**（纯算法，可直接照搬）
4. **EventType 的 discriminated union 类型化**（在 `packages/shared` 定义）

### 4 个高价值平台能力（P0/P1）

1. **Event Callback / Webhook**（打开外部集成入口 — Slack / GitHub / 自动化）
2. **Pending messages 队列**（Run 未 ready 时不丢消息）
3. **Hook 系统**（泛化 approval 为可插拔拦截层）
4. **会话元数据富化**（trigger/repo·branch·PR/自动标题/tags — 后续接入 GitHub/Slack 的基础）

### 架构对照速查

| 维度 | OpenHands | agework |
|---|---|---|
| 技术栈 | Python + FastAPI + Pydantic | TypeScript + NestJS + Prisma |
| Agent 集成 | SDK 内置（CodeAct） + ACP 外挂 | Adapter 模式（Claude/Codex） |
| 事件协议 | 自定义 Event（frozen + discriminator） | AG-UI（JSON，eventType 字符串） |
| 通信 | WebSocket（V0 Socket.IO / V1 原生） | SSE（`text/event-stream`） |
| 数据库 | JSONL（事件）+ SQLite/PG（元数据） | Prisma + SQLite/PG（事件 + 元数据都在 DB） |
| 部署 | 4 层金字塔（SDK → agent_server → app_server → enterprise） | 2 层（API + Worker） |
| 状态机 | 8 态（IDLE/RUNNING/PAUSED/WAITING_FOR_CONFIRMATION/FINISHED/ERROR/STUCK/DELETING） | 8 态（queued/preparing/running/requires_action/cancelling/finished/error/cancelled） |
| 并发协调 | ConversationLease + FileLock + generation | NestJS DI + 内存 `RunActiveStore` |
| 跨实例 | FileLock + owner_lease.json（多实例） | 单实例（无跨实例协调） |

---

## 附：源码路径速查

```
~/code/agent-project/
├── OpenHands/                                   # L3 + L4
│   ├── openhands/
│   │   ├── app_server/
│   │   │   ├── app_conversation/                # 异步启动任务 + 元数据
│   │   │   │   ├── app_conversation_models.py   # AppConversationStartTaskStatus 9 态
│   │   │   │   ├── app_conversation_service.py  # start_app_conversation async gen
│   │   │   │   ├── sql_app_conversation_info_service.py
│   │   │   │   └── sql_app_conversation_start_task_service.py
│   │   │   ├── event/                           # 事件落库 + 查询
│   │   │   ├── event_callback/                  # Webhook + Processor
│   │   │   │   ├── event_callback_models.py     # EventCallbackProcessor 抽象
│   │   │   │   ├── webhook_router.py            # /webhooks/* 接收
│   │   │   │   ├── sql_event_callback_service.py
│   │   │   │   └── set_title_callback_processor.py
│   │   │   ├── sandbox/                         # sandbox 生命周期
│   │   │   │   ├── sandbox_models.py            # SandboxStatus 5 态
│   │   │   │   ├── sandbox_service.py           # 抽象基类 + wait_for_sandbox_running
│   │   │   │   ├── docker_sandbox_service.py    # DockerSandboxService
│   │   │   │   └── process_sandbox_service.py   # 本地进程版
│   │   │   ├── pending_messages/                # 待发消息队列
│   │   │   ├── integrations/                    # GitHub/GitLab/Jira/Linear/Slack
│   │   │   ├── services/injector.py             # DI 抽象
│   │   │   └── v1_router.py                     # v1 API 路由入口
│   │   ├── server/                              # 旧版 V0 server
│   │   └── analytics/
│   ├── enterprise/                              # L4 多租户 SaaS
│   │   ├── server/                              # FastAPI 业务路由
│   │   │   ├── routes/                          # users_v1 / auth / billing / orgs …
│   │   │   └── services/
│   │   └── storage/                             # 44 张表模型
│   ├── frontend/                                # React 17 + Redux + React Router
│   │   ├── src/
│   │   │   ├── api/event-service/               # V1 事件查询
│   │   │   ├── contexts/conversation-websocket-context.tsx
│   │   │   ├── hooks/use-websocket.ts           # 192 行 WebSocket hook
│   │   │   ├── hooks/use-send-message.ts
│   │   │   └── routes/conversation.tsx
│   │   └── openhands-ui/                        # shadcn 风格组件库
│   ├── containers/                              # Docker build
│   ├── config.template.toml
│   └── docker-compose.yml
│
├── software-agent-sdk/                          # L1 + L2
│   ├── openhands-sdk/                           # L1 核心
│   │   └── openhands/sdk/
│   │       ├── event/                           # 18 个事件类型
│   │       │   ├── base.py                      # Event 基类
│   │       │   ├── llm_convertible/             # 6 个 LLMConvertible
│   │       │   ├── streaming_delta.py           # 不持久化
│   │       │   └── conversation_state.py        # ConversationStateUpdateEvent
│   │       ├── conversation/
│   │       │   ├── impl/local_conversation.py   # LocalConversation 主循环
│   │       │   ├── fifo_lock.py
│   │       │   ├── state.py                     # 8 态枚举
│   │       │   ├── event_store.py               # EventLog append-only + flock
│   │       │   └── stuck_detector.py            # 5 种 pattern
│   │       ├── agent/
│   │       │   ├── base.py                      # AgentBase 接口
│   │       │   ├── acp_agent.py                 # ACPAgent（stdio JSON-RPC 客户端）
│   │       │   └── acp_models.py                # ACP 协议类型
│   │       ├── tool/                            # Tool 抽象 + 注册
│   │       ├── llm/                             # LLM 抽象（litellm 适配）
│   │       ├── workspace/                       # BaseWorkspace 协议
│   │       ├── hooks/                           # 6 种 hook 时机
│   │       ├── security/                        # confirmation + analyzer
│   │       ├── skills/                          # AgentSkills progressive disclosure
│   │       ├── subagent/                        # 子 agent 委派
│   │       ├── io/                              # 持久化
│   │       └── utils/models.py                  # DiscriminatedUnionMixin
│   ├── openhands-workspace/                     # L2 workspace 实现
│   │   └── openhands/workspace/
│   │       ├── docker/
│   │       ├── apptainer/
│   │       ├── remote_api/
│   │       └── cloud/
│   ├── openhands-tools/                         # L2 工具实现
│   │   └── openhands/tools/
│   │       ├── terminal/
│   │       ├── file_editor/
│   │       ├── browser_use/
│   │       └── preset/
│   └── openhands-agent-server/                  # L2 HTTP/WS 入口
│       └── openhands/agent_server/
│           ├── api.py
│           ├── conversation_router.py           # /conversations/*
│           ├── conversation_service.py          # 1546 行
│           ├── event_service.py                 # 1524 行
│           ├── event_router.py
│           ├── event_service.py                 # 事件落库
│           ├── pub_sub.py                       # PubSub[T]
│           ├── conversation_lease.py            # 跨实例 ownership
│           ├── sockets.py                       # WebSocket
│           ├── bash_router.py / bash_service.py
│           ├── file_router.py
│           ├── git_router.py
│           ├── tools/                           # skill / mcp / profiles
│           ├── persistence/                     # FileStore 抽象
│           └── docker/                          # build 镜像
│
└── agent-canvas/                                # OpenHands 的新前端
    ├── src/
    │   ├── routes/conversation.tsx              # 会话主页
    │   ├── routes/browser-tab.tsx
    │   ├── routes/planner-tab.tsx
    │   ├── routes/launch.tsx                    # 启动会话
    │   ├── routes/agent-settings.tsx
    │   ├── routes/llm-settings.tsx
    │   └── contexts/conversation-websocket-context.tsx
    └── package.json                             # 依赖 @openhands/agent-server SDK
```

### 关键文档（已读）

```
~/code/agent-project/
├── openhands-core-4.md           # 4 个原语（Event/State/Conversation/Agent）
├── openhands-sdk-blueprint.md    # SDK 架构蓝图 + 一次完整 run 时序
├── openhands-event-mechanism-deep.md  # Event 三路分离 + 18 类型 + Action/Observation 配对
├── openhands-database-design.md  # 4 层持久化金字塔
├── openhands-sdk-note.md         # 4 个子包分层依赖
└── agework-upgrade-from-openhands.md  # AgeWork 升级方案（按 P0/P1/P2/P3 排序）
```
