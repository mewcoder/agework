# 中断机制迁移到 AG-UI 规范 - 设计文档

> **状态**：设计稿，待评审
> **范围**：把 Claude 的 `AskUserQuestion` / `AskUserPermission` 从自建 pending tool-call 机制迁移到 AG-UI `RUN_FINISHED.outcome=interrupt` + `submitInterruptResponses`。
> **非目标**：第一阶段不迁 Codex；不重写普通刷新续流；不删除消息队列。
> **核心结论**：前端应使用 AG-UI interrupt 规范；后端必须显式引入 **suspended continuation**，不能把 `submitInterruptResponses()` 触发的新 `/agent/run` 当作普通新 query。

---

## 1. 背景

当前中断能力分散在 adapter、worker、API、前端 store/history 多层：

- Claude `canUseTool` 内部挂起 promise，等待 `approval_resolved` control。
- 前端通过 pending `AskUserQuestion` / `AskUserPermission` tool-call part 渲染 UI。
- 刷新恢复靠 `pendingUserAction=question`、history adapter status 归一化、`PendingQuestionPanel` 等自建补丁。
- 用户插嘴用 `interruptReason=user_steered` 特判，语义和 assistant-ui runtime 不一致。

AG-UI / assistant-ui 已经提供 interrupt 原语：

- provider 发送 `RUN_FINISHED`，携带 `outcome: { type: "interrupt", interrupts }`。
- assistant message 进入 `{ type: "requires-action", reason: "interrupt" }`。
- interrupts 存在 `message.metadata.custom.agui.interrupts`。
- 前端调用 `runtime.unstable_submitInterruptResponses(responses)`，runtime 校验 interrupt id、过期时间、完整性，然后带 `RunAgentInput.resume` 发起下一次 run。

迁移目标是让前端状态回到 assistant-ui runtime 的模型里，同时保留 Claude SDK `canUseTool` 所需的宿主回调能力。

---

## 2. 关键约束

### 2.1 AG-UI 的 "run finished" 不等于 Claude SDK query 结束

AG-UI interrupt 的语义是：**当前 UI run 已结束，等待用户输入**。

Claude SDK 的 `canUseTool` 语义是：**SDK query 正在等待宿主返回 `PermissionResult`**。

这两者天然不等价。迁移时不能只做：

```ts
canUseTool -> emit RUN_FINISHED(outcome=interrupt) -> subscriber.complete()
```

然后期望下一次 `/agent/run` 自动接上旧 promise。原因：

- `submitInterruptResponses()` 会从前端发起一个新的 `/agent/run`，携带新的 `runId`。
- 旧的 `canUseTool` resolver 只存在触发中断的 worker/adapter 进程内。
- local runtime 当前每个 run 一个 worker 进程；如果中断后 worker 退出，resolver 直接丢失。
- persistent worker 虽然复用 adapter，但 `RunRouter.complete()` 当前会把 run 从 active map 删除，需要新增 suspended continuation 状态。

因此本迁移必须显式建模：

> **Suspended continuation**：一个被 AG-UI 标记为 interrupt、但底层 Claude query 仍在等待 `canUseTool` 结果的后端 continuation。

### 2.2 第一阶段只保证 persistent worker 路径

第一阶段建议只在 persistent worker 路径开启 `AGUI_INTERRUPT_V2`。local single-run worker 仍走旧机制，直到它支持“中断后不退出、等待 resume control”。

原因：

- persistent worker 可以在同一进程里保存 `pendingInterrupts` 和 Claude query。
- local worker 当前按 run fork，run 完成后进程生命周期天然结束；要支持 V2 需要额外改 provider/worker 生命周期。

这不是永久限制，而是降低第一阶段风险。

### 2.3 前端不能决定要写盘的权限规则

`AskUserPermission` 的 Always-Allow 会写 `.claude/settings.local.json`。前端 resume payload 不能回传任意 `suggestions` 并让后端信任。

后端应在 pending continuation 中保存 SDK 给出的 `suggestions`，前端只回传用户选择：

```ts
{ interruptId, status: "resolved", payload: { approved: true, persist: true } }
```

adapter 根据自己保存的 `suggestions` 生成 `updatedPermissions`。

