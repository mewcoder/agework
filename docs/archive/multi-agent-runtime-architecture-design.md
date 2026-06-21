# 多 Agent 平台 Runtime 架构设计

## 1. 背景

本平台是一个多 Agent 任务平台，用户可以像在聊天平台选择不同模型一样，在平台中选择不同 Agent 执行任务。

示例 Agent：

* Claude Code Agent
* Codex Agent
* Review Agent
* Test Generator Agent
* 自研业务 Agent

这些 Agent 不是互相编排，而是各自独立执行任务。一个用户任务可以只选择一个 Agent，也可以同时选择多个 Agent 并行执行，最后由用户比较不同 Agent 的结果。

平台需要同时支持两种运行模式：

* 本地运行：Runtime Worker 作为本地子进程运行
* 沙箱运行：Runtime Worker 在 Docker、Kubernetes Pod、VM 或 microVM 中运行

核心设计目标：

* 统一支持本地和沙箱
* 统一支持多个 Agent
* 统一事件协议为 AG-UI
* Runtime Worker 不监听端口
* Platform Server 负责控制面
* Runtime Worker 负责执行面
* Agent Adapter 负责适配不同 Agent SDK
* 前端只消费 AG-UI 事件

---

## 2. 总体架构

```text
┌────────────────────────────────────────────────────────────┐
│                        AG-UI Client                        │
│                                                            │
│  - Agent 选择                                              │
│  - Workspace 选择                                          │
│  - Prompt 输入                                             │
│  - AG-UI 事件展示                                          │
│  - Tool Call 展示                                          │
│  - Artifact / Diff 展示                                    │
│  - 用户确认 / 取消 / 中断                                  │
└───────────────────────────────┬────────────────────────────┘
                                │
                                │ AG-UI / HTTP / SSE / WebSocket
                                ▼
┌────────────────────────────────────────────────────────────┐
│                       Platform Server                      │
│                                                            │
│  Control Plane                                             │
│                                                            │
│  - User / Auth                                             │
│  - Workspace Manager                                       │
│  - Conversation / Messenger                                │
│  - Agent Registry                                          │
│  - Task / Run Manager                                      │
│  - Runtime Gateway                                         │
│  - Event Store                                             │
│  - Artifact Store                                          │
│  - Control Store                                           │
│  - AG-UI Stream                                            │
└───────────────────────────────┬────────────────────────────┘
                                │
                                │ start run
                                ▼
┌────────────────────────────────────────────────────────────┐
│                       Runtime Gateway                      │
│                                                            │
│  - 选择 RuntimeProvider                                    │
│  - 决定 local / docker / k8s / microVM                     │
│  - 创建 run                                                │
│  - 生成 runtime token                                      │
│  - 启动 Runtime Worker                                     │
└───────────────────────────────┬────────────────────────────┘
                                │
                                ▼
┌────────────────────────────────────────────────────────────┐
│                    Runtime Provider Layer                  │
│                                                            │
│  - LocalProcessRuntimeProvider                             │
│  - DockerRuntimeProvider                                   │
│  - KubernetesRuntimeProvider                               │
│  - MicroVmRuntimeProvider                                  │
└───────────────────────────────┬────────────────────────────┘
                                │
                                │ spawn / docker run / k8s job / vm
                                ▼
┌────────────────────────────────────────────────────────────┐
│                       Runtime Worker                       │
│                                                            │
│  Data Plane                                                │
│                                                            │
│  - 无端口                                                  │
│  - 不是 HTTP Server                                        │
│  - 主动调用 Platform Server internal API                   │
│  - 拉取 run config                                         │
│  - 准备 workspace                                          │
│  - 运行 Agent Adapter                                      │
│  - 上报 AG-UI Event                                        │
│  - 上报 heartbeat                                          │
│  - 轮询 control message                                    │
│  - 上传 artifact                                           │
│  - 标记 completed / failed                                 │
└───────────────────────────────┬────────────────────────────┘
                                │
                                ▼
┌────────────────────────────────────────────────────────────┐
│                       Agent Adapter Layer                  │
│                                                            │
│  - ClaudeCodeAgentAdapter                                  │
│  - CodexAgentAdapter                                       │
│  - CustomAgentAdapter                                      │
│  - ReviewAgentAdapter                                      │
│                                                            │
│  Agent SDK Native Event → AG-UI Event                      │
└────────────────────────────────────────────────────────────┘
```

---

## 3. 核心职责划分

### 3.1 AG-UI Client

AG-UI Client 是前端交互层。

职责：

* 展示 Agent 列表
* 选择 Workspace
* 输入 Prompt
* 创建 Task
* 订阅 AG-UI 事件流
* 展示消息、工具调用、状态、日志
* 展示 Diff、Artifact、测试结果
* 发送用户确认、取消、中断等控制指令

