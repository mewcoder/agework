## Queue "Send Immediately" Feature Research

### Problem

When a conversation is running and the user has queued messages, clicking "Send Immediately" (previously "Prioritize") should send the selected message right away, not wait for the current run to finish.

---

### SDK Capabilities

#### Claude Agent SDK — Supports Streaming Input

The Claude Agent SDK supports feeding user messages into a running conversation through two mechanisms:

**1. `AsyncIterable<SDKUserMessage>` as `prompt` parameter**

`query()` accepts an async iterable of messages instead of a string. The caller can push new `SDKUserMessage` objects into the stream at any time, including while the assistant is mid-response. The SDK queues and processes them.

```typescript
// Current adapter pattern (single turn per call):
const queryStream = query({ prompt: "user message string", options });

// Streaming input pattern (not yet used):
const queryStream = query({ prompt: asyncMessageIterable, options });
```

**2. `shouldQuery` field on `SDKUserMessage`**

- `shouldQuery: false` — appends the message to conversation context without triggering a new assistant turn. The model sees it in subsequent turns.
- `shouldQuery: true` (default) — appends and triggers a new assistant turn.

**3. Internal message queue**

The SDK maintains an internal message queue for the async iterable input. Related features:

- `cancel_async_message` control subtype — drops a queued message by UUID before execution (v0.2.76)
- `queued_to_running` status — confirms messages can be delivered to a running agent (v0.2.75)

**Key CHANGELOG references:**

| Version | Feature |
|---------|---------|
| v0.2.75 | `queued_to_running` status — ⚠️ **corrected**: this is a status on the `Agent({resume})` *subagent tool*'s output (returned when `resume` targets a still-running subagent), not a general "message delivered to running agent" signal for the main prompt queue |
| v0.2.76 | `cancel_async_message` to drop queued messages |
| v0.2.86 | `session_id` made optional on `SDKUserMessage` |
| v0.2.110 | `shouldQuery` field on `SDKUserMessage` |
| ~~v0.3.x~~ | ❌ **corrected**: `AsyncIterable<SDKUserMessage>` as the `prompt` type has existed since v0.1.0. The v0.3.142 CHANGELOG entry only recommends it as the replacement for the deprecated v2 session API — it is not a new capability introduced in the v0.3.x series |

**Verification note (2026-06-18):** `reference-source-code/claude-agent-sdk/` only ships README/CHANGELOG/examples, no type declarations — verifying field names requires reading the installed package directly (`node_modules/.pnpm/.../@anthropic-ai/claude-agent-sdk/sdk.d.ts`, currently `0.3.158`).

**Current gap:** The project's adapter (`packages/adapters/src/claude/`) uses the simple pattern — one `query(string)` call per turn, with session resume for multi-turn (confirmed at `packages/adapters/src/claude/base/adapter.ts:178-179`, resume via `forwardedProps.resume`). It does not use the `AsyncIterable` input pattern. Adopting it requires restructuring the adapter to maintain a long-lived `query()` with a controllable async iterable.

---

#### OpenAI Codex SDK — SDK 层不支持流式输入，但可通过中断+重发实现引导

The Codex SDK architecture is strictly **sequential, process-per-turn**:

- Each `thread.run()` / `thread.runStreamed()` call spawns a new `codex exec` child process
- The full prompt is written to the child's stdin in a single write, then stdin is immediately closed
- The process emits JSONL events on stdout until completion, then exits
- Multi-turn works by passing `resume <threadId>` to subsequent CLI calls, which load session state from disk

There is no `AsyncIterable` input, no `shouldQuery` equivalent, no message queue, and no mechanism to inject messages into a running turn. The only options are:

1. Wait for the current turn to finish, then send the next message
2. Abort the current turn via `AbortSignal`, then send a new message

**Thread class methods (exhaustive):**

| Method | Signature | Description |
|--------|-----------|-------------|
| `run` | `(input: Input, turnOptions?: TurnOptions) => Promise<Turn>` | Blocking turn |
| `runStreamed` | `(input: Input, turnOptions?: TurnOptions) => Promise<StreamedTurn>` | Streaming turn |
| `id` | `get id(): string \| null` | Thread ID getter |

No `appendMessage`, `sendMessage`, or streaming input method exists.

---

### assistant-ui Built-in Steer（引导）机制

assistant-ui 已经内置了完整的消息队列和 steer 功能，项目目前的自定义 Zustand 队列实现没有利用到这些能力。

**核心类型：**