### 2.4 拒绝权限不是 cancel interrupt

`status: "cancelled"` 表示放弃这个 interrupt 或取消本轮 continuation。

用户点击“拒绝工具”应当是：

```ts
{ interruptId, status: "resolved", payload: { approved: false } }
```

adapter resolve `PermissionResult`：

```ts
{ behavior: "deny", message: "用户拒绝了该工具请求。" }
```

这样 Claude query 可以收到正常的工具拒绝结果，而不是被整轮 abort。

---

## 3. 目标模型

### 3.1 能力归属

| 能力 | 迁移后归属 | 说明 |
| --- | --- | --- |
| `AskUserQuestion` UI 中断 | AG-UI interrupt | 前端读 `metadata.custom.agui.interrupts` |
| `AskUserPermission` UI 中断 | AG-UI interrupt | 审批 UI 自建，传输走规范 |
| Claude `canUseTool` 等待 | 后端 suspended continuation | 必须保留 resolver |
| Always-Allow 写盘 | Claude adapter | 只信任后端保存的 SDK suggestions |
| steer-away | 删除 `user_steered` | 改成“取消 pending interrupt 后再发送” |
| 普通刷新续流 | 保留现有 resume stream | 与 interrupt resume 是两套语义 |
| Codex 审批 | 暂不迁移 | 第二阶段单独设计 |

### 3.2 核心数据流

```
Claude canUseTool / AskUserQuestion
  |
  | create interrupt + register suspended continuation
  v
adapter emits RUN_FINISHED { outcome: { type: "interrupt", interrupts } }
  |
  v
API aggregator persists assistant message:
  status = requires-action / interrupt
  metadata.custom.agui.interrupts = [...]
  |
  v
worker/API mark run as requires_action and keep continuation handle
  |
  v
frontend renders InterruptPanel from message metadata
  |
  | user answers
  v
runtime.unstable_submitInterruptResponses(responses)
  |
  | POST /agent/run with input.resume
  v
API detects input.resume
  |
  | route to suspended continuation, not a fresh query
  v
worker applyResume(threadId, resume, newRunId)
  |
  | resolve old canUseTool promise
  v
Claude query continues and emits normal AG-UI events under newRunId
```

### 3.3 状态机

#### UI message status

| Event | Assistant message status | Metadata |
| --- | --- | --- |
| `RUN_STARTED` | `running` | none |
| `RUN_FINISHED outcome=interrupt` | `requires-action / interrupt` | `custom.agui.interrupts` |
| `submitInterruptResponses()` called | previous message set to `complete` locally | interrupts cleared |
| resumed continuation produces output | new assistant message `running -> complete` | normal metadata |

#### API / worker state

| State | Meaning | Can accept new normal user message? | Can accept interrupt resume? |
| --- | --- | --- | --- |
| `running` | SDK actively streaming or executing | no | no |
| `requires_action` | AG-UI run ended, SDK continuation suspended | no normal append unless user cancels | yes |
| `finished` | no continuation left | yes | no |
| `cancelled/error` | no continuation left | yes | no |

Conversation-level state should remain compatible with existing DTO:

- `activeRunStatus="running"` while normal run is active.
- `pendingUserAction="question"` while interrupt is pending.
- When a run enters `requires_action`, composer should be blocked by AG-UI pending interrupt rather than by `activeRunStatus`.
- On resume or cancel, clear `pendingUserAction`.

Open implementation choice:

1. Keep `activeRunStatus="running"` for `requires_action`.
2. Or set `activeRunStatus="idle"` and rely on `pendingUserAction`.

Recommendation: use option 2 after auditing composer/sidebar guards. It matches AG-UI `isRunning=false` and avoids blocking the resume `/agent/run` as a normal concurrent run. If option 1 is kept, `AgentRunHandler` must special-case `input.resume` to bypass the normal active-run conflict.

---

## 4. Interrupt Payload

### 4.1 Shared metadata shape

```ts
type AgeworkInterruptMetadata =
  | {
      kind: "ask_question";
      questions: AskUserQuestionItem[];
      toolCallId?: string;
    }
  | {
      kind: "permission";
      toolName: string;
      toolInputPreview: unknown;
      title: string;
      description?: string;
      canAlwaysAllow: boolean;
    };
```