前端只关心 AG-UI 协议，不关心底层 Agent 是 Claude Code、Codex 还是其他 Agent。

---

### 3.2 Platform Server

Platform Server 是控制面。

职责：

* 用户管理
* 鉴权
* Workspace 管理
* Conversation / Messenger 管理
* Agent Registry 管理
* Task / Run 管理
* Runtime Gateway 调度
* Event Store
* Artifact Store
* Control Store
* AG-UI Stream 输出
* 内部 Runtime API

Platform Server 不负责：

* 不直接运行 Claude Code SDK
* 不直接运行 Codex SDK
* 不直接执行用户代码
* 不直接执行 shell
* 不直接暴露沙箱端口

---

### 3.3 Runtime Gateway

Runtime Gateway 负责决定某个 Run 应该由哪个 RuntimeProvider 启动。

职责：

* 根据 Agent 类型选择 Runtime
* 根据环境选择本地或沙箱
* 根据 Workspace 风险选择隔离级别
* 根据用户套餐控制资源限制
* 创建 Runtime Token
* 调用对应 RuntimeProvider 启动 Worker

示例策略：

```text
开发环境：
  local_process

可信任务：
  local_process / docker

多用户云端任务：
  k8s

不可信代码：
  microVM

只读 Agent：
  local_process 或 read-only container

会写文件 / 跑 shell 的 Agent：
  docker / k8s / microVM
```

---

### 3.4 Runtime Provider

RuntimeProvider 负责启动 Runtime Worker。

Provider 类型：

```text
LocalProcessRuntimeProvider
  本地启动 Runtime Worker 子进程

DockerRuntimeProvider
  使用 docker run 启动 Runtime Worker

KubernetesRuntimeProvider
  创建 Kubernetes Job / Pod 启动 Runtime Worker

MicroVmRuntimeProvider
  创建 VM / microVM 启动 Runtime Worker
```

RuntimeProvider 只负责“怎么启动”，不负责“Agent 怎么跑”。

---

### 3.5 Runtime Worker

Runtime Worker 是执行面。

它不是 HTTP Server，不监听端口。

它只是一个 worker 脚本，例如：

```bash
node dist/runtime-worker.js
```

职责：

* 读取环境变量
* 主动请求 Platform Server 拉取 run config
* 准备 workspace
* 加载 Agent Adapter
* 运行具体 Agent SDK
* 接收 Agent Adapter 输出的 AG-UI Event
* 给事件补充 runId、agentId、sequence 等 envelope 信息
* 上报事件到 Platform Server
* 上报 heartbeat
* 轮询 control message
* 上传 artifact
* 更新 run 状态
* 任务结束后退出

Runtime Worker 不负责：

* 不监听端口
* 不对外提供 HTTP 服务
* 不做用户鉴权
* 不直接访问数据库
* 不做任务调度
* 不管理其他 Worker

---

### 3.6 Agent Adapter

Agent Adapter 负责适配不同 Agent SDK。

职责：

* 调用具体 Agent SDK
* 接收 SDK 原生事件
* 将 SDK 原生事件转换为 AG-UI Event
* 屏蔽不同 SDK 的事件格式差异

Adapter 示例：

```text
ClaudeCodeAgentAdapter
  Claude Code SDK Event → AG-UI Event

CodexAgentAdapter
  Codex SDK Event → AG-UI Event

CustomAgentAdapter
  Custom Agent Event → AG-UI Event

ReviewAgentAdapter
  Review Agent Event → AG-UI Event
```

统一接口：

```ts
export interface AgentAdapter {
  run(input: AgentRunInput): AsyncIterable<AGUIEvent>;

  cancel?(runId: string): Promise<void>;
}
```

---

## 4. 关键实体模型

### 4.1 Agent

Agent 是一种能力定义。

示例：

```text
claude-code
codex
review-agent
test-generator
custom-agent
```

AgentDefinition 示例：

```ts
export interface AgentDefinition {
  id: string;
  displayName: string;
  description?: string;

  adapterType: "claude-code" | "codex" | "custom" | "review";

  capabilities: {
    readFiles: boolean;
    writeFiles: boolean;
    runShell: boolean;
    useNetwork: boolean;
    createArtifacts: boolean;
    requireWorkspace: boolean;
  };

  runtime: {
    defaultMode: "local_process" | "docker" | "k8s" | "microvm";
    minIsolation: "local_process" | "docker" | "k8s" | "microvm";
    image?: string;
    command?: string[];
  };

  policy: {
    requireApprovalForShell: boolean;
    requireApprovalForNetwork: boolean;
    requireApprovalForFileWrite: boolean;
  };

  limits: {
    defaultTimeoutSeconds: number;
    maxTimeoutSeconds: number;
    defaultMemoryMb: number;
    defaultCpu: number;
  };
}
```

---

### 4.2 Task

