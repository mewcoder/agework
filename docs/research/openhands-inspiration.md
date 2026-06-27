# OpenHands 对 AgeWork 的架构启示

> 从 OpenHands SDK / agent-canvas / app_server 源码和文档中提炼出对 AgeWork（TypeScript + NestJS + Prisma + AG-UI）有借鉴价值的设计。按优先级排列。

---

## 优先级定义

| 级别 | 含义 | 预期收益 |
|------|------|---------|
| **P0** | 核心架构升级，影响系统根基 | 高 |
| **P1** | 重要能力补充，显著提升竞争力 | 中高 |
| **P2** | 锦上添花，可在 P0/P1 稳定后推进 | 中 |
| **P3** | 长期愿景，需要前置条件 | 低（短期） |

---

## P0：核心架构升级

### 1. Event 系统：从 RunEvent 到领域事件

**现状**：AgeWork 的 `RunEvent` 表只记录 agent 运行时事件（tool 调用、消息等），没有统一的事件抽象层。Conversation 和 Run 的状态变化散落在 Service 方法中。

**OpenHands 做法**：
- 所有系统事实都是 `Event`（不可变、append-only）
- `source` 三选一：`user` / `agent` / `environment`
- Action + Observation 通过 `tool_call_id` 配对
- State = replay(events) —— 状态可从事件流重建

**建议**：
```typescript
// packages/shared/src/events.ts
interface DomainEvent {
  id: string;
  timestamp: string;
  source: 'user' | 'agent' | 'environment';
  kind: string; // discriminator
  conversationId: string;
  runId?: string;
}

interface MessageEvent extends DomainEvent {
  kind: 'message';
  role: 'user' | 'assistant';
  content: MessageContent[];
}

interface ActionEvent extends DomainEvent {
  kind: 'action';
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
}

interface ObservationEvent extends DomainEvent {
  kind: 'observation';
  toolName: string;
  toolCallId: string;
  output: unknown;
}
```

**收益**：
- 统一事件模型，简化前后端协议
- 支持事件回放和状态重建
- 为未来的 Hook 系统、审计日志打基础
- 天然兼容 AG-UI 协议

**实施难度**：中（需要迁移现有 RunEvent 表结构）

---

### 2. Agent 协议接口：step(state) → result

**现状**：AgeWork 的 `AgentRunHandler` 直接调用各 adapter（Claude、Codex），逻辑耦合在 handler 中。新增 agent 类型需要修改 handler 代码。

**OpenHands 做法**：
- Agent 只需实现一个接口：`step(state) → AgentStepResult`
- 平台对 Agent 实现一无所知——只调 step()，收 events
- ACPAgent 把整个对话外包给远端进程，自己只做事件翻译

**建议**：
```typescript
// packages/adapters/src/agent-interface.ts
interface AgentAdapter {
  step(state: ConversationState): Promise<AgentStepResult>;
  // 可选：恢复、中断、配置
  resume?(sessionId: string): Promise<void>;
  interrupt?(): Promise<void>;
  configure?(config: AgentConfig): Promise<void>;
}

interface AgentStepResult {
  events: DomainEvent[];
  status: 'running' | 'finished' | 'error' | 'stuck';
}
```

**收益**：
- 新增 agent 只需实现接口，不改核心代码
- 统一测试框架（mock agent 实现接口即可）
- 为 ACP 模式打基础

**实施难度**：中（需要重构 AgentRunHandler）

---

### 3. Conversation 主循环：加锁 + 状态机

**现状**：AgeWork 的 Conversation 状态（`activeRunStatus`）分散在多个 Service 方法中，没有统一的状态机。并发控制靠数据库行锁。

**OpenHands 做法**：
- `ConversationExecutionStatus` 8 态枚举
- FIFOLock 保证同一时刻只有一个线程写 state
- 主循环：`while status == RUNNING: step → 写 event → 状态转移`
- stuck 检测：扫描最近 20 个事件，检测重复模式

**建议**：
```typescript
// apps/api/src/conversations/conversation-state-machine.ts
enum ConversationStatus {
  IDLE = 'idle',
  RUNNING = 'running',
  PAUSED = 'paused',
  WAITING_FOR_CONFIRMATION = 'waiting_for_confirmation',
  FINISHED = 'finished',
  ERROR = 'error',
  STUCK = 'stuck',
}

class ConversationStateMachine {
  private status: ConversationStatus = ConversationStatus.IDLE;
  private lock: AsyncMutex;

  async run(agent: AgentAdapter): Promise<void> {
    await this.lock.acquire();
    try {
      this.status = ConversationStatus.RUNNING;
      while (this.status === ConversationStatus.RUNNING) {
        const result = await agent.step(this.state);
        await this.processEvents(result.events);
        this.checkTransitions();
      }
    } finally {
      this.lock.release();
    }
  }
}
```

**收益**：
- 状态转移集中管理，不会出现非法状态
- 并发安全，不会出现"半步"状态
- stuck 检测避免 agent 死循环

**实施难度**：中高（需要重构 Conversation 模块）

---

## P1：重要能力补充