Do not put writeable permission suggestions in metadata. If needed for display, expose only a safe preview.

### 4.2 AskUserQuestion

```jsonc
{
  "id": "<uuid>",
  "reason": "input_required",
  "message": "<first question text>",
  "responseSchema": {
    "type": "agework.ask_question",
    "questions": [/* original questions */]
  },
  "metadata": {
    "agework": {
      "kind": "ask_question",
      "questions": [/* original questions */],
      "toolCallId": "<optional sdk tool_use id>"
    }
  }
}
```

Resume response:

```ts
{
  interruptId,
  status: "resolved",
  payload: { answers: Record<string, string | string[]> },
}
```

Adapter result:

```ts
{
  behavior: "allow",
  updatedInput: { questions, answers },
}
```

### 4.3 AskUserPermission

```jsonc
{
  "id": "<uuid>",
  "reason": "confirmation",
  "message": "<permission title>",
  "toolCallId": "<blocked SDK toolUseID if available>",
  "metadata": {
    "agework": {
      "kind": "permission",
      "toolName": "Write",
      "toolInputPreview": { /* redacted/summarized */ },
      "title": "...",
      "description": "...",
      "canAlwaysAllow": true
    }
  }
}
```

Resume responses:

```ts
// allow once
{ interruptId, status: "resolved", payload: { approved: true, persist: false } }

// always allow; adapter uses server-side saved suggestions
{ interruptId, status: "resolved", payload: { approved: true, persist: true } }

// deny tool, but do not cancel the whole run
{ interruptId, status: "resolved", payload: { approved: false } }

// abandon the pending interrupt / cancel current continuation
{ interruptId, status: "cancelled" }
```

Adapter mapping:

| Payload | `PermissionResult` |
| --- | --- |
| `approved=true, persist=false` | `{ behavior: "allow", updatedInput: toolInput }` |
| `approved=true, persist=true` | `{ behavior: "allow", updatedInput: toolInput, updatedPermissions: savedPersistableSuggestions }` |
| `approved=false` | `{ behavior: "deny", message: "用户拒绝了该工具请求。" }` |
| `status=cancelled` | reject continuation and interrupt SDK query |

---

## 5. 后端设计

### 5.1 Adapter: pendingInterrupts

新增 per-thread pending interrupt registry。它不是 UI store，而是 Claude SDK continuation 的 owner。

```ts
type PendingInterrupt = {
  threadId: string;
  originalRunId: string;
  interrupt: AgUiInterrupt;
  kind: "ask_question" | "permission";
  toolInput?: Record<string, unknown>;
  questions?: unknown[];
  savedPersistableSuggestions?: PermissionUpdate[];
  resolve: (result: PermissionResult) => void;
  reject: (error: Error) => void;
};
```

`canUseTool` 处理：

1. 生成 interrupt id。
2. 保存 `PendingInterrupt`。
3. emit `RUN_FINISHED outcome=interrupt`。
4. 通知 worker/API 此 run 进入 `requires_action`。
5. 返回一个等待 `applyResume()` 的 promise。

Important:

- 不再为 `AskUserPermission` 合成 `TOOL_CALL_START/ARGS`。
- 如果同 thread 已有 pending interrupt，必须先 reject 旧 continuation 或排队；权限请求继续沿用当前 per-thread queue 策略。
- `AbortSignal` abort 时清理 `pendingInterrupts`。

### 5.2 Adapter: applyResume

```ts
applyResume(threadId: string, resume: AgUiResumeEntry[], newRunId: string): boolean {
  const pending = this.pendingInterrupts.get(threadId);
  if (!pending) return false;

  const entry = resume.find((r) => r.interruptId === pending.interrupt.id);
  if (!entry) throw new Error("resume missing pending interrupt");

  this.pendingInterrupts.delete(threadId);

  if (entry.status === "cancelled") {
    pending.reject(new Error("interrupt cancelled"));
    return true;
  }

  pending.resolve(toPermissionResult(pending, entry.payload));
  return true;
}
```