Task 是用户提交的一次任务。

示例：

```text
修复登录页测试失败
为当前项目生成单元测试
Review 当前 PR
重构某个组件
```

---

### 4.3 Run

Run 是某个 Agent 对某个 Task 的一次执行。

一个 Task 可以有一个 Run，也可以有多个 Run。

```text
Task: 修复登录页测试失败

  Run A: Claude Code Agent
  Run B: Codex Agent
  Run C: Review Agent
```

---

### 4.4 Runtime Worker

Runtime Worker 是真正执行某个 Run 的进程、容器、Pod 或 VM。

推荐关系：

```text
one run = one runtime worker
```

不要默认让多个 Agent 共享同一个 Runtime Worker。

---

### 4.5 Workspace

Workspace 是 Agent 操作的代码或文件环境。

Workspace 类型：

```ts
export type WorkspaceSpec =
  | {
      type: "local_path";
      path: string;
    }
  | {
      type: "git";
      repoUrl: string;
      branch?: string;
      commit?: string;
      authTokenRef?: string;
    }
  | {
      type: "archive";
      artifactUri: string;
    }
  | {
      type: "snapshot";
      snapshotId: string;
    };
```

多 Agent 并行时，默认建议：

```text
每个 Run 一份独立 workspace
```

不要让多个 Agent 共享同一个可写目录，否则容易产生文件冲突和环境污染。

---

### 4.6 Artifact

Artifact 是 Run 的产物。

常见 Artifact：

```text
patch.diff
summary.md
agent-log.jsonl
test-result.json
changed-files.json
screenshots
workspace-output.tar.gz
```

事件里只存 Artifact metadata，大文件走对象存储。

---

## 5. 本地运行架构

本地运行时，只有 Platform Server 监听端口。

```text
┌────────────────────────────────────────────┐
│                AG-UI Client                │
└────────────────────┬───────────────────────┘
                     │
                     │ http://localhost:3000
                     ▼
┌────────────────────────────────────────────┐
│              Platform Server               │
│                                            │
│  listen: localhost:3000                    │
│                                            │
│  - Task Manager                            │
│  - Run Manager                             │
│  - Runtime Gateway                         │
│  - Event Store                             │
│  - AG-UI Stream                            │
└────────────────────┬───────────────────────┘
                     │
                     │ spawn child process
                     ▼
┌────────────────────────────────────────────┐
│              Runtime Worker A              │
│                                            │
│  no port                                   │
│  agentId: claude-code                      │
│  runId: run_a                              │
│                                            │
│  calls:                                    │
│  http://127.0.0.1:3000/internal/runs/run_a │
└────────────────────────────────────────────┘

┌────────────────────────────────────────────┐
│              Runtime Worker B              │
│                                            │
│  no port                                   │
│  agentId: codex                            │
│  runId: run_b                              │
│                                            │
│  calls:                                    │
│  http://127.0.0.1:3000/internal/runs/run_b │
└────────────────────────────────────────────┘
```

本地多 Agent：

```text
Platform Server
  ├── Runtime Worker A: Claude Code
  ├── Runtime Worker B: Codex
  └── Runtime Worker C: Review Agent
```

每个 Worker 都不占服务端口。

---

## 6. 沙箱运行架构

沙箱运行时，Runtime Worker 被放进容器、Pod 或 VM。

```text
┌────────────────────────────────────────────┐
│                AG-UI Client                │
└────────────────────┬───────────────────────┘
                     │
                     ▼
┌────────────────────────────────────────────┐
│              Platform Server               │
│                                            │
│  - Task Manager                            │
│  - Run Manager                             │
│  - Runtime Gateway                         │
│  - Event Store                             │
│  - AG-UI Stream                            │
└────────────────────┬───────────────────────┘
                     │
                     │ create sandbox
                     ▼
┌────────────────────────────────────────────┐
│          Sandbox / Container / Pod A       │
│                                            │
│  Runtime Worker A                          │
│  no port                                   │
│  agentId: claude-code                      │
│  runId: run_a                              │
│                                            │
│  calls:                                    │
│  http://platform-server/internal/runs/run_a│
└────────────────────────────────────────────┘

┌────────────────────────────────────────────┐
│          Sandbox / Container / Pod B       │
│                                            │
│  Runtime Worker B                          │
│  no port                                   │
│  agentId: codex                            │
│  runId: run_b                              │
│                                            │
│  calls:                                    │
│  http://platform-server/internal/runs/run_b│
└────────────────────────────────────────────┘
```

沙箱多 Agent：

```text
Platform Server
  ├── Sandbox A
  │     └── Runtime Worker: Claude Code
  │
  ├── Sandbox B
  │     └── Runtime Worker: Codex
  │
  └── Sandbox C
        └── Runtime Worker: Review Agent
```

核心原则：

