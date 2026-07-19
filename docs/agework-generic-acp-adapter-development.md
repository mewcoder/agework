# AgeWork 通用 ACP Adapter 开发文档

> 文档状态：Implementation Ready  
> 目标仓库：`mewcoder/AgeWork`  
> 基准分支：`refactor`  
> 文档日期：2026-07-12  
> 首个接入 Agent：OpenCode（`opencode acp`）  
> 目标读者：负责实施的 AI Agent / 开发者

---

## 0. 给实施 AI 的强制执行指令

开始修改前，依次完成：

1. 阅读仓库根目录：
   - `CLAUDE.md`
   - `CONTEXT-MAP.md`
2. 阅读相关 Context 与 ADR：
   - `apps/runtime/src/worker/CONTEXT.md`
   - `apps/runtime/docs/adr/0002-worker-runner-independent-entry.md`
   - `apps/server/src/run/docs/adr/0001-question-interrupt-terminal-model.md`
   - `apps/runtime/docs/adr/0001-sdk-external-plus-real-npm-install.md`
3. 阅读现有实现：
   - `apps/runtime/src/worker/agent/index.ts`
   - `apps/runtime/src/worker/runner-manager.ts`
   - `packages/adapters/src/claude/business/claude-agent.adapter.ts`
   - `packages/adapters/src/codex/base/adapter.ts`
   - `packages/shared/src/common/index.ts`
   - `packages/shared/src/protocol/channel.ts`
   - `packages/shared/src/cli/cli-resolver.ts`
   - `apps/server/src/agent/**`
   - `apps/server/src/runtime/**`
   - `apps/server/src/model-provider/**`
   - `apps/web/src/components/assistant-ui/**`
4. 使用官方 `@agentclientprotocol/sdk`，不要自行实现 JSON-RPC parser。
5. 按本文 Ticket 顺序实施，每个 Ticket 通过精准测试后再进入下一项。
6. 不修改 Claude/Codex 的运行行为，不借机重构整个 Adapter 层。
7. 不把 `acp` 加成用户可见 `AgentType`；第一阶段用户可见类型是 `opencode`。
8. 不同时使用 OpenCode SDK/SSE 驱动同一个 Session。本任务唯一运行协议是 ACP。

完成定义不是“OpenCode 能返回一句文本”，而是：

```text
进程启动、协议握手、Session 新建/恢复、流式消息、Reasoning、工具调用、
Plan、权限审批、取消、错误、Session ID 持久化、Raw Trace、进程回收、
Native/Container Runtime 全链路均可验证。
```

---

## 1. 背景与决策

AgeWork 当前的 Agent 路径是：

```text
assistant-ui
  -> AG-UI
    -> Server Run
      -> Worker
        -> Runner（单次平台 Run）
          -> Agent Adapter
            -> Claude Agent SDK / Codex SDK
```

新增 Agent 时，如果每个 Agent 都实现一套进程管理、会话恢复、权限桥接和 AG-UI 转换，维护成本会线性增长。

ACP 已标准化：

- `initialize` 能力协商。
- `session/new`、`session/load`、`session/resume`。
- `session/prompt` 与 `session/update`。
- Agent message、thought、tool call、plan。
- `session/request_permission`。
- `session/cancel`。
- Session config options、commands、mode。
- Client filesystem、terminal 能力。

本任务采用以下策略：

```text
Claude  -> Claude Agent SDK      -> First-class
Codex   -> Codex 官方接入        -> First-class
OpenCode-> 通用 ACP Adapter      -> ACP 标杆实现
未来 Agent -> 通用 ACP Adapter   -> Compatible
```

OpenCode 官方提供 `opencode acp`，通过 stdio 上的 JSON-RPC 与 Client 通信；官方说明 ACP 路径支持内置工具、自定义工具、MCP、项目规则、Agent 和权限系统。目前已知 `/undo`、`/redo` 等部分内置命令不支持。

### 1.1 本文最终决策

1. 在 `packages/agent-acp/src` 新建通用 ACP Client Adapter。
2. 使用官方包 `@agentclientprotocol/sdk`，首版锁定精确版本，不使用 `^`。
3. 首版只实现 stdio + NDJSON Transport。
4. 每个 AgeWork Runner 启动一个 ACP Agent 子进程。
5. 平台一次新 Run 会重新启动 ACP 进程，通过保存的 ACP Session ID 执行 `session/load`/`session/resume`。
6. OpenCode 是第一个 `AcpAgentProfile`，命令为 `opencode acp`。
7. 用户选择的是 `opencode`，ACP 只是内部实现细节。
8. ACP 原始事件先转换为 AG-UI，不新增第二套前端协议。
9. 权限请求复用当前 AG-UI terminal interrupt + Agent pause 模型。
10. 第一阶段不实现 Client 托管的 filesystem/terminal；初始化时不声明未实现的 capability。

---

## 2. 目标与非目标

### 2.1 目标

- 建立可复用的 ACP 进程与连接层。
- 建立 capability-driven 的 Session 生命周期。
- 建立完整的 ACP → AG-UI 事件映射。
- 支持 ACP 权限审批和 AgeWork interrupt resume。
- 支持取消当前 Turn。
- 支持 Session ID 持久化与跨 Runner 恢复。
- 支持 OpenCode 系统配置。
- 支持 OpenCode 自定义 OpenAI-compatible Provider 配置。
- 支持 Native 与 Container Runtime。
- 为后续 Qwen、Gemini、Goose 等 Agent 保留扩展点。

### 2.2 非目标

本次不实现：

- OpenCode SDK/HTTP/SSE 接入。
- OpenCode `/undo`、`/redo`。
- OpenCode Session share/fork/revert 管理页面。
- 通用 ACP Agent 配置数据库和用户自定义命令 UI。
- ACP HTTP、WebSocket Transport。
- Browser 直接连接 ACP Agent。
- 多 Agent 编排。
- Client 托管终端。
- Client 托管文件读写。
- 修改 Claude/Codex 现有 Adapter。
- 动态化全部 `AgentType`。

---

## 3. 关键领域建模

### 3.1 不要把协议当 AgentType

错误：

```ts
type AgentType = "claude" | "codex" | "acp";
```

正确：

```ts
type AgentType = "claude" | "codex" | "opencode";
```

原因：