`newRunId` matters because events emitted after resume must be associated with the run created by `submitInterruptResponses()`, not the original interrupted run.

### 5.3 Worker: suspended continuation routing

Persistent worker needs a state separate from active runs:

```ts
type SuspendedRun = {
  agentType: AgentType;
  aguiThreadId: string;
  originalRunId: string;
  interruptIds: string[];
};
```

RunRouter behavior:

1. Track the last emitted `RUN_FINISHED` event.
2. If Observable completes after `outcome=interrupt`, do not report `finished`.
3. Move run from `runs` to `suspended`.
4. Report `requires_action`.
5. On `resume` control, find suspended entry by `conversationId`, bind `newRunId`, call `adapter.applyResume(...)`.
6. Events after the resolver is released are emitted under `newRunId`.
7. When resumed continuation finishes, report terminal status for `newRunId` and clear suspended state.

Cancel behavior:

- Cancel while running: existing `interrupt(runId)` path.
- Cancel while suspended: reject pending interrupt, interrupt SDK query, clear suspended state, report cancelled for the suspended/original run if needed.

### 5.4 API: distinguish normal run from interrupt resume

`RunAgentInput` should include the AG-UI field:

```ts
export interface RunAgentInput {
  threadId: string;
  runId?: string;
  resume?: AgUiResumeEntry[];
  messages?: AssistantUserMessage[];
  forwardedProps?: {
    agentType?: string;
    modelProviderId?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}
```

`AgentRunHandler.run()` must branch early:

```ts
if (body.resume?.length) {
  return this.runtimeRunner.resumeInterrupt({
    conversationId,
    runId,
    resume: body.resume,
    res,
    user,
    forwardedProps,
  });
}
```

Resume branch responsibilities:

1. Verify conversation ownership and workspace.
2. Find a suspended/`requires_action` run for this conversation.
3. Create a new run record for the resumed stream, or explicitly document reusing the old run record. Recommendation: create a new run record because assistant-ui generated a new run id.
4. Attach the SSE response to the new run id.
5. Send worker control `{ type: "resume", conversationId, runId, resume }`.
6. Do not save a new user message; this is not a new user turn.
7. Clear `pendingUserAction` after resume is accepted.

Normal branch:

- Remove `interruptReason=user_steered`.
- Keep regular active-run conflict checks.
- If pending interrupt exists and this is not `resume`, reject with a clear error.

### 5.5 Shared control protocol

Use a single canonical resume control. Do not keep `approval_resolved` in V2.

```ts
export type ControlPayload =
  | { type: "cancel"; commandId: string; runId: string; conversationId: string }
  | {
      type: "resume";
      commandId: string;
      runId: string;
      conversationId: string;
      resume: AgUiResumeEntry[];
    }
  | {
      type: "user_message";
      commandId: string;
      runId: string;
      input: unknown;
    };
```

Feature-flag coexistence:

- `AGUI_INTERRUPT_V2=false`: keep old `approval_resolved`.
- `AGUI_INTERRUPT_V2=true`: use `resume`.
- Do not translate `answers -> resume` in worker by guessing interrupt id.

### 5.6 RuntimeMessageAggregator

The API-side aggregator already needs explicit interrupt handling because it persists assistant-ui messages independently of frontend runtime.

Keep behavior:

```ts
if (event.outcome?.type === "interrupt") {
  status = { type: "requires-action", reason: "interrupt" };
  metadata.custom.agui.interrupts = event.outcome.interrupts;
}
```

Add tests for:

- `RUN_FINISHED outcome=interrupt` persists `requires-action / interrupt`.
- metadata includes `custom.agui.interrupts`.
- empty or malformed interrupts are ignored or handled consistently with frontend parser.

---

## 6. 前端设计

### 6.1 InterruptPanel

Replace `PendingQuestionPanel` with an interrupt-driven panel:

```tsx
const pending = runtime.unstable_getPendingInterrupts?.() ?? [];
```

or read from the last assistant message:

```ts
const lastAssistant = messages.findLast((m) => m.role === "assistant");
const interrupts =
  lastAssistant?.status?.type === "requires-action" &&
  lastAssistant.status.reason === "interrupt"
    ? lastAssistant.metadata?.custom?.agui?.interrupts
    : undefined;
```