```text
Worker 永远不提供 HTTP 服务
Worker 永远主动调用 Platform internal API
本地和沙箱只差启动方式
```

---

## 7. Runtime Worker 启动流程

Runtime Worker 启动时读取环境变量：

```bash
RUN_ID=run_123
TASK_ID=task_123
AGENT_ID=claude-code
RUNTIME_TOKEN=runtime_token_xxx
PLATFORM_API_BASE=http://127.0.0.1:3000
```

沙箱环境中：

```bash
PLATFORM_API_BASE=http://platform-server.default.svc.cluster.local:3000
```

启动流程：

```text
1. read env
2. GET /internal/runs/{runId} 拉取 run config
3. prepare workspace
4. load Agent Adapter
5. run Agent SDK
6. receive AG-UI Events from Adapter
7. post AG-UI Events to Platform Server
8. post heartbeat
9. poll controls
10. upload artifacts
11. update run status
12. exit
```

---

## 8. Runtime Worker 内部结构

```text
┌────────────────────────────────────────────┐
│              Runtime Worker                │
│                                            │
│  Entry: runtime-worker.ts                  │
│                                            │
│  1. read env                               │
│     - RUN_ID                               │
│     - TASK_ID                              │
│     - AGENT_ID                             │
│     - RUNTIME_TOKEN                        │
│     - PLATFORM_API_BASE                    │
│                                            │
│  2. fetch run config                       │
│                                            │
│  3. prepare workspace                      │
│                                            │
│  4. load Agent Adapter                     │
│                                            │
│  5. run Agent SDK                          │
│                                            │
│  6. receive AG-UI Events from Adapter      │
│                                            │
│  7. post AG-UI Events to Platform Server   │
│                                            │
│  8. poll controls                          │
│                                            │
│  9. upload artifacts                       │
│                                            │
│ 10. update run status                      │
└────────────────────────────────────────────┘
```

---

## 9. 事件流设计

本架构直接使用 AG-UI 作为统一事件协议。

```text
Agent SDK Native Event
  → Agent Adapter
    → AG-UI Event
      → Runtime Worker
        → Platform Server Event Store
          → AG-UI Client
```

Claude Code：

```text
Claude Code SDK Event
  → ClaudeCodeAgentAdapter
    → AG-UI Event
      → Runtime Worker
        → Platform Server
          → AG-UI Client
```

Codex：

```text
Codex SDK Event
  → CodexAgentAdapter
    → AG-UI Event
      → Runtime Worker
        → Platform Server
          → AG-UI Client
```

---

## 10. Runtime Event Envelope

虽然事件本身是 AG-UI Event，但 Runtime Worker 上报时需要给事件包一层 envelope。

```ts
export interface RuntimeAGUIEventEnvelope {
  id: string;
  taskId: string;
  runId: string;
  agentId: string;
  sequence: number;
  event: AGUIEvent;
  createdAt: string;
}
```

上报接口：

```http
POST /internal/runs/{runId}/events
Authorization: Bearer <runtime_token>
Idempotency-Key: <runId>:<sequence>
Content-Type: application/json
```

示例：

```json
{
  "taskId": "task_123",
  "runId": "run_claude_001",
  "agentId": "claude-code",
  "sequence": 42,
  "event": {
    "type": "TextMessageContent",
    "messageId": "msg_1",
    "delta": "我发现测试失败原因是..."
  },
  "createdAt": "2026-06-09T12:00:00.000Z"
}
```

---

## 11. Platform Server 内部 API

Runtime Worker 只调用 Platform Server 的 internal API。

### 11.1 拉取 Run 配置

```http
GET /internal/runs/{runId}
Authorization: Bearer <runtime_token>
```

返回：

```json
{
  "runId": "run_123",
  "taskId": "task_123",
  "agent": {
    "agentId": "claude-code",
    "adapterType": "claude-code",
    "model": "claude-sonnet"
  },
  "input": {
    "prompt": "修复登录页测试失败问题"
  },
  "workspace": {
    "type": "git",
    "repoUrl": "https://github.com/acme/app",
    "branch": "main"
  },
  "policy": {
    "allowShell": true,
    "allowFileWrite": true,
    "allowNetwork": "restricted",
    "requireApprovalForShell": false
  },
  "limits": {
    "timeoutSeconds": 900,
    "memoryMb": 4096,
    "cpu": 2
  }
}
```

---

### 11.2 上报事件

```http
POST /internal/runs/{runId}/events
Authorization: Bearer <runtime_token>
Idempotency-Key: <runId>:<sequence>
Content-Type: application/json
```

---

### 11.3 上报心跳

```http
POST /internal/runs/{runId}/heartbeat
Authorization: Bearer <runtime_token>
Content-Type: application/json
```

示例：

```json
{
  "status": "running",
  "phase": "running_tests",
  "lastSequence": 42,
  "resource": {
    "memoryMb": 1024,
    "cpuPercent": 35
  }
}
```