- 用户选择的是 OpenCode，不是 ACP。
- Conversation 需要稳定记录实际 Agent。
- 日志、Session、模型配置、CLI 安装均按 Agent 区分。
- 多个 ACP Agent 不能共享一个含糊的 `acp` 类型。

### 3.2 新概念

#### `AcpAgentProfile`

描述某个具体 ACP Agent 如何启动和配置，不实现协议逻辑。

```ts
export interface AcpAgentProfile {
  agentType: AgentType;
  displayName: string;
  command: string;
  args: readonly string[];
  npmPackage?: string;
  binaryName: string;
  buildEnv(input: AcpProfileEnvInput): Record<string, string>;
  normalizeCapabilities?(capabilities: unknown): AcpNormalizedCapabilities;
}
```

#### `AcpProcess`

只负责子进程生命周期和字节流，不理解 Session/AG-UI。

#### `AcpConnection`

包装官方 SDK Client connection，负责 initialize 与协议调用。

#### `AcpSessionController`

负责 new/load/resume/prompt/cancel/close 和 session update 路由。

#### `AcpToAguiMapper`

纯转换层，不启动进程、不访问 Server、不持久化。

#### `AcpPermissionBridge`

把 `session/request_permission` 转换成 AgeWork interrupt，并等待 `approval_resolved`。

### 3.3 ID 映射

| AgeWork | ACP | 说明 |
|---|---|---|
| `conversationId` / AG-UI `threadId` | `sessionId` | 跨平台 Run 保存 |
| AgeWork `runId` | Prompt Turn | ACP 没要求持久 Turn ID |
| AG-UI `messageId` | ACP messageId 或生成 ID | 优先保留 ACP ID |
| AG-UI `toolCallId` | `toolCallId` | 原样保留 |
| AG-UI `interruptId` | 本地生成 ID | metadata 保存 ACP permission options |

ACP `sessionId` 必须通过现有 `agent.sessionId` Custom Event 上报，复用 Server 的 `onAgentSessionId` 持久化链路。

---

## 4. 目标架构

```text
Server
  -> Worker command/run channel
    -> Runner（一次平台 Run）
      -> AcpAgentAdapter
        -> AcpProcess
          -> opencode acp
        -> @agentclientprotocol/sdk
          -> initialize
          -> session/new | load | resume
          -> session/prompt
          <- session/update
          <- session/request_permission
        -> AcpToAguiMapper
          -> AG-UI Events
            -> Server persistence/SSE
              -> assistant-ui
```

### 4.1 为什么进程属于 Runner

遵守 `apps/runtime/src/worker/CONTEXT.md`：

- Worker 只管理 Runner，不运行 Agent。
- Runner 才是单次运行 Agent 的执行单元。
- ACP 子进程继承 Runner 所在 Runtime 的 workspace、凭证和工具环境。
- Runner 退出时必须回收 ACP 子进程树。
- Worker 不持有 ACP Session 内存状态。

### 4.2 平台 Run 与 ACP Session

```text
首次 Run
  spawn agent
  initialize
  session/new -> sessionId
  persist sessionId
  session/prompt
  turn ends
  close process

后续 Run
  spawn agent
  initialize
  if resume supported -> session/resume
  else if load supported -> session/load
  else -> session/new + history fallback（本次不实现）
  session/prompt
```

若已有 `agentSessionId`，但 Agent 同时不支持 resume/load，必须返回明确错误，不允许静默创建新 Session 导致上下文丢失。

---

## 5. 目录设计

新增：

```text
packages/agent-acp/src/
├── index.ts
├── plugin.ts
├── adapter.ts
├── adapter.spec.ts
├── create-adapter.ts
├── engine/
│   ├── client.ts
│   ├── session.ts
│   ├── process.ts
│   ├── stdio-stream.ts
│   ├── capabilities.ts
│   ├── errors.ts
│   ├── safe-env.ts
│   └── sdk.ts
├── bridge/
│   ├── to-agui.ts
│   ├── to-agui.spec.ts
│   ├── content.ts
│   ├── tools.ts
│   ├── permission.ts
│   ├── permission.spec.ts
│   └── pending-controls.ts
├── agents/
│   ├── types.ts
│   ├── registry.ts
│   ├── opencode/
│   │   ├── index.ts
│   │   ├── profile.ts
│   │   └── profile.spec.ts
│   └── pi/
│       ├── index.ts
│       ├── profile.ts
│       └── profile.spec.ts
└── testing/
    ├── fake-acp-agent.ts
    ├── fake-acp-agent.script.mjs
    └── fake-agent-app.ts
```

需要修改：

```text
packages/adapters/package.json
packages/adapters/src/index.ts
apps/runtime/src/worker/agent/index.ts
packages/shared/src/common/index.ts
packages/shared/src/protocol/channel.ts
packages/shared/src/cli/cli-resolver.ts
apps/runtime/sdk-deps/package.json
apps/runtime/scripts/install-sdk-deps.mjs
apps/server/src/runtime/**
apps/server/src/model-provider/**
apps/server/src/agent/**
apps/web/src/** agent selector / labels / icons
```

不要把 ACP 代码放入：

- `apps/runtime/src/worker`：Worker 只选择 Driver。
- `apps/server`：Server 不应理解 ACP wire event。
- `packages/shared/protocol`：不要把 ACP 类型变成 AgeWork 跨进程协议。

---

## 6. 依赖与版本策略

在 `packages/adapters/package.json` 增加：

```json
{
  "dependencies": {
    "@agentclientprotocol/sdk": "1.2.1"
  }
}
```

要求：

- 锁精确版本。
- 升级单独 PR。
- 升级时运行全部 ACP fixtures 和 OpenCode smoke test。
- 不导入 `experimental/http-client`、`experimental/ws-client`。
- 仅使用稳定 stdio/NDJSON API。

OpenCode CLI：

```text
npm package: opencode-ai
binary: opencode / opencode.cmd
args: acp
```

运行时 CLI 必须真实安装，遵守 `apps/runtime/docs/adr/0001`，不得将 OpenCode bundle 进 Runtime 产物。

---

## 7. AcpAgentProfile

### 7.1 Profile 接口

```ts
export type AcpProfileEnvInput = {
  source: "system" | "custom";
  baseEnv: Record<string, string>;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  extraConfig?: Record<string, string>;
};

export type AcpLaunchSpec = {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
};
```

Profile 只做：

- 命令与参数。
- 安装包和 binary 名称。
- 环境变量。
- Agent 特有 capability 修正。