```typescript
// 发送选项 — steer 标志
type SendOptions = {
  startRun?: boolean;
  steer?: boolean;  // 立即处理此消息
};

// 队列项方法
type QueueItemMethods = {
  getState(): QueueItemState;
  steer(): void;    // 引导此队列项
  remove(): void;
};

// 队列适配器 — 外部 store 提供
type ExternalThreadQueueAdapter = {
  items: readonly QueueItemState[];
  enqueue: (message: AppendMessage, options: { steer: boolean }) => void;
  steer: (queueItemId: string) => void;
  remove: (queueItemId: string) => void;
  clear: (reason: "edit" | "reload" | "cancel-run") => void;
};
```

**steer 的两条执行路径：**

1. **有 cancel 且正在运行**：从队列取出消息 → `suppressIdle++`（吞掉被取消 run 的 idle 通知）→ `driver.cancel()` 中断当前 run → `driver.run(message, { steer: true })` 立即运行引导消息
2. **无 cancel 或未运行**：将消息移到队列最前 → `advance()`，当前 run 结束后自动运行

**`suppressIdle` 机制**：steer 取消当前 run 后，被取消的 run 最终会调用 `notifyIdle()`。`suppressIdle` 计数器吞掉这个 idle 通知，防止队列被错误地双推进。被引导的 run 正常 settle 后才触发下一轮 advance。

**UI 集成：**
- `QueueItemPrimitive.Steer` — 引导按钮组件，调用 `aui.queueItem().steer()`
- `QueueItemPrimitive.Text` — 队列项文本渲染
- `QueueItemPrimitive.Remove` — 删除按钮
- 快捷键：Cmd/Ctrl+Shift+Enter 发送时带 `{ steer: true }`

**Local Runtime vs External Store：**
- Local runtime 创建 message queue 时没有传入 `cancel`（`local-thread-runtime-core.ts:155-167` 的 `createMessageQueue` 调用未带 `cancel` 字段），所以 steer 降级为"移到最前"——准确说是 queue driver 层缺 cancel，不是 runtime 整体不支持
- External store 可通过 `ExternalThreadQueueAdapter` 提供 `cancel`，实现真正的中断+引导

**⚠️ 关键发现（2026-06-18 核实）：本项目的 runtime 根本没有接入这套队列体系，不是"差距"而是"零集成"。**

项目实际使用的是 `useAgUiRuntime`（`@assistant-ui/react-ag-ui@0.0.33`），核心类 `AgUiThreadRuntimeCore`（`packages/react-ag-ui/src/runtime/AgUiThreadRuntimeCore.ts`）是一个独立实现，不继承任何已接入队列体系的基类（如 `ExternalStoreThreadRuntimeCore`），对 `getQueueItems` / `steerQueueItem` / `removeQueueItem` —— `ThreadRuntimeCore` 上驱动 steer/`QueueItemPrimitive` 的三个可选方法 —— 零实现、零引用。

也就是说：**要让本项目用上 assistant-ui 原生 steer，必须 fork/patch 上游 `@assistant-ui/react-ag-ui` 包**，给 `AgUiThreadRuntimeCore` 补上这三个方法并接通内部的 `append`/`cancel`/`startRun` 逻辑，而不是像下面 Option C 原先设想的那样"只需在本项目里接一个 `ExternalThreadQueueAdapter` 配置"。这大幅提高了 Option C 的实际成本（见下方 Option C 修订）。

**当前项目的差距：** 项目使用自定义 Zustand store（`runtime-ui-store.ts`）管理队列，完全绕过了 assistant-ui 的队列系统。要利用 steer，需要迁移到 assistant-ui 的 `ExternalThreadQueueAdapter` 模式（但前提是先让 runtime 暴露队列接口，见上），或在自定义实现中复现 steer 逻辑。

---

### Implementation Options

#### Option A: Interrupt + Resend（短期，两个 SDK 都支持）

Works with current architecture. No SDK changes needed.

**⚠️ 修订（2026-06-18 代码核实）：这一节原先设想的"等 idle 再发送"步骤其实已经在代码里实现了，缺的拼图比预想的小很多。**