---

### 11.4 拉取控制消息

```http
GET /internal/runs/{runId}/controls?afterSequence=0
Authorization: Bearer <runtime_token>
```

---

### 11.5 申请 Artifact 上传地址

```http
POST /internal/runs/{runId}/artifacts/presign
Authorization: Bearer <runtime_token>
Content-Type: application/json
```

---

### 11.6 更新 Run 状态

```http
PATCH /internal/runs/{runId}
Authorization: Bearer <runtime_token>
Content-Type: application/json
```

示例：

```json
{
  "status": "completed"
}
```

---

## 12. 控制流设计

前端控制行为：

```text
取消任务
中断 Agent
批准工具调用
拒绝工具调用
追加用户消息
```

控制流：

```text
AG-UI Client
  → Platform Server
    → ControlStore
      → Runtime Worker polling
        → Agent Adapter / Agent SDK
```

Runtime Worker 不接收外部直连请求，而是主动轮询控制消息。

控制消息类型：

```ts
export type RuntimeControl =
  | {
      type: "cancel";
      reason?: string;
    }
  | {
      type: "interrupt";
      reason?: string;
    }
  | {
      type: "approval_resolved";
      approvalId: string;
      approved: boolean;
    }
  | {
      type: "user_message";
      messageId: string;
      content: string;
    };
```

---

## 13. 多 Agent 并行执行

用户可以一次选择多个 Agent。

请求示例：

```json
{
  "workspaceId": "ws_123",
  "agentIds": ["claude-code", "codex", "review-agent"],
  "prompt": "修复登录页测试失败"
}
```

Platform 创建：

```text
Task task_123

Run run_a
  agentId = claude-code
  worker = Runtime Worker A

Run run_b
  agentId = codex
  worker = Runtime Worker B

Run run_c
  agentId = review-agent
  worker = Runtime Worker C
```

架构图：

```text
┌────────────────────────────────────────────┐
│                AG-UI Client                │
│                                            │
│  Task: 修复登录测试失败                    │
│                                            │
│  ┌──────────────┐ ┌──────────────┐         │
│  │ Claude Code  │ │ Codex        │         │
│  │ Run A Events │ │ Run B Events │         │
│  └──────────────┘ └──────────────┘         │
└────────────────────┬───────────────────────┘
                     │
                     ▼
┌────────────────────────────────────────────┐
│              Platform Server               │
│                                            │
│  Task task_123                             │
│                                            │
│  Run run_a                                 │
│    agentId = claude-code                   │
│                                            │
│  Run run_b                                 │
│    agentId = codex                         │
│                                            │
│  EventStore                                │
│    run_a sequence 1..n                     │
│    run_b sequence 1..n                     │
└────────────────────┬───────────────────────┘
                     │
       ┌─────────────┴─────────────┐
       │                           │
       ▼                           ▼
┌───────────────────┐       ┌───────────────────┐
│ Runtime Worker A  │       │ Runtime Worker B  │
│                   │       │                   │
│ ClaudeCodeAdapter │       │ CodexAdapter      │
│                   │       │                   │
│ outputs AG-UI     │       │ outputs AG-UI     │
└───────────────────┘       └───────────────────┘
```

每个 Run 独立：

```text
独立 runId
独立 runtimeToken
独立 Runtime Worker
独立 Workspace
独立 Event Sequence
独立 Artifact
```

---

## 14. Sequence 设计

事件序号按 Run 独立递增。

```text
run_claude_001:
  sequence 1, 2, 3, 4...

run_codex_001:
  sequence 1, 2, 3, 4...
```

数据库唯一约束：

```sql
UNIQUE(run_id, sequence)
```

这样可以保证：

```text
重复上报不会重复写入
前端可以断线续传
多 Agent 事件不会混乱
```

---

## 15. 数据库表设计

### 15.1 tasks

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL
);
```

---

### 15.2 task_runs

```sql
CREATE TABLE task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  adapter_type TEXT NOT NULL,

  runtime_provider TEXT NOT NULL,
  runtime_id TEXT,
  isolation_mode TEXT NOT NULL,

  status TEXT NOT NULL,
  phase TEXT,

  last_sequence BIGINT DEFAULT 0,
  last_heartbeat_at TIMESTAMP,

  error_message TEXT,
  started_at TIMESTAMP,
  finished_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL
);
```

---

### 15.3 run_events

```sql
CREATE TABLE run_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,

  sequence BIGINT NOT NULL,

  agui_event JSONB NOT NULL,

  created_at TIMESTAMP NOT NULL,

  UNIQUE(run_id, sequence)
);
```

---

### 15.4 runtime_controls

```sql
CREATE TABLE runtime_controls (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  sequence BIGINT NOT NULL,
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  consumed_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL,

  UNIQUE(run_id, sequence)
);
```

---

### 15.5 artifacts

```sql
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  name TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  uri TEXT NOT NULL,
  content_type TEXT,
  size_bytes BIGINT,
  created_at TIMESTAMP NOT NULL
);
```

---

## 16. RuntimeProvider 接口

```ts
export interface RuntimeProvider {
  start(input: RuntimeStartInput): Promise<RuntimeHandle>;