Profile 不做：

- spawn。
- JSON-RPC。
- Session lifecycle。
- AG-UI 映射。
- Server 通信。

### 7.2 OpenCode Profile

```ts
export const openCodeAcpProfile: AcpAgentProfile = {
  agentType: "opencode",
  displayName: "OpenCode",
  command: "opencode",
  args: ["acp"],
  npmPackage: "opencode-ai",
  binaryName: "opencode",
  buildEnv(input) {
    return buildOpenCodeEnv(input);
  },
};
```

#### 系统配置模式

- 继承安全环境变量。
- 允许 OpenCode 读取用户 `auth.json`、全局配置与项目 `opencode.json(c)`。
- 禁止把 Worker token、Server URL 等私有变量传给子进程。
- 注入 `OPENCODE_DISABLE_AUTOUPDATE=true`，运行环境中的 CLI 版本由 AgeWork 管理。

#### 自定义 Provider 模式

通过 `OPENCODE_CONFIG_CONTENT` 注入临时配置，禁止写入用户全局配置：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "_agework/<model-id>",
  "provider": {
    "_agework": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "AgeWork",
      "options": {
        "baseURL": "<baseUrl>",
        "apiKey": "{env:AGEWORK_OPENCODE_API_KEY}"
      },
      "models": {
        "<model-id>": { "name": "<model-id>" }
      }
    }
  }
}
```

环境变量：

```text
OPENCODE_CONFIG_CONTENT=<json>
AGEWORK_OPENCODE_API_KEY=<apiKey>
OPENCODE_DISABLE_AUTOUPDATE=true
```

注意：

- 如果目标 Provider 使用 Responses API，Profile 应允许 `extraConfig.providerNpm = "@ai-sdk/openai"`；默认才是 `@ai-sdk/openai-compatible`。
- `extraConfig` 必须白名单解析，禁止直接把未知对象 spread 到 OpenCode 配置。
- Raw trace 必须脱敏 API Key 和 Authorization header。

---

## 8. AcpProcess 设计

### 8.1 职责

```ts
export interface AcpProcessHandle {
  stdin: WritableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
  stderr: AsyncIterable<string>;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  terminate(reason?: string): Promise<void>;
}
```

实现要求：

- `spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] })`。
- Windows 支持 `.cmd` 路径。
- stdout 只用于 ACP wire，禁止混入日志。
- stderr 作为日志/trace，不按 JSON 解析。
- 启动超时默认 10 秒。
- 单次 RPC/Prompt timeout 单独配置，不共用启动 timeout。
- 退出顺序：close connection → SIGTERM → grace timeout → SIGKILL。
- Windows 使用进程树终止方案，不能只杀父进程留下 Agent 子进程。
- abort、normal completion、protocol failure 都必须进入幂等 cleanup。

### 8.2 stdout 污染

若 stdout 出现无法解析的非 ACP 数据：

- 记录最多 2KB 的脱敏摘要。
- 以 `ACP_PROTOCOL_ERROR` 终止本次 Run。
- 不尝试跳过任意行继续运行，避免请求/响应错位。

### 8.3 stderr

- 按行读取。
- 写入 `sdk.raw` trace，名称 `sdk.acp.stderr`。
- 默认日志级别 debug。
- 进程失败时保留最后 50 行用于错误诊断。

---

## 9. 官方 SDK 连接

参考形态：

```ts
import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

const stream = acp.ndJsonStream(
  Writable.toWeb(child.stdin),
  Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
);
```

Client 注册：

```ts
const app = acp
  .client({ name: "agework", version: AGEWORK_VERSION })
  .onRequest(acp.methods.client.session.requestPermission, handlePermission)
  .onNotification(acp.methods.client.session.update, handleSessionUpdate);