Rendering:

- `metadata.agework.kind="ask_question"` -> existing question UI.
- `metadata.agework.kind="permission"` -> existing permission UI.
- unknown kind -> generic fallback showing `interrupt.message`.

### 6.2 Submit

Question:

```ts
runtime.unstable_submitInterruptResponses([
  { interruptId: interrupt.id, status: "resolved", payload: { answers } },
]);
```

Permission:

```ts
runtime.unstable_submitInterruptResponses([
  {
    interruptId: interrupt.id,
    status: "resolved",
    payload: { approved: true, persist: false },
  },
]);
```

Always allow:

```ts
runtime.unstable_submitInterruptResponses([
  {
    interruptId: interrupt.id,
    status: "resolved",
    payload: { approved: true, persist: true },
  },
]);
```

Deny:

```ts
runtime.unstable_submitInterruptResponses([
  {
    interruptId: interrupt.id,
    status: "resolved",
    payload: { approved: false },
  },
]);
```

Abandon:

```ts
runtime.unstable_submitInterruptResponses([
  { interruptId: interrupt.id, status: "cancelled" },
]);
```

### 6.3 Composer behavior

assistant-ui will reject append/reload/resume while interrupts are pending. This is good; the composer should expose it as product behavior.

Recommended UX:

- Disable normal send while interrupt is pending.
- Show concise inline hint: `请先处理当前确认，或取消后再发送。`
- Provide a command button: `取消并发送`:
  1. submit all pending interrupts as `cancelled`;
  2. after cancellation resolves, send the new user message.

Do not reintroduce `interruptReason=user_steered`.

### 6.4 History adapter

For AG-UI interrupt messages:

- Do not normalize `requires-action / interrupt` to `running`.
- Do not call `unstable_resume` for interrupt state.
- Return persisted messages as-is.

Keep normal stream refresh behavior for true `running` runs.

---

## 7. Migration Plan

### Phase 0: Dependency and contracts

1. Align `@ag-ui/client` versions across web and adapters.
2. Add shared `AgUiResumeEntry` / interrupt payload types, or import from one stable package boundary.
3. Add feature flag `AGUI_INTERRUPT_V2`.
4. Add tests around existing API aggregator interrupt persistence.

Exit criteria:

- Typecheck passes.
- Existing old interrupt flow unchanged with flag off.

### Phase 1: Persistent worker backend spike

1. Implement adapter `pendingInterrupts` and `applyResume`.
2. Emit `RUN_FINISHED outcome=interrupt` from Claude interrupt points.
3. Add RunRouter suspended state.
4. Add `resume` control in persistent worker.
5. Keep local worker on old flow under flag.

Spike must answer:

- Does `subscriber.complete()` unsubscribe or abort the SDK query?
- Can the worker keep the SDK query alive while reporting run `requires_action`?
- Can events after `applyResume()` be emitted under the new run id?

Exit criteria:

- One `AskUserQuestion` reaches frontend as `requires-action / interrupt`.
- `submitInterruptResponses()` resumes the same Claude query in persistent worker.
- Cancel while suspended releases resolver and does not leak active run state.

### Phase 2: API resume branch

1. Add `RunAgentInput.resume`.
2. Add `RuntimeRunner.resumeInterrupt()`.
3. Route `/agent/run` with `resume` to suspended continuation, not normal start.
4. Remove `interruptReason=user_steered` from V2 path.
5. Persist run/message status correctly.

Exit criteria:

- Resume request does not save an extra user message.
- Conversation pending action clears after resume/cancel.
- Refresh while pending shows interrupt panel from persisted metadata.

### Phase 3: Frontend switch

1. Replace `PendingQuestionPanel` with `InterruptPanel`.
2. Reuse existing question/permission UI, but feed it from interrupt metadata.
3. Submit through `unstable_submitInterruptResponses`.
4. Remove pending question replied store path.
5. Add composer pending-interrupt guard and cancel-then-send flow.

Exit criteria:

- AskUserQuestion works before and after refresh.
- AskUserPermission allow/deny/always-allow works before and after refresh.
- Sending a new message while interrupt is pending gives a clear UI path.