  sendControl(
    handle: RuntimeHandle,
    control: RuntimeControl
  ): Promise<void>;

  cancel(handle: RuntimeHandle): Promise<void>;

  destroy(handle: RuntimeHandle): Promise<void>;

  getStatus(handle: RuntimeHandle): Promise<RuntimeStatus>;
}
```

---

### 16.1 RuntimeStartInput

```ts
export interface RuntimeStartInput {
  taskId: string;
  runId: string;
  userId: string;

  agent: {
    agentId: string;
    adapterType: "claude-code" | "codex" | "custom" | "review";
    model?: string;
  };

  input: {
    prompt: string;
    messages?: Array<{
      role: "user" | "assistant" | "system";
      content: string;
    }>;
  };

  workspace: WorkspaceSpec;

  runtime: {
    mode: "local_process" | "docker" | "k8s" | "microvm";
    image?: string;
    command?: string[];
  };

  policy: RuntimePolicy;

  limits: {
    timeoutSeconds: number;
    cpu?: number;
    memoryMb?: number;
    maxOutputBytes?: number;
  };
}
```

---

### 16.2 RuntimeHandle

```ts
export interface RuntimeHandle {
  taskId: string;
  runId: string;
  runtimeId: string;
  provider: "local_process" | "docker" | "k8s" | "microvm";
  status: "starting" | "running" | "stopped" | "failed";
}
```

---

## 17. Runtime Worker 伪代码

```ts
async function main() {
  const env = readRuntimeEnv();

  const client = new PlatformRuntimeClient({
    apiBase: env.PLATFORM_API_BASE,
    token: env.RUNTIME_TOKEN,
    runId: env.RUN_ID
  });

  const runConfig = await client.fetchRunConfig();

  await client.updateRunStatus({
    status: "running",
    phase: "preparing_workspace"
  });

  const workspacePath = await prepareWorkspace(runConfig.workspace);

  const adapter = agentAdapterRegistry.get(runConfig.agent.adapterType);

  const emitter = new RuntimeEventEmitter({
    taskId: runConfig.taskId,
    runId: runConfig.runId,
    agentId: runConfig.agent.agentId,
    client
  });

  try {
    await client.updateRunStatus({
      status: "running",
      phase: "running_agent"
    });

    for await (const aguiEvent of adapter.run({
      ...runConfig,
      workspacePath
    })) {
      await emitter.emit(aguiEvent);

      const controls = await client.fetchControls();
      await applyControls(controls, adapter);
    }

    await collectAndUploadArtifacts({
      workspacePath,
      client
    });

    await client.updateRunStatus({
      status: "completed"
    });
  } catch (error: any) {
    await client.updateRunStatus({
      status: "failed",
      errorMessage: error.message
    });

    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

---

## 18. RuntimeEventEmitter

```ts
export class RuntimeEventEmitter {
  private sequence = 0;

  constructor(
    private readonly ctx: {
      taskId: string;
      runId: string;
      agentId: string;
      client: PlatformRuntimeClient;
    }
  ) {}

  async emit(event: AGUIEvent) {
    const envelope = {
      id: crypto.randomUUID(),
      taskId: this.ctx.taskId,
      runId: this.ctx.runId,
      agentId: this.ctx.agentId,
      sequence: ++this.sequence,
      event,
      createdAt: new Date().toISOString()
    };

    await this.writeLocalBuffer(envelope);

    await this.ctx.client.postEventWithRetry(envelope);

    return envelope;
  }

  private async writeLocalBuffer(envelope: RuntimeAGUIEventEnvelope) {
    // 可写入 /tmp/runtime-events.jsonl
    // 用于失败诊断、断线补发、审计
  }
}
```

---

## 19. LocalProcessRuntimeProvider 示例

```ts
export class LocalProcessRuntimeProvider implements RuntimeProvider {
  async start(input: RuntimeStartInput): Promise<RuntimeHandle> {
    const runtimeId = `local_${input.runId}`;

    const runtimeToken = await createRuntimeToken({
      taskId: input.taskId,
      runId: input.runId
    });

    const child = spawn("node", ["dist/runtime-worker.js"], {
      env: {
        ...process.env,

        RUNTIME_MODE: "local_process",
        TASK_ID: input.taskId,
        RUN_ID: input.runId,
        AGENT_ID: input.agent.agentId,
        RUNTIME_ID: runtimeId,
        RUNTIME_TOKEN: runtimeToken,

        PLATFORM_API_BASE: "http://127.0.0.1:3000"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    registerChildProcess(runtimeId, child);

    return {
      taskId: input.taskId,
      runId: input.runId,
      runtimeId,
      provider: "local_process",
      status: "starting"
    };
  }

  async sendControl(handle: RuntimeHandle, control: RuntimeControl) {
    await saveControlMessage(handle.runId, control);
  }

  async cancel(handle: RuntimeHandle) {
    await saveControlMessage(handle.runId, {
      type: "cancel"
    });

    killChildProcess(handle.runtimeId);
  }

  async destroy(handle: RuntimeHandle) {
    killChildProcess(handle.runtimeId);
  }

  async getStatus(handle: RuntimeHandle) {
    return getRuntimeStatus(handle.runId);
  }
}
```

---

## 20. KubernetesRuntimeProvider 示例

```ts
export class KubernetesRuntimeProvider implements RuntimeProvider {
  async start(input: RuntimeStartInput): Promise<RuntimeHandle> {
    const runtimeId = `k8s_${input.runId}`;

    const runtimeToken = await createRuntimeToken({
      taskId: input.taskId,
      runId: input.runId
    });

    await createK8sJob({
      name: `runtime-worker-${input.runId}`,
      image: input.runtime.image ?? "agent-runtime-worker:latest",
      env: {
        RUNTIME_MODE: "k8s",
        TASK_ID: input.taskId,
        RUN_ID: input.runId,
        AGENT_ID: input.agent.agentId,
        RUNTIME_ID: runtimeId,
        RUNTIME_TOKEN: runtimeToken,
        PLATFORM_API_BASE:
          "http://platform-server.default.svc.cluster.local:3000"
      },
      resources: {
        cpu: input.limits.cpu ?? 2,
        memoryMb: input.limits.memoryMb ?? 4096
      },
      timeoutSeconds: input.limits.timeoutSeconds
    });

    return {
      taskId: input.taskId,
      runId: input.runId,
      runtimeId,
      provider: "k8s",
      status: "starting"
    };
  }

  async sendControl(handle: RuntimeHandle, control: RuntimeControl) {
    await saveControlMessage(handle.runId, control);
  }

  async cancel(handle: RuntimeHandle) {
    await saveControlMessage(handle.runId, {
      type: "cancel"
    });

    await deleteK8sJob(handle.runtimeId);
  }

  async destroy(handle: RuntimeHandle) {
    await deleteK8sJob(handle.runtimeId);
  }

  async getStatus(handle: RuntimeHandle) {
    return getRuntimeStatus(handle.runId);
  }
}
```

---

## 21. 可靠性设计

事件上报需要保证：

```text
sequence
Idempotency-Key
本地 JSONL buffer
指数退避重试
heartbeat
run timeout
UNIQUE(run_id, sequence)
```

Runtime Worker 上报事件：

```http
POST /internal/runs/run_123/events
Idempotency-Key: run_123:42
```

数据库约束：

```sql
UNIQUE(run_id, sequence)
```

这样可以保证：

```text
重复事件不会重复写入
前端断线后可以续传
多 Agent 并行不会互相干扰
```

---

## 22. 安全设计

### 22.1 Runtime Token

每个 Run 一个 runtime token。

权限范围只允许访问当前 Run：

```text
GET    /internal/runs/{ownRunId}
POST   /internal/runs/{ownRunId}/events
POST   /internal/runs/{ownRunId}/heartbeat
GET    /internal/runs/{ownRunId}/controls
PATCH  /internal/runs/{ownRunId}
```

不允许访问：

```text
其他 run
其他用户
数据库
管理 API
其他 workspace
其他 sandbox
```

---

### 22.2 沙箱隔离

沙箱模式建议：

```text
一个 Run 一个容器 / Pod / VM
一个 Run 一个独立 workspace
任务结束销毁环境
只上传 artifact 和 event
```

不要挂载：

```text
宿主机 HOME
~/.ssh
~/.aws
~/.npmrc
生产 .env
docker.sock
平台数据库凭据
```

---

### 22.3 网络控制

沙箱 Runtime Worker 只需要访问：

```text
Platform Server internal API
模型 API
GitHub / npm / pypi 等必要白名单
对象存储上传地址
```

不应该访问：

```text
数据库
Redis
Kubernetes API
云厂商 metadata service
内网服务
其他用户 sandbox
```

---

## 23. 推荐目录结构

```text
src/
  platform/
    server.ts
    internal-api.ts

  users/
    UserService.ts

  workspaces/
    WorkspaceService.ts
    WorkspaceSpec.ts

  conversations/
    ConversationService.ts
    MessengerService.ts

  agents/
    AgentDefinition.ts
    AgentRegistry.ts

  tasks/
    TaskService.ts
    RunService.ts
    TaskStore.ts
    RunStore.ts

  runtime/
    RuntimeGateway.ts
    RuntimeProvider.ts
    RuntimeStartInput.ts
    RuntimeHandle.ts
    RuntimeControl.ts

    providers/
      LocalProcessRuntimeProvider.ts
      DockerRuntimeProvider.ts
      KubernetesRuntimeProvider.ts
      MicroVmRuntimeProvider.ts

    worker/
      RuntimeWorker.ts
      RuntimeClient.ts
      RuntimeEventEmitter.ts
      ControlPoller.ts
      WorkspaceManager.ts
      ArtifactCollector.ts

  adapters/
    AgentAdapter.ts

    claude-code/
      ClaudeCodeAdapter.ts
      mapClaudeToAGUI.ts

    codex/
      CodexAdapter.ts
      mapCodexToAGUI.ts

    custom/
      CustomAgentAdapter.ts

  events/
    RunEventEnvelope.ts
    EventStore.ts
    EventBus.ts

  agui/
    AGUIStream.ts
    AGUIStateProjector.ts

  artifacts/
    ArtifactStore.ts
    ArtifactUploader.ts
```

---

## 24. MVP 实现路径

### 第一步：统一 Agent Adapter 输出 AG-UI Event

```text
Claude Code SDK → ClaudeCodeAdapter → AG-UI Event
Codex SDK → CodexAdapter → AG-UI Event
```

---

### 第二步：实现 LocalProcessRuntimeProvider

```text
Platform Server
  → spawn Runtime Worker
    → Agent Adapter
      → Agent SDK
```

先在本地跑通完整链路。

---

### 第三步：让 Runtime Worker 走 internal API

本地 Worker 也通过：

```text
GET run config
POST events
POST heartbeat
GET controls
PATCH status
```

与 Platform Server 通信。

---

### 第四步：实现 DockerRuntimeProvider

```text
Platform Server
  → docker run Runtime Worker
```

验证：

```text
workspace mount
env 注入
runtime token
event 上报
artifact 上传
任务取消
```

---

### 第五步：实现 KubernetesRuntimeProvider

```text
Platform Server
  → create K8s Job / Pod
    → Runtime Worker
```

用于多用户云端环境。

---

### 第六步：高风险任务接 microVM

```text
Platform Server
  → MicroVmRuntimeProvider
    → Runtime Worker
```

用于不可信代码执行。

---

## 25. 最终定稿架构

```text
                            ┌────────────────────┐
                            │    AG-UI Client     │
                            └─────────┬──────────┘
                                      │
                                      │ AG-UI Stream
                                      ▼
┌────────────────────────────────────────────────────────────┐
│                      Platform Server                       │
│                                                            │
│  User / Workspace / Messenger / Task / Run / Event / Artifact│
│                                                            │
│  ┌────────────────┐      ┌──────────────────────────────┐  │
│  │ Agent Registry │      │      Runtime Gateway         │  │
│  └────────────────┘      └──────────────┬───────────────┘  │
│                                         │                  │
│  ┌────────────────┐      ┌──────────────▼───────────────┐  │
│  │ Event Store    │◄─────│       Runtime Provider       │  │
│  └────────────────┘      │ local / docker / k8s / vm    │  │
│                          └──────────────┬───────────────┘  │
└─────────────────────────────────────────┼──────────────────┘
                                          │
                                          │ start worker
                                          ▼
┌────────────────────────────────────────────────────────────┐
│                       Runtime Worker                       │
│                                                            │
│  no port / no HTTP server                                  │
│  calls Platform internal API                               │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │                  Agent Adapter                       │  │
│  │                                                      │  │
│  │  Claude Code SDK Event  ─┐                           │  │
│  │  Codex SDK Event        ─┼─→ AG-UI Event              │  │
│  │  Custom Agent Event     ─┘                           │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                            │
│  AG-UI Event → POST /internal/runs/{runId}/events          │
└────────────────────────────────────────────────────────────┘
```

---

## 26. 一句话总结

本平台采用：

```text
AG-UI Client
  → Platform Server
    → Runtime Gateway
      → Runtime Provider
        → Runtime Worker
          → Agent Adapter
            → Agent SDK
```

事件方向：

```text
Agent SDK
  → Agent Adapter
    → AG-UI Event
      → Runtime Worker
        → Platform Event Store
          → AG-UI Client
```

控制方向：

```text
AG-UI Client
  → Platform Server
    → Control Store
      → Runtime Worker polling
        → Agent Adapter / Agent SDK
```

核心原则：

```text
Platform Server 管控制
Runtime Worker 管执行
Agent Adapter 管 SDK 差异
AG-UI 作为统一事件协议
本地和沙箱都运行同一个 Runtime Worker
本地和沙箱只由不同 RuntimeProvider 启动
```