```

具体 API 以锁定版本 TypeScript 类型为准；不得 `as any` 绕过协议变化。

### 9.1 Initialize

首版声明的 Client capability 必须最小化：

```ts
const init = await ctx.request(acp.methods.agent.initialize, {
  protocolVersion: acp.PROTOCOL_VERSION,
  clientInfo: { name: "agework", version: AGEWORK_VERSION },
  clientCapabilities: {},
});
```

禁止虚报：

- `fs.readTextFile`
- `fs.writeTextFile`
- `terminal`

理由：OpenCode 自己执行文件和终端工具，AgeWork 第一阶段不需要接管。

### 9.2 Capability Snapshot

初始化结果保存为：

```ts
export type AcpNormalizedCapabilities = {
  protocolVersion: number;
  loadSession: boolean;
  resumeSession: boolean;
  closeSession: boolean;
  listSessions: boolean;
  deleteSession: boolean;
  promptCapabilities: {
    image: boolean;
    audio: boolean;
    embeddedContext: boolean;
  };
  sessionConfig: boolean;
  modes: boolean;
  commands: boolean;
  mcpHttp: boolean;
  mcpSse: boolean;
};
```

未知字段保存在 Raw Trace，不进入业务判断。

### 9.3 协议版本不兼容

- 初始化失败不得降级成 CLI 文本解析。
- 返回 `ACP_VERSION_UNSUPPORTED`。
- 错误中带 AgeWork SDK 版本、请求协议版本、Agent 返回版本、Agent CLI 版本（可获得时）。

---

## 10. Session 生命周期

### 10.1 创建

```ts
session/new({
  cwd: runtimePath,
  mcpServers: [],
})
```

要求：

- `cwd` 必须是 Runtime 内绝对路径。
- `cwd` 必须与 RunConfig `runtimePath` 相同。
- 获取 `sessionId` 后立即 emit `agent.sessionId` Custom Event，再发送 prompt。
- 即使 Prompt 后续失败，Session ID 仍应保存，便于诊断和恢复。

### 10.2 恢复优先级

有 `forwardedProps.agentSessionId` 时：

```text
1. agentCapabilities.sessionCapabilities.resume -> session/resume
2. agentCapabilities.loadSession                 -> session/load
3. 否则                                           -> 明确失败
```

`session/load` 可能回放历史 `session/update`。AgeWork Server 已有历史消息，必须设置 `replayPhase=true`：

- 回放事件写 Raw Trace。
- 不再次 emit 成 AG-UI 历史消息。
- load 完成后切换 `replayPhase=false`。

这样避免刷新/后续 Run 时历史重复。

### 10.3 Session ID 失效

若 load/resume 返回 session not found：

- 第一阶段不自动新建。
- Run 失败，错误码 `ACP_SESSION_NOT_FOUND`。
- 提示用户创建新 Conversation。

静默新建会让用户误以为仍有上下文，禁止这样做。

### 10.4 Turn 完成

`session/prompt` 最终响应包含 stop reason。映射：

| ACP Stop Reason | AG-UI |
|---|---|
| 正常结束 | `RUN_FINISHED` |
| cancelled | `RUN_FINISHED`，result 标记 cancelled，平台 cancel 通道负责状态 |
| max tokens / limit | `RUN_FINISHED`，result 携带 stopReason |
| error | `RUN_ERROR` |

最终响应到达前不得 emit 普通 `RUN_FINISHED`。

### 10.5 关闭

- 若 Agent 支持 `session/close`，只在 Conversation 明确删除/关闭时使用。
- 普通 Turn 完成不要 close Session，否则无法恢复。
- 普通 Runner cleanup 仅关闭连接和子进程。

---

## 11. 输入转换

### 11.1 AG-UI Input → ACP ContentBlock

首版支持：

- 文本消息。
- 图片 URL/Data URL（仅当 Agent capability 支持 image）。
- 文件/资源引用（仅当 capability 支持 embedded context）。

不支持的 content：

- 明确返回 `ACP_CONTENT_UNSUPPORTED`。
- 不静默丢弃附件。

### 11.2 Prompt 提取

现有 `RunAgentInput` 可能带完整 messages。ACP Session 已有历史，发送时只取当前用户新增内容；禁止每一轮重放全部 messages。

规则：

1. 找最后一条未发送的 user message。
2. `resume[]` 不作为普通 prompt 文本发送。
3. 若是 permission resume，只解开原 `session/request_permission` Promise，不调用第二次 `session/prompt`。
4. 空 prompt 拒绝。

### 11.3 Session Config

首版：

- 初始化/Session update 记录 Agent 发布的 config options。
- 若 RunConfig 指定 model，匹配 `model` config option 后设置。
- 不硬编码 OpenCode 私有 JSON-RPC 方法。
- 优先使用 Session Config Options，不新增依赖即将废弃的专用 mode API。

如果 OpenCode 没通过 ACP 暴露目标 model，系统配置模式使用 OpenCode 自己的默认配置；自定义配置模式由 `OPENCODE_CONFIG_CONTENT.model` 指定。

---

## 12. ACP → AG-UI 映射

### 12.1 Run 边界

Prompt 前：

```ts
{ type: EventType.RUN_STARTED, threadId, runId }
```

正常结束：

```ts
{
  type: EventType.RUN_FINISHED,
  threadId,
  runId,
  result: { stopReason, agent: "opencode", protocol: "acp" }
}
```

### 12.2 Agent Message

ACP：`agent_message_chunk`

AG-UI：

```text
TEXT_MESSAGE_START
TEXT_MESSAGE_CONTENT（delta）
TEXT_MESSAGE_END
```

要求：

- 以 ACP messageId 为 AG-UI messageId；缺失时生成稳定本地 ID。
- 同一 messageId 的多个 chunk 共用一次 START/END。
- Turn 结束时补齐所有未结束 Message。
- 非文本 ContentBlock 交给 content mapper，不 stringify 整个对象。

### 12.3 Thought / Reasoning

ACP：`agent_thought_chunk`

AG-UI：优先使用仓库现有 Reasoning 事件类型；若当前 AG-UI 版本无标准事件，沿用 Claude/Codex 已使用的 Custom/Tool 表达，不新增前端私有协议。

要求：

- Reasoning 与最终文本分开。
- 不把 thought 拼入 assistant text。
- messageId 稳定。
- 支持增量。

### 12.4 User Message Replay

ACP：`user_message_chunk`

- `session/load` replay 阶段忽略业务 emit。
- 正常 prompt 阶段通常也不回写，因为用户消息已由前端持久化。
- 只写 Raw Trace。

### 12.5 Tool Call

ACP `tool_call`：

```text
TOOL_CALL_START
TOOL_CALL_ARGS（rawInput）
```

ACP `tool_call_update`：

```text
pending/in_progress -> 保持开放，必要时 Custom 状态更新
completed           -> TOOL_CALL_RESULT + TOOL_CALL_END
failed              -> TOOL_CALL_RESULT(error) + TOOL_CALL_END
```

字段映射：

| ACP | AG-UI |
|---|---|
| `toolCallId` | `toolCallId` |
| `title` | 展示名称/metadata |
| `kind` | tool 分类/icon metadata |
| `rawInput` | args JSON |
| `rawOutput` | result JSON |
| `content` | result content |
| `locations` | metadata.locations |
| `status` | 生命周期 |

Tool 名称策略：

```ts
const toolName = normalizeToolName(update.kind, update.title);
```

- 优先稳定 `kind`：read/edit/delete/move/search/execute/think/fetch/other。
- title 只用于展示，不能作为唯一协议判断依据。
- unknown kind 映射 `acp_tool`，保留原始值。

### 12.6 Tool Update 乱序

若先收到 `tool_call_update` 再收到 `tool_call`：

- 创建占位 Tool State。
- emit START。
- 后续 `tool_call` 到达时补 title/kind/input。

若 Turn 结束仍未完成：

- cancelled 时以 cancelled 结束。
- normal stop 时以 unknown/incomplete 结束并写 warning trace。

### 12.7 Plan

ACP：`plan`

优先映射现有 AG-UI Step/Custom Plan 表达。要求保留：

- entry id。
- content。
- status：pending/in_progress/completed。
- priority（若有）。

同一个 plan entry 更新必须覆盖状态，而不是追加重复条目。

### 12.8 Commands 与 Config Options

ACP 的 available commands、config option update：

- 第一阶段发 Custom Event。
- 前端不要求立即做选择器 UI。
- 保存 Raw Trace。
- Event name 使用命名空间：

```text
acp.commands.updated
acp.config.updated
```

不要使用 `opencode.*`，保持通用。

### 12.9 Usage

ACP v1 核心协议不保证统一 Token Usage。

- Agent 通过 `_meta` 或扩展事件提供 usage 时，Profile 可解析并归一化到 `RunUsage`。
- 没有 usage 时不要伪造，`RUN_FINISHED.result.usage` 省略。
- OpenCode 第一阶段不依赖 usage 作为验收阻塞项。

---

## 13. 权限审批与 HITL

### 13.1 协议模型

ACP Agent 调用 Client：

```text
session/request_permission
  sessionId
  toolCall
  options[]