实际读 `apps/web/src/components/assistant-ui/thread-composer.tsx` 和 `apps/web/src/stores/runtime-ui-store.ts` 后发现：
- `prioritizeUserInput`（`runtime-ui-store.ts:141`）目前**只把消息挪到队首**，不会打断当前 run。
- `thread-composer.tsx:343-353` 已经有一个 `useEffect`：监听 `showStop` 从 `true → false` 的变化，自动 `shiftUserInput` 并 `aui.thread().append()` 队首消息——也就是"等 idle 再发送"这一步**已经存在**，不需要新写。
- 打断当前 run 已经有两条现成路径（`ComposerAction`，`thread-composer.tsx:99-116`）：当前 tab 正在流式接收时调用 `aui.thread().cancel()`；只是后台 polling 显示 running 时走 `StopConversationRunButton` 的 REST `stopRun`。两条路径最终都会让 `showStop` 变 `false`，从而触发上面已有的自动派发 `useEffect`。

**修订后的 Flow（比原方案小很多）：**
1. `handlePrioritizeQueuedInput` 里，除了现有的"挪到队首"，按 `isRuntimeRunning` 选择触发 `aui.thread().cancel()` 或 REST `stopRun`（复用 `ComposerAction` 已有的判断逻辑）
2. 现有 `useEffect`（`showStop: true → false`）自动取队首消息发出，无需新增"等待 idle"逻辑

**Pros:** 比原方案改动更小；works for both Claude and Codex；无需后端改动。

**Cons:** Loses the current assistant response progress（和现有 Stop 按钮行为一致）。打断到真正 idle 之间有个空档，UI 上可能需要给被选中的队列项加一个"等待中"态防止重复点击/被误删。

**Frontend changes（实际改动范围）：**
- `handlePrioritizeQueuedInput` 新增打断分支（约几行）
- 可选：被引导消息处于"等待打断完成"期间的 UI 状态（loading/disabled）

**Backend changes：** None required (uses existing `POST /agent/stop` + normal message send).

---

#### Option B: Adapter Refactor with AsyncIterable (Long-term, Claude only)

Restructure the Claude adapter to use a long-lived `query()` with `AsyncIterable<SDKUserMessage>`.

**Architecture:**
1. Adapter maintains a single `query()` per conversation with an async generator as the prompt
2. Normal messages push `SDKUserMessage { shouldQuery: true }` into the generator
3. "Send immediately" during a run:
   - Option B1: Push `{ shouldQuery: true }` — triggers a new turn after the current one finishes (not truly immediate)
   - Option B2: `interrupt()` + push `{ shouldQuery: true }` — interrupts current turn, immediately starts new one with the priority message
4. `shouldQuery: false` could be used for "context injection" features (e.g., user provides extra info without expecting a response)

**Pros:** True streaming input, message queue managed by SDK, clean interruption + resend, foundation for future features (context injection, async messages).

**Cons:** Significant adapter refactor, only works for Claude (Codex needs Option A fallback), more complex state management.

**Required changes:**
- `packages/adapters/src/claude/base/adapter.ts` — replace single `query(string)` with long-lived `query(asyncIterable)`
- Worker layer — expose a method to push messages into the adapter's async iterable
- Backend API — new endpoint or control message type for "priority send"
- Frontend — call the new endpoint instead of stop + send

---

#### Option C: 迁移到 assistant-ui Steer（原文档推荐，⚠️ 实际成本被低估）

将自定义 Zustand 队列替换为 assistant-ui 的 `ExternalThreadQueueAdapter`，利用内置 steer 机制。

**⚠️ 修订（2026-06-18 代码核实）：这一节的前提不成立。**`ExternalThreadQueueAdapter` 驱动的 steer/`QueueItemPrimitive` 依赖 `ThreadRuntimeCore` 上的 `getQueueItems`/`steerQueueItem`/`removeQueueItem` 可选方法，而本项目实际使用的 `AgUiThreadRuntimeCore`（`@assistant-ui/react-ag-ui@0.0.33`）完全没有实现这几个方法、也不继承任何已实现它们的基类（如 `ExternalStoreThreadRuntimeCore`）。详见上方"assistant-ui Built-in Steer 机制"小节的关键发现。这意味着下面的架构第 1 步（"runtime 初始化时提供 `ExternalThreadQueueAdapter`"）**在当前 runtime 上根本接不上**——它不是一个配置项，而是需要先有方法实现。

**架构（原方案，前提是 runtime 已支持队列接口）：**
1. 在 runtime 初始化时提供 `ExternalThreadQueueAdapter`，包含 `enqueue`、`steer`、`remove`、`clear` 实现
2. `steer` 回调内部调用 `POST /agent/stop`（或 `interrupt` 控制消息）中断当前 run
3. 中断完成后 runtime 自动发送引导消息
4. 队列 UI 使用 `QueueItemPrimitive.Steer` / `Text` / `Remove` 组件