### 4. Hook 系统：生命周期拦截

**现状**：AgeWork 没有 Hook 机制。tool 执行前后无法插入自定义逻辑（安全检查、日志、审批）。

**OpenHands 做法**：
- 6 种 Hook 事件：`PreToolUse` / `PostToolUse` / `UserPromptSubmit` / `SessionStart` / `SessionEnd` / `Stop`
- Hook 可以 `allow` 或 `deny` 操作
- Hook 配置从 `.openhands/hooks.json` 加载
- Hook 执行器支持 shell 脚本和 LLM 调用

**建议**：
```typescript
// packages/shared/src/hooks.ts
enum HookEventType {
  PRE_TOOL_USE = 'PreToolUse',
  POST_TOOL_USE = 'PostToolUse',
  USER_PROMPT_SUBMIT = 'UserPromptSubmit',
  SESSION_START = 'SessionStart',
  SESSION_END = 'SessionEnd',
}

interface HookEvent {
  eventType: HookEventType;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResponse?: Record<string, unknown>;
  message?: string;
  sessionId?: string;
  workingDir?: string;
}

interface HookDecision {
  allow: boolean;
  reason?: string;
}
```

**收益**：
- 安全检查（危险命令拦截）
- 审计日志（tool 调用记录）
- 自动化（session 开始/结束时触发脚本）
- 与 AgeWork 的权限系统集成

**实施难度**：中（需要在 tool 执行流程中插入 hook 点）

---

### 5. Tool 注册表：声明式工具定义

**现状**：AgeWork 的 tool 定义散落在各 adapter 中，没有统一的注册机制。新增 tool 需要修改多个文件。

**OpenHands 做法**：
- `ToolSpec` 定义工具 schema（name、description、parameters）
- `ToolRegistry` 管理所有注册的工具
- 工具可以是内置的，也可以从 MCP server 动态加载
- `DefaultPreset` 一次性注册一组常用工具

**建议**：
```typescript
// packages/shared/src/tools.ts
interface ToolDefinition {
  name: string;
  description: string;
  parameters: JSONSchema;
  // 执行器在后端注册
}

interface ToolRegistry {
  register(tool: ToolDefinition): void;
  get(name: string): ToolDefinition | undefined;
  list(): ToolDefinition[];
  // 支持 preset
  loadPreset(preset: string): void;
}
```

**收益**：
- 工具定义集中管理
- 支持动态加载（MCP server）
- 前端可以展示工具列表和 schema
- 为工具市场打基础

**实施难度**：低中（需要定义接口，逐步迁移现有工具）

---

### 6. Stuck 检测：避免 agent 死循环

**现状**：AgeWork 没有 stuck 检测。agent 可能陷入重复操作而用户无法察觉。

**OpenHands 做法**：
- 扫描最近 20 个事件
- 检测 4 种模式：
  1. 重复 action-observation 循环
  2. 重复 action-error 循环
  3. Agent 独白（无人参与的消息序列）
  4. 交替 action-observation 模式
- 超过阈值 → 状态转为 STUCK

**建议**：
```typescript
// apps/api/src/conversations/stuck-detector.ts
class StuckDetector {
  private readonly MAX_EVENTS_TO_SCAN = 20;
  
  isStuck(events: DomainEvent[]): boolean {
    const recent = events.slice(-this.MAX_EVENTS_TO_SCAN);
    return (
      this.detectRepeatingActionObservation(recent) ||
      this.detectRepeatingActionError(recent) ||
      this.detectMonologue(recent) ||
      this.detectAlternatingPattern(recent)
    );
  }
}
```

**收益**：
- 自动检测 agent 死循环
- 提升用户体验（及时中断无用操作）
- 节省 token 和费用

**实施难度**：低（纯逻辑，不涉及数据结构变更）

---

## P2：锦上添花

### 7. 数据库分层：事件流与元数据分离

**现状**：AgeWork 的 `RunEvent` 表既存事件又存元数据，没有明确分层。

**OpenHands 做法**：
- 4 层金字塔：JSONL（SDK）→ JSON 文件（agent-server）→ SQL（app_server）→ PostgreSQL（enterprise）
- 核心不变量：**事件流永不入库**——始终是 JSONL，DB 只存元数据

**建议**：
- 短期：保持现有 SQL 表，但明确区分"事件数据"和"元数据"
- 中期：考虑将高频事件（tool 调用细节）移到文件系统或专用存储
- 长期：如果需要多租户，参考 OpenHands enterprise 层的 44 张表设计

**收益**：
- 降低数据库压力
- 事件流可以独立备份和回放
- 为多租户打基础

**实施难度**：中高（需要数据迁移）

---

### 8. 多 Agent 委派：子 Agent 系统

**现状**：AgeWork 的 `apps/worker` 是独立的 agent worker，但没有子 agent 委派机制。

**OpenHands 做法**：
- `subagent/` 模块：主 agent 可以委派子任务给子 agent
- 子 agent 有独立的 conversation 和 state
- 通过 `task` 工具触发委派

**建议**：
```typescript
// packages/shared/src/subagent.ts
interface SubagentTask {
  id: string;
  parentConversationId: string;
  task: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: unknown;
}
```