```

Client 必须在用户选择后返回：

```ts
{
  outcome: {
    outcome: "selected",
    optionId: "allow-once"
  }
}
```

或 cancelled outcome（以锁定 SDK 类型为准）。

### 13.2 AgeWork 模型

遵守 run ADR：

```text
ACP request handler Promise 保持 pending
  -> Adapter emit RUN_FINISHED{interrupt}
  -> pendingActionSink(requires_action)
  -> 用户通过 resume[] 回答
  -> approval_resolved command
  -> Adapter emit 新 RUN_STARTED(resumeRunId)
  -> resolve ACP request Promise
  -> Agent 继续同一 Prompt Turn
```

### 13.3 Pending Control

```ts
type PendingAcpPermission = {
  threadId: string;
  sessionId: string;
  interruptId: string;
  toolCallId?: string;
  options: Array<{
    optionId: string;
    name: string;
    kind?: string;
  }>;
  resolve(optionId: string): void;
  reject(error: Error): void;
  onResume?(resumeRunId: string): void;
};
```

Map key：`threadId`。

第一阶段按 thread 串行：同一时刻只允许一个 open permission。若 Agent 并发请求多个权限，将后续请求排队，不能覆盖前一个。

### 13.4 Interrupt metadata

```ts
{
  id: interruptId,
  reason: "approval_required",
  message: toolCall.title ?? "Agent requires permission",
  toolCallId,
  metadata: {
    protocol: "acp",
    sessionId,
    options
  }
}
```

### 13.5 回答解析

现有 `approval_resolved.answers` 是通用 Record。约定：

```ts
answers[interruptId] = optionId
```

兼容前端问答结构时，也可以从单一 answer 值中读取，但最终必须校验 optionId 属于原 options。

非法 optionId：

- 不 resolve Agent request。
- command result 返回 error。
- pending permission 保持存在，允许用户重试。

### 13.6 Cancel 与断开

以下情况必须 reject/取消 pending permission：

- 用户 stop。
- Runner shutdown。
- ACP process exit。
- connection close。
- Session cancel。
- permission timeout。

不能留下永不 resolve 的 Promise。

---

## 14. Cancel、Interrupt 与 Shutdown

### 14.1 `interrupt()`

对活跃 Session 发送：

```text
session/cancel
```

ACP cancel 是 Notification，不等待响应。随后：

1. 标记本地 turn cancelling。
2. 等待 prompt response/进程退出，短超时。
3. 超时则关闭 connection 并终止子进程。

### 14.2 `cancel()`

Worker Driver 当前 cancel 最终调用 Adapter interrupt。ACP Driver 还要：

- cancel pending permission。
- 清空 queued controls。
- 保证只 emit 一次终局事件。

### 14.3 `shutdown()`

实现 `AgentDriver.shutdown()`：

- 不创建新请求。
- cancel active prompt。
- reject pending controls。
- close SDK connection。
- terminate ACP process tree。
- 幂等。

Runner 正常结束和异常退出均调用。

---

## 15. AgentDriver 集成

当前 `Adapter` union：

```ts
type Adapter = ClaudeAgentAdapter | CodexAgentAdapter;
```

改为结构类型，避免每新增 Agent 扩 union：

```ts
type RunnableAgentAdapter = {
  run(input: unknown): DriverEventStream;
  interrupt(threadId?: string): Promise<void>;
  shutdown?(): Promise<void>;
};
```

`AdapterDriver` 不关心具体类。

ACP 权限 resolve 不复用 Claude 的全局 `resolveQuestion`。新增 `AcpAdapterDriver` 或让 Adapter 暴露统一控制接口：

```ts
type ControllableAgentAdapter = RunnableAgentAdapter & {
  resolveControl?(command: CommandPayload): boolean | Promise<boolean>;
};
```

推荐后者：

```ts
class AdapterDriver implements AgentDriver {
  resolveControl(command: CommandPayload) {
    return this.adapter.resolveControl?.(command) ?? false;
  }
}
```

Claude 可暂时通过 wrapper 保持原逻辑，不要求本次迁移 Claude 类。

### 15.1 Factory

```ts
switch (agentProviderConfig.agentType) {
  case "claude":
    return createClaudeDriver(...);
  case "codex":
    return createCodexDriver(...);
  case "opencode":
    return createAcpDriver(openCodeAcpProfile, ...);
  default:
    return assertNever(agentProviderConfig.agentType);
}
```

不要使用最后一个 `else` 默认返回 Codex；新增 Agent 后这种写法会静默走错 Adapter。

---

## 16. Shared、Server 与 Runtime 修改

### 16.1 Shared AgentType

```ts
export const AGENT_TYPES = ["claude", "codex", "opencode"] as const;
```

标签：

```ts
opencode: "OpenCode"
```

目录前缀：

```ts
opencode: ".opencode"
```

Skills Scanner 第一阶段可返回空数组或支持 `.opencode/skills`；OpenCode 也兼容 `.claude/skills`、`.agents/skills`，不要重复展示同一 Skill。

### 16.2 CLI Registry

当前 `cli-resolver.ts` 对 Claude/Codex 有条件分支。改成 registry：

```ts
export const AGENT_CLI_SPECS: Record<AgentType, AgentCliSpec> = {
  claude: { binary: "claude", packageName: "@anthropic-ai/claude-code", envKey: "AGEWORK_CLAUDE_CLI_PATH" },
  codex: { binary: "codex", packageName: "@openai/codex", envKey: "AGEWORK_CODEX_CLI_PATH" },
  opencode: { binary: "opencode", packageName: "opencode-ai", envKey: "AGEWORK_OPENCODE_CLI_PATH" },
};
```

已知位置检测可按平台配置；PATH 检测优先。

### 16.3 RunConfig

短期兼容方案：

```ts
opencodeExecutablePath?: string;
```

更推荐在本 Ticket 内改成：

```ts
agentExecutablePath?: string;
```

但这会影响 Claude/Codex 路径，若改动范围过大则先增加 OpenCode 字段，后续单独归一化。不得在同一 PR 大规模迁移已有字段。

### 16.4 Server Model Provider

OpenCode 支持：

- `source: system`：使用 OpenCode 本机登录和配置。
- `source: custom`：AgeWork 提供 baseUrl/apiKey/model。

`buildSystemModelProviderDto("opencode")` 必须可用。

`testConnection`：

- 第一阶段自定义 Provider 可沿用 OpenAI-compatible LLM test。
- 系统配置的“CLI 可用”只验证 binary 存在与 `opencode --version`，不启动 ACP Prompt。

### 16.5 Runtime 安装

- Native：安装 `opencode-ai` 到 Agent 专属目录。
- Container：`apps/runtime/sdk-deps/package.json` 增加 OpenCode CLI 依赖并更新锁文件，或复用真实安装脚本。
- binary path 通过 Runtime 环境/RunConfig 传 Runner，遵守 ADR-0004，不塞入 EnvConfig 的错误层。
- `opencode --version` 纳入检测结果。

### 16.6 数据库

当前 Conversation `agentType` 为 string，不需要 Prisma enum migration。

不新增 ACP Session 表；继续使用现有 Run/Conversation 的 `agentSessionId`。

---

## 17. 前端修改

### 17.1 Agent 选择

- 增加 OpenCode label/icon。
- 创建 Conversation 时允许 `opencode`。
- Model Provider 页面可筛选 `opencode`。
- Runtime CLI 状态显示 OpenCode installed/path/version。

### 17.2 ACP 专属 UI

第一阶段不新增大页面，只要求：

- assistant text 正常流式展示。
- Reasoning 可折叠。
- Tool input/output/status 正常。
- Plan 正常更新。
- Permission options 按 Agent 提供的原文展示。
- OpenCode 不支持的 `/undo`、`/redo` 不出现在 UI 或标记不可用。

### 17.3 Permission Card

不要把所有选择压成“允许/拒绝”。ACP options 可能包含：

- allow once。
- allow always。
- reject once。
- reject always。
- Agent 自定义 option。

按钮文字使用 `option.name`，提交值使用 `option.optionId`。

### 17.4 Commands/Config Options

第一版只保存并 trace，不要求做动态工具栏。若已有 Agent Settings Menu，可以只展示当前 Agent/Model，不实现通用配置项编辑器。

---

## 18. Raw Trace、日志与可观测性

### 18.1 Trace 名称

```text
sdk.acp.process.start
sdk.acp.process.stderr
sdk.acp.process.exit
sdk.acp.request
sdk.acp.response
sdk.acp.notification
sdk.acp.permission.request
sdk.acp.permission.response
sdk.acp.error
```

### 18.2 Trace Context

每条至少包含：

```ts
{
  runId,
  threadId,
  agentType,
  acpSessionId?,
  method?,
  requestId?
}
```

### 18.3 脱敏

递归脱敏：

- `apiKey`
- `token`
- `authorization`
- `headers.Authorization`
- 环境变量中 `*_KEY`、`*_TOKEN`、`*_SECRET`、`*_PASSWORD`
- `OPENCODE_CONFIG_CONTENT` 内的 credential。

### 18.4 指标

至少记录：

- process startup duration。
- initialize duration。
- session setup duration。
- first update latency。
- prompt duration。
- permission wait duration。
- stderr line count。
- protocol error count。
- forced kill count。

---

## 19. 错误模型

统一错误：

| Code | 场景 |
|---|---|
| `ACP_BINARY_NOT_FOUND` | 找不到 Agent CLI |
| `ACP_PROCESS_START_FAILED` | spawn 失败 |
| `ACP_START_TIMEOUT` | initialize 前超时 |
| `ACP_PROTOCOL_ERROR` | stdout 非法或 JSON-RPC 错误 |
| `ACP_VERSION_UNSUPPORTED` | 协议版本不兼容 |
| `ACP_INITIALIZE_FAILED` | initialize RPC 失败 |
| `ACP_SESSION_CREATE_FAILED` | session/new 失败 |
| `ACP_SESSION_NOT_FOUND` | resume/load 目标不存在 |
| `ACP_SESSION_RESUME_UNSUPPORTED` | 有历史但不能恢复 |
| `ACP_PROMPT_FAILED` | session/prompt 失败 |
| `ACP_PERMISSION_INVALID` | 用户选择无效 option |
| `ACP_PERMISSION_TIMEOUT` | 权限等待超时 |
| `ACP_CONTENT_UNSUPPORTED` | 输入内容 Agent 不支持 |
| `ACP_AGENT_EXITED` | Agent 非预期退出 |

用户错误信息简洁；详细诊断进入 trace。

禁止把完整 env/config/stderr 原样返回前端。

---

## 20. 安全要求

- 子进程 cwd 必须等于 Runtime workspace 路径。
- 命令和 args 来自代码注册 Profile，不接受前端任意命令。
- 第一版不允许用户配置任意 `command`。
- 环境变量用现有 safe-env 策略，显式剔除 Worker/Server 私有凭证。
- `OPENCODE_CONFIG_CONTENT` 只在子进程内存环境存在，不写项目文件。
- 不虚报 Client fs/terminal capability。
- Permission option 必须回传 Agent 提供的 optionId，不自行构造 allow。
- Agent stdout 只视为协议数据，stderr 只视为日志。
- Container 内继续依赖 Runtime 隔离；ACP 不是沙箱。
- `allow_always` 等持久权限是否由 Agent 自己处理，AgeWork 不额外跨 Session 保存。

---

## 21. 测试策略

### 21.1 Fake ACP Agent

实现 `testing/fake-acp-agent.ts`：

- stdio NDJSON。
- 可脚本化 initialize capability。
- new/load/resume。
- prompt 后发送 fixtures。
- 主动 request_permission。
- 接收 cancel。
- 模拟 stderr、崩溃、非法 stdout、超时。

单元/集成测试默认使用 Fake Agent，不依赖真实模型或网络。

### 21.2 AcpProcess 测试

- 正常 spawn。
- cwd/env 正确。
- stderr 分流。
- 启动失败。
- 正常 terminate。
- 超时强杀。
- 重复 shutdown 幂等。
- 子进程提前退出。
- Windows command path 处理。

### 21.3 Client/Session 测试

- initialize 成功。
- capability normalize。
- protocol mismatch。
- session/new。
- resume 优先于 load。
- load replay 不发业务消息。
- session not found 不静默新建。
- prompt stop reason。
- cancel notification。

### 21.4 Mapper 测试

- 多 chunk 文本只有一个 start/end。
- thought 与 text 分离。
- tool normal lifecycle。
- tool update 乱序。
- tool failed/cancelled。
- rawInput/rawOutput/locations 保留。
- plan entry 更新去重。
- unknown event 不崩溃并 trace。
- Turn 结束补齐开放事件。

### 21.5 Permission 测试

- request → interrupt finish。
- pendingAction 顺序在 interrupt 之后。
- resumeRunId 先 emit RUN_STARTED 再 resolve permission。
- optionId 校验。
- 多权限串行。
- cancel 清理 pending Promise。
- process exit 清理。
- timeout 清理。
- 重复 answer 只处理一次。

### 21.6 Worker 测试

- `opencode` 创建 ACP Driver。
- 未知 AgentType assertNever。
- OpenCode binary path 优先 RunConfig。
- approval_resolved 路由到 ACP Adapter。
- cancel/shutdown 回收 ACP 进程。

### 21.7 Server 测试

- 创建 opencode Conversation。
- OpenCode system provider。
- OpenCode custom provider。
- RunConfig 下发 executable path。
- `agent.sessionId` 持久化。
- requires_action → resume → running。
- OpenCode CLI 安装和检测。

### 21.8 前端测试

- Agent picker 展示 OpenCode。
- OpenCode Provider 选择。
- ACP Permission options 原样展示和提交。
- Reasoning、Tool、Plan fixture 渲染。
- 页面刷新后 interrupt card 可恢复。

### 21.9 OpenCode 真实 Smoke Test

环境要求：

- 安装并认证 OpenCode。
- 固定测试版本。
- 临时 git workspace。
- 不使用生产凭证。

用例：

1. `opencode acp` initialize。
2. 创建 Session。
3. 文本 prompt。
4. 读取文件。
5. 编辑文件。
6. 执行命令。
7. Plan/Agent mode（若 capability 发布）。
8. 权限询问。
9. Cancel 长任务。
10. 新 Runner load/resume 原 Session。
11. MCP 配置生效。
12. 进程结束无残留。

真实 Smoke Test 标记为 opt-in，不进入无凭证普通 CI。

### 21.10 Runtime 矩阵

| Runtime | 必测 |
|---|---|
| Native macOS | 是 |
| Native Linux | 是 |
| Native Windows | 是，至少安装/启动/简单 Prompt |
| Docker workspace scope | 是 |
| Registered Runtime | 是 |

---

## 22. 分阶段实施 Tickets

### Ticket 1：协议依赖与 ACP Process

内容：

- 安装官方 SDK 精确版本。
- 实现 `AcpProcess`、stdio web stream 转换、cleanup。
- 实现 Fake ACP Agent。
- 完成 process tests。

验收：

- Fake Agent 可 initialize。
- stdout/stderr 严格分流。
- abort 后无残留进程。

### Ticket 2：Client、Initialize 与 Session

内容：

- 实现 SDK Client connection。
- capability normalize。
- session new/resume/load。
- load replay suppression。
- prompt/cancel。

验收：

- Fake Agent 多轮恢复通过。
- session ID emit fixture 通过。
- 不支持恢复时明确失败。

### Ticket 3：ACP → AG-UI Mapper

内容：

- message、thought。
- tool call/update。
- plan。
- commands/config custom events。
- run finish/error。

验收：

- fixture tests 全通过。
- 无重复 Message/Tool。
- unknown event 可观测但不中断。

### Ticket 4：Permission Bridge

内容：

- 注册 Client permission handler。
- terminal interrupt。
- pending control queue。
- resumeRunId。
- cancel/shutdown cleanup。

验收：

- 完整 interrupt/resume 测试通过。
- 并发 permission 不覆盖。
- 非法 option 不解开请求。

### Ticket 5：Generic Adapter 与 Worker Driver

内容：

- 实现 `AcpAgentAdapter`。
- Adapter 结构类型。
- profile registry。
- Worker factory exhaustiveness。
- trace integration。

验收：

- `opencode` 能选择 ACP Adapter。
- Claude/Codex 精准测试无回归。
- Runner shutdown 回收 Agent。

### Ticket 6：OpenCode Profile

内容：

- `opencode acp` launch spec。
- system/custom env。
- config content 白名单生成。
- safe env/redaction。
- OpenCode profile tests。

验收：

- System 配置不会被 custom env 污染。
- Custom config 不落盘。
- API Key 不出现在 trace。

### Ticket 7：Shared、Server、Runtime

内容：

- 新增 `opencode` AgentType/label/path。
- CLI registry 与安装。
- RunConfig binary path。
- system/custom ModelProvider。
- Server tests。

验收：

- Native/Container 能检测/安装 OpenCode。
- Server 可启动 opencode Run。
- session ID 可持久化到后续 Run。

### Ticket 8：前端与 E2E

内容：

- Agent picker/Provider/Runtime UI。
- Permission options。
- OpenCode 标识。
- Fake fixture E2E。
- 真实 OpenCode smoke。

验收：

- 浏览器完成 prompt → tool → permission → resume → finish。
- 刷新后历史无重复。
- stop 后进程被清理。

### Ticket 9：文档与发布保护

内容：

- 更新 README/架构文档。
- 添加 ACP Adapter 开发说明。
- 添加兼容版本表。
- 添加 OpenCode setup/troubleshooting。
- CI 精准测试。

验收：

- 新开发者按文档可安装 OpenCode 并完成 smoke。
- CI 不需要真实凭证。

---

## 23. CI 建议

普通 CI：

```bash
pnpm --filter @agework/agent-acp typecheck
pnpm --filter @agework/agent-acp test
pnpm --filter @agework/runtime typecheck
pnpm --filter @agework/runtime test
pnpm --filter @agework/shared test
pnpm --filter server test
pnpm --filter web test
```

增加矩阵：

- Node 当前支持版本。
- Linux/macOS/Windows process smoke。
- ACP SDK lockfile 检查。

真实 OpenCode：

- nightly/manual workflow。
- 固定 CLI 版本。
- 使用专用低权限测试凭证。
- 失败时上传脱敏 ACP trace。

---

## 24. 性能与资源约束

- 一个 Runner 最多一个主 ACP Agent 进程。
- 默认启动超时 10 秒。
- stderr ring buffer 最多 50 行或 64KB。
- Raw event 单条持久化前沿用现有 trace 大小限制。
- Tool rawOutput 过大时按现有 AG-UI/trace 规则截断，但 Artifact/文件位置仍保留。
- permission 默认超时建议 30 分钟，可配置。
- Runner shutdown grace 3 秒后强杀。
- 首版不做共享 ACP daemon，不做进程池。

后续只有在真实数据证明 CLI 冷启动成为瓶颈时，才评估 Worker 级共享 Agent 进程；这会改变当前 Runner 边界，必须新 ADR。

---

## 25. 兼容性与降级原则

Capability 驱动，不按 Agent 名称猜功能：

```text
支持 resume -> 使用 resume
不支持 resume 但支持 load -> 使用 load
两者都不支持 -> 首轮可用，后续明确失败
支持 image -> 发送图片
不支持 image -> 明确拒绝
```

OpenCode Profile 只用于启动/config 差异，不把协议通用行为写成 OpenCode if/else。

ACP 新字段：

- 保留 raw trace。
- Mapper default 分支记录 debug。
- 不因未知 notification 崩溃。

ACP 破坏性变更：

- 由精确依赖版本阻止自动升级。
- 升级时更新 fixtures 和兼容表。

---

## 26. 回滚方案

本次新增独立 AgentType，不替换 Claude/Codex，因此回滚简单：

1. Feature flag 隐藏 OpenCode。
2. 禁止创建新的 OpenCode Conversation。
3. 已有 Conversation 保留数据并显示“当前版本暂不可用”。
4. 回滚 Adapter/Runtime 安装代码。
5. 不删除已保存的 `agentSessionId`。

建议 Feature Flag：

```text
AGEWORK_FEATURE_ACP=true|false
AGEWORK_FEATURE_OPENCODE=true|false
```

开发期默认开，正式发布前按 smoke 结果决定默认值。

---

## 27. 最终验收清单

### 架构

- [ ] `acp` 没有成为 AgentType。
- [ ] 通用代码不包含 OpenCode 特有分支。
- [ ] OpenCode 差异只在 Profile。
- [ ] ACP 子进程由 Runner 拥有。
- [ ] Server 不解析 ACP wire event。
- [ ] 前端仍只消费 AG-UI。

### 协议

- [ ] 使用官方 TypeScript SDK。
- [ ] initialize/capability negotiation 正确。
- [ ] session new/resume/load 正确。
- [ ] load replay 不重复业务历史。
- [ ] cancel/shutdown 正确。

### 体验

- [ ] 文本流式。
- [ ] Reasoning 独立展示。
- [ ] Tool 生命周期完整。
- [ ] Plan 可更新。
- [ ] Permission options 原样展示。
- [ ] interrupt/resume 可继续同一 Turn。
- [ ] 页面刷新不重复消息。

### Runtime

- [ ] Native 安装和检测 OpenCode。
- [ ] Container 能运行 `opencode acp`。
- [ ] binary path 正确传到 Runner。
- [ ] workspace cwd 正确。
- [ ] 结束后无残留进程。

### 安全

- [ ] 不允许用户传任意命令。
- [ ] 不泄露 Worker/Server token。
- [ ] API Key/Config 已脱敏。
- [ ] 未实现的 Client capability 不声明。
- [ ] 权限 optionId 有白名单校验。

### 测试

- [ ] Fake Agent 全套测试。
- [ ] Adapter/Worker/Server/Frontend 精准测试。
- [ ] OpenCode 真实 smoke。
- [ ] Native/Container 核心路径。
- [ ] Claude/Codex 无回归。

---

## 28. 后续演进

本次稳定后再考虑：

### 28.1 第二个 ACP Agent

选择一个原生 ACP Agent（例如 Qwen/Gemini/Goose），只新增 Profile 和兼容测试。若必须修改通用核心大量代码，说明抽象不成立，应先修正 Adapter 设计。

### 28.2 用户自定义 ACP Agent

未来需要：

- AgentDefinition 数据模型。
- command/args/env 管理。
- 管理员白名单。
- binary provisioning。
- capability probe。
- 安全审计。

这不是本次范围。

### 28.3 Client Filesystem/Terminal

只有当某 ACP Agent 确实依赖 Client capability 时再实现：

- 路径限制在 Runtime workspace roots。
- terminal 由 Runtime/Runner 统一托管。
- 每项 capability 独立安全评审。
- 实现完成前不在 initialize 中声明。

### 28.4 OpenCode SDK 辅助控制面

若未来产品明确需要 OpenCode 专属 Session diff/fork/revert/provider 管理，可以单独设计只读/控制面 SDK；不得让 SDK 与 ACP 同时驱动 Prompt 和运行事件。

---

## 29. 官方参考资料

- ACP Overview：<https://agentclientprotocol.com/protocol/v1/overview>
- ACP TypeScript SDK：<https://github.com/agentclientprotocol/typescript-sdk>
- ACP Initialization：<https://agentclientprotocol.com/protocol/v1/initialization>
- ACP Session Setup：<https://agentclientprotocol.com/protocol/v1/session-setup>
- ACP Prompt Turn：<https://agentclientprotocol.com/protocol/v1/prompt-turn>
- ACP Tool Calls：<https://agentclientprotocol.com/protocol/v1/tool-calls>
- ACP Session Config Options：<https://agentclientprotocol.com/protocol/v1/session-config-options>
- OpenCode ACP：<https://opencode.ai/docs/acp/>
- OpenCode CLI Environment：<https://opencode.ai/docs/cli/>
- OpenCode Config：<https://opencode.ai/docs/config/>
- OpenCode Providers：<https://opencode.ai/docs/providers/>

实施时必须以仓库锁定的 `@agentclientprotocol/sdk` 类型和真实 `opencode acp` capability response 为最终事实。本文中的字段示例用于确定架构和语义，不允许绕过 TypeScript 类型硬猜协议。

---

## 30. 最终目标

迁移完成后，AgeWork 形成两种明确的 Agent 接入等级：

```text
First-class Native
  Claude / Codex
  使用官方专属 SDK 或服务协议

ACP Compatible
  OpenCode（首个标杆）/ 后续 Agent
  共用进程、Session、HITL、AG-UI 转换与测试框架
```

AgeWork 的价值不在重新实现每个 Agent Loop，而在于：

```text
Agent 在哪个 Runtime 运行
Workspace 如何隔离
过程如何统一展示
权限如何控制
Session 如何恢复
团队如何共享、审计和管理
```

通用 ACP Adapter 必须服务于这个边界，而不是把 AgeWork 变成另一个协议转发器。