### Phase 4: Cleanup

After V2 is stable:

1. Delete old `approval_resolved` control.
2. Delete `resolveQuestion` / `pendingQuestions` old path if no longer used.
3. Delete `interruptReason=user_steered`.
4. Delete runtime-ui-store steer/pendingQuestion fields.
5. Update related docs and tests.

---

## 8. Risks and Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| `subscriber.complete()` aborts or disposes Claude query | Blocks V2 | Spike first; if true, keep Observable open internally and send AG-UI interrupt without disposing SDK continuation |
| local worker loses pending resolver | local V2 impossible | Keep local on old flow until worker lifecycle supports suspended mode |
| old run conflicts with resume run | resume 409/conflict | Add explicit API resume branch and suspended run lookup |
| frontend sends forged permission suggestions | unsafe settings write | Store suggestions server-side; frontend sends only selected action |
| deny modeled as cancel | unnecessary query abort | Use `resolved { approved:false }` for deny |
| dependency version mismatch | type/runtime mismatch | Align `@ag-ui/client` before implementation |
| refresh loses interrupt | user stuck | Persist `requires-action / interrupt` metadata in API aggregator and load as-is |

---

## 9. Open Questions

1. Do we set `Conversation.activeRunStatus` to `idle` or keep `running` during `requires_action`?
   - Recommendation: `idle` + `pendingUserAction="question"` after composer/sidebar audit.
2. Should resumed continuation create a new Run record?
   - Recommendation: yes, because assistant-ui starts a new AG-UI run id.
3. How should local worker support V2 later?
   - Option A: local worker stays alive while suspended and accepts `resume` control.
   - Option B: local remains on old pending tool-call path permanently.
4. How do we expose interrupted runs in admin views?
   - Recommendation: show original run as `requires_action` until resumed/cancelled, and link resumed run id.

---

## 10. Files To Touch

| Area | Files | Notes |
| --- | --- | --- |
| Adapter | `packages/adapters/src/claude/business/claude-agent.adapter.ts` | `pendingInterrupts`, `applyResume`, no client-trusted suggestions |
| Adapter base | `packages/adapters/src/claude/base/adapter.ts` | interrupt cleanup if pending registry lives in base |
| Worker | `apps/worker/src/run-router.ts`, `apps/worker/src/main.ts` | suspended state and `resume` control |
| Shared protocol | `packages/shared/src/protocol/transport.ts` | add `resume`, keep old under flag during migration |
| API input | `apps/api/src/agent/run-agent-input.ts` | add `resume`, remove V2 `interruptReason` |
| API runner | `apps/api/src/agent/agent-run-handler.ts`, `apps/api/src/runtime/core/runtime-runner.ts` | early resume branch |
| API persistence | `apps/api/src/runtime/core/runtime-message-aggregator.ts` | preserve interrupt metadata tests |
| Frontend panel | `apps/web/src/components/assistant-ui/pending-question-panel.tsx` | replace with interrupt-driven panel |
| Frontend UI | `apps/web/src/components/assistant-ui/tools/ask-user-question.tsx` | data source from interrupt metadata |
| Frontend history | `apps/web/src/lib/runtime/thread-history-adapter.ts` | no running normalization for interrupt |
| Frontend store | `apps/web/src/stores/runtime-ui-store.ts` | delete steer/pending question after V2 stable |
| Frontend composer | `apps/web/src/components/assistant-ui/thread-composer.tsx` | pending interrupt guard |

---

## 11. References

- `reference-source-code/assistant-ui/packages/react-ag-ui/src/runtime/types.ts`
- `reference-source-code/assistant-ui/packages/react-ag-ui/src/runtime/AgUiThreadRuntimeCore.ts`
- `reference-source-code/assistant-ui/packages/react-ag-ui/src/runtime/adapter/run-aggregator.ts`
- `reference-source-code/assistant-ui/packages/react-ag-ui/src/runtime/event-parser.ts`
- `packages/adapters/src/claude/business/claude-agent.adapter.ts`
- `apps/worker/src/run-router.ts`
- `apps/api/src/runtime/core/runtime-message-aggregator.ts`