**Pros：**
- assistant-ui 原生支持，steer / suppressIdle / auto-dispatch 全部内置
- 两个 SDK 都能用（steer 的 cancel 实现调后端 stop，与 SDK 无关）
- 自动获得 Cmd+Shift+Enter 快捷键
- 减少自定义代码维护量

**Cons（修订后，成本远高于原评估）：**
- **前置依赖：必须先 fork/patch 上游 `@assistant-ui/react-ag-ui` 包**，给 `AgUiThreadRuntimeCore` 补上 `getQueueItems`/`steerQueueItem`/`removeQueueItem` 并接通其内部 `append`/`cancel`/`startRun` 状态机——这是这个方案里工作量最大的部分，原文档完全没有评估到
- patch 上游包需要长期维护（升级 `@assistant-ui/react-ag-ui` 版本时要重新应用/校验 patch），需要 `patch-package` 之类机制锁定
- 在此基础上，才是把现有队列逻辑从 Zustand store 迁移到 `ExternalThreadQueueAdapter`
- 需要理解 assistant-ui 的 queue lifecycle（enqueue / steer / clear / notifyIdle）

**Required changes（修订后）：**
- **新增前置步骤**：patch `@assistant-ui/react-ag-ui`，给 `AgUiThreadRuntimeCore` 实现队列接口
- runtime 初始化处添加 `queue: ExternalThreadQueueAdapter` 配置
- 删除 `runtime-ui-store.ts` 中的队列相关状态和方法
- `thread-composer.tsx` 中队列 UI 改用 assistant-ui primitives
- steer 回调实现：调后端 stop → 等 idle → runtime 自动发送

**结论：在当前 runtime 架构下，Option C 的投入产出比远不如 Option A。** 除非未来有其他独立原因需要把项目迁移到原生支持队列的 runtime（如 `ExternalStoreRuntime`），否则不建议为了这一个功能去 patch 上游包。

---

### Recommendation

**⚠️ 2026-06-18 修订：原推荐的 Option C 在当前 runtime 架构下不成立（详见 Option C 小节），推荐顺序整体调整。**

1. **推荐 Option A（增强版）**：代码核实显示，"打断当前 run"以外的所有拼图（队列、挪到队首、等待 idle 后自动发送）都已经在 `thread-composer.tsx` / `runtime-ui-store.ts` 里实现好了。只需在 `handlePrioritizeQueuedInput` 里按 `isRuntimeRunning` 复用现有两条打断路径（`aui.thread().cancel()` 或 REST `stopRun`），改动量很小，两个 SDK 都支持，无需后端改动。
2. **Option C 不再推荐（除非有其他独立动机）**：本项目的 `AgUiThreadRuntimeCore` 完全没有接入 assistant-ui 的队列/steer 体系，要用上它必须先 fork/patch 上游 `@assistant-ui/react-ag-ui` 包并长期维护这个 patch，投入产出比远不如 Option A。
3. **长期（Claude only）**：如果未来需要运行中追加上下文而不中断（`shouldQuery: false`），再考虑 Option B 的 AsyncIterable 重构；与本次"立即发送"需求无关。

---

### Key Files

| File | Role |
|------|------|
| `packages/adapters/src/claude/base/adapter.ts` | Claude adapter — needs AsyncIterable refactor for Option B |
| `packages/adapters/src/codex/base/adapter.ts` | Codex adapter — uses AbortSignal for cancel |
| `apps/api/src/agent/agent.controller.ts` | `POST /agent/stop` endpoint |
| `apps/api/src/runtime/core/runtime-runner.ts` | Run lifecycle management |
| `apps/worker/src/main.ts` | Worker cancel/interrupt handling |
| `apps/web/src/components/assistant-ui/thread-composer.tsx` | Queue UI + prioritize handler；含已有的两条打断路径（`ComposerAction`）和自动派发 `useEffect`（343-353 行） |
| `apps/web/src/stores/runtime-ui-store.ts` | Queue state store；`prioritizeUserInput`（141 行）目前只重排序，不打断 |
| `apps/web/src/hooks/use-agent-chat-runtime.ts` | `useAgUiRuntime` 配置 + `onCancel` 回调（调 `stopRun`） |
| `apps/web/src/hooks/use-conversations.ts` | `useStopConversationRun` mutation（REST 打断路径） |
| `reference-source-code/assistant-ui/packages/react-ag-ui/src/runtime/AgUiThreadRuntimeCore.ts` | 确认未实现队列接口的关键证据文件 |
| `packages/shared/src/protocol/transport.ts` | `ControlPayload` types (cancel, interrupt, user_message) |