**收益**：
- 支持复杂任务分解
- 多 agent 并行执行
- 任务跟踪和状态管理

**实施难度**：中高（需要设计子 agent 生命周期）

---

### 9. Skills 市场：可复用的能力包

**现状**：AgeWork 没有 skills 概念。agent 的能力完全由 adapter 和 tool 决定。

**OpenHands 做法**：
- Skills 是可复用的 prompt + tool 组合
- 支持 progressive disclosure（按需加载）
- 有 marketplace 概念（远程加载技能）

**建议**：
```typescript
// packages/shared/src/skills.ts
interface Skill {
  id: string;
  name: string;
  description: string;
  prompt: string;
  tools: string[];
  // 渐进式披露
  triggers?: string[]; // 触发条件
}
```

**收益**：
- 可复用的 agent 能力包
- 用户可以分享和发现技能
- 降低 prompt 工程成本

**实施难度**：中（需要设计加载和触发机制）

---

### 10. 安全分析器：危险操作拦截

**现状**：AgeWork 没有安全分析机制。agent 的 tool 调用没有安全审查。

**OpenHands 做法**：
- `security/` 模块：分析 tool 调用的风险等级
- Shell AST 解析：检测危险命令（rm -rf、curl | bash 等）
- LLM 辅助分析：用 LLM 判断操作是否安全
- ConfirmationPolicy：根据风险等级决定是否需要用户确认

**建议**：
```typescript
// apps/api/src/security/security-analyzer.ts
interface SecurityAnalyzer {
  analyze(toolName: string, input: Record<string, unknown>): SecurityAssessment;
}

interface SecurityAssessment {
  risk: 'low' | 'medium' | 'high' | 'critical';
  requiresConfirmation: boolean;
  reason?: string;
}
```

**收益**：
- 防止危险操作（删除文件、执行恶意命令）
- 提升用户信任度
- 满足企业安全合规要求

**实施难度**：中（需要实现 shell 解析和风险评估逻辑）

---

## P3：长期愿景

### 11. ACP 模式：标准化 Agent 通信

**现状**：AgeWork 的 adapter 直接调用各 agent 的 API（Claude API、Codex API），没有标准化的通信协议。

**OpenHands 做法**：
- ACP（Agent-Client Protocol）：标准的 agent 通信协议
- 通过 stdio + JSON-RPC 2.0 与 agent 通信
- 支持 session 恢复、中断、配置切换
- 三家 provider（Claude、Codex、Gemini）统一接入

**建议**：
- 长期考虑支持 ACP 协议
- 短期可以参考 ACP 的设计思想，统一 adapter 接口

**收益**：
- 接入更多 agent（任何支持 ACP 的 agent）
- 标准化通信，降低维护成本
- 社区生态支持

**实施难度**：高（需要实现 ACP 协议栈）

---

### 12. Workspace 抽象：隔离执行环境

**现状**：AgeWork 的 workspace 是本地文件系统路径，没有隔离机制。

**OpenHands 做法**：
- `workspace/` 模块：抽象执行环境
- 支持 local / docker / apptainer / cloud / remote
- 每种实现都遵循 `BaseWorkspace` 协议
- agent 不关心在哪里执行，只关心接口

**建议**：
```typescript
// packages/shared/src/workspace.ts
interface WorkspaceAdapter {
  execute(command: string): Promise<ExecutionResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  // ...
}
```

**收益**：
- 支持多种执行环境（本地、Docker、远程）
- 安全隔离（agent 不能访问宿主机）
- 为云部署打基础

**实施难度**：高（需要实现多种 workspace 适配器）

---

## 实施路线图

```
Phase 1（1-2 月）：P0 核心架构
├── 1.1 定义 DomainEvent 接口（packages/shared）
├── 1.2 定义 AgentAdapter 接口（packages/adapters）
├── 1.3 实现 ConversationStateMachine（apps/api）
└── 1.4 迁移现有代码到新架构

Phase 2（2-3 月）：P1 能力补充
├── 2.1 实现 Hook 系统
├── 2.2 实现 ToolRegistry
├── 2.3 实现 StuckDetector
└── 2.4 集成安全检查

Phase 3（3-6 月）：P2 锦上添花
├── 3.1 数据库分层优化
├── 3.2 子 Agent 系统
├── 3.3 Skills 市场
└── 3.4 安全分析器

Phase 4（6+ 月）：P3 长期愿景
├── 4.1 ACP 协议支持
├── 4.2 Workspace 抽象
└── 4.3 多租户支持
```

---

## 一句话总结

> **OpenHands 的核心设计思想：Event（不可变 log）+ State（可重建快照）+ Conversation（主循环）+ Agent（可插拔接口）。**
>
> AgeWork 应该优先建立这四个核心抽象，然后在此基础上扩展 Hook、Tool、Security 等能力。
>
> **最值得借鉴的一点：平台对 Agent 实现一无所知，只调 step()，收 events。** 这种松耦合设计让系统可以支持任意 agent，而不被任何特定 agent 绑定。
