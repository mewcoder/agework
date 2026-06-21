# Backend Reuse of react-ag-ui RunAggregator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `apps/api`'s `RuntimeMessageAggregator` a thin wrapper around `packages/react-ag-ui`'s `RunAggregator`, eliminating the duplicated AG-UI event state machine that currently exists as two independently-maintained copies (frontend `RunAggregator`, backend hand-copied `RuntimeMessageAggregator`).

**Architecture:** `packages/react-ag-ui` is a workspace package (`@assistant-ui/react-ag-ui`) already used by `apps/web`. We make it consumable from `apps/api` (a CommonJS NestJS service built via plain `tsc`, no webpack bundling) by dropping its `"type": "module"` declaration and making the `react` peer dependency optional — mirroring the convention already used by sibling workspace packages `@agework/shared` and `@agework/adapters` (both ship raw `.ts` source with no `"type"` field and are consumed fine by `apps/api`). We then extract a non-destructive `getSnapshot()` read method out of `RunAggregator`'s private `emit()`, export `RunAggregator` from the package's public entrypoint, and rewrite `apps/api/src/runtime/core/runtime-message-aggregator.ts` to delegate event handling to `RunAggregator` while keeping its own external API (`handle()`, `build()`, types) byte-for-byte identical so no call site in `apps/api` needs to change.

**Tech Stack:** TypeScript, pnpm workspaces, NestJS (apps/api), Vitest (both packages' test suites), `@assistant-ui/react-ag-ui` (packages/react-ag-ui), `@assistant-ui/core` (transitive, not imported directly by apps/api).

## Global Constraints

- Do not change the public API of `apps/api/src/runtime/core/runtime-message-aggregator.ts` (`RuntimeMessageAggregator` constructor signature, `handle(event)`, `build(complete, incompleteReason)`, exported types `AssistantMessageContent`, `IncompleteMessageReason`). Three call sites depend on this exact shape and must not be touched: `apps/api/src/runtime/core/runtime-active-store.ts`, `apps/api/src/runtime/core/runtime-runner.ts`, `apps/api/src/agent/agent-run-handler.ts`.
- Do not import `@assistant-ui/core` directly from any `apps/api` source file. Type the wrapper's internal `status` as `unknown` (matching the original code's own approach) so apps/api never needs `@assistant-ui/core` as a direct/transitive-resolved dependency — avoids a pnpm phantom-dependency problem (apps/api doesn't declare `@assistant-ui/core`, and pnpm's strict linking won't expose it).
- Known, accepted behavior changes from this refactor (project is pre-launch; per `CLAUDE.local.md` no historical-data migration/compatibility is required):
  1. **`status.reason` on normal completion changes from `"stop"` to `"unknown"`.** Today `runtime-message-aggregator.ts` hardcodes `reason: "stop"` on a clean `RUN_FINISHED`; `RunAggregator` hardcodes `reason: "unknown"` for the same case. No runtime code in the repo branches on this exact string (verified via repo-wide grep) — it is a diagnostic-only field. Accept `"unknown"` as the unified value; do not add a translation shim.
  2. **`ACTIVITY_SNAPSHOT` (mcp-apps) tool metadata stamping is newly supported on the backend.** `RunAggregator` stamps `mcp.app.resourceUri` onto resolved tool-call parts when an `ACTIVITY_SNAPSHOT` event with `activityType: "mcp-apps"` arrives; the current backend aggregator has no such case and silently drops this data today. After this refactor, persisted assistant messages will include this metadata when present. This is intentional, not a side effect to suppress.
  3. **`RUN_FINISHED` completion check gains an `event.outcome?.type === "success"` shortcut, dormant in practice.** `RunAggregator` treats a run as complete when `event.outcome?.type === "success" || !hasUnresolvedToolCalls`; the original backend aggregator only checked `!hasUnresolved`. Found during the final whole-branch review (not visible in any single task's diff). Verified dormant: both adapters (`packages/adapters/src/claude/base/adapter.ts`, `codex/base/adapter.ts`) emit `RUN_FINISHED` with a `result` field, never `outcome`, so `event.outcome` is always `undefined` for the real event stream and the new branch never fires — effective behavior is unchanged. No code change made; recorded here so a future reader isn't surprised if an adapter ever starts sending `outcome`.
- `packages/react-ag-ui`'s package name is `@assistant-ui/react-ag-ui` — use that exact string for `pnpm --filter` commands.

---

### Task 1: Make `packages/react-ag-ui` consumable from apps/api's CommonJS build

**Files:**
- Modify: `packages/react-ag-ui/package.json`

**Interfaces:**
- Produces: `@assistant-ui/react-ag-ui` package installable as a plain dependency (not just a `react` peer-bearing one) from a CommonJS consumer. No code symbols change in this task.

- [ ] **Step 1: Confirm baseline is green before touching anything**

Run: `pnpm --filter "@assistant-ui/react-ag-ui" run typecheck && pnpm --filter "@assistant-ui/react-ag-ui" run test`
Expected: both PASS (this is the pre-change baseline; if either fails now, stop and investigate before proceeding — it's unrelated to this plan).

- [ ] **Step 2: Drop `"type": "module"` and make the `react` peer dependency optional**

In `packages/react-ag-ui/package.json`, remove the `"type": "module",` line (currently right after `"license": "MIT",`), and add `react` to `peerDependenciesMeta`:

```json
  "peerDependencies": {
    "@types/react": "*",
    "react": "^18 || ^19"
  },
  "peerDependenciesMeta": {
    "@types/react": {
      "optional": true
    },
    "react": {
      "optional": true
    }
  },
```

(This mirrors how `@assistant-ui/core`'s own `package.json` already marks its `react` peer dependency as optional.)

- [ ] **Step 3: Reinstall to update the lockfile**

Run: `pnpm install`
Expected: completes without errors; `pnpm-lock.yaml` updates to reflect the relaxed peer dependency (no `react` peer warning for non-React consumers).

- [ ] **Step 4: Re-run package verification, plus confirm apps/web is unaffected**

Run: `pnpm --filter "@assistant-ui/react-ag-ui" run typecheck && pnpm --filter "@assistant-ui/react-ag-ui" run test`
Expected: both PASS, same as Step 1 (no behavior changed yet — this step only removed a module-format declaration and relaxed a peer constraint).

Run: `pnpm --filter web typecheck`
Expected: PASS — confirms `apps/web`'s Vite-based consumption of `@assistant-ui/react-ag-ui` is unaffected by dropping `"type": "module"` (Vite/esbuild transform TS source by syntax, not by this field; the sibling packages `@agework/shared`/`@agework/adapters` already prove this pattern works in this monorepo).

- [ ] **Step 5: Commit**

```bash
git add packages/react-ag-ui/package.json pnpm-lock.yaml
git commit -m "chore(react-ag-ui): drop type:module and make react peer optional for backend reuse"
```

---

### Task 2: Extract `getSnapshot()` from RunAggregator and export it for non-UI consumers

**Files:**
- Modify: `packages/react-ag-ui/src/runtime/adapter/run-aggregator.ts`
- Modify: `packages/react-ag-ui/src/index.ts`
- Test: `packages/react-ag-ui/test/run-aggregator.spec.ts`

**Interfaces:**
- Produces: `RunAggregator.getSnapshot(): ChatModelRunResult` — a public, side-effect-free method that returns the same snapshot shape `emit()` already builds, callable repeatedly without resetting internal state. Also newly exported from the package root: `RunAggregator` (class), `RunAggregatorOptions` (type), `AgUiEvent` (type, was previously internal-only).

- [ ] **Step 1: Write the failing test for `getSnapshot()`**

Add to `packages/react-ag-ui/test/run-aggregator.spec.ts` (inside the existing `describe("RunAggregator", ...)` block, e.g. right after the `"streams text content"` test):

```ts
  it("exposes getSnapshot() as a non-destructive read, independent of emit", () => {
    const aggregator = createAggregator(false);

    aggregator.handle({ type: "RUN_STARTED", runId: "r1" } as AgUiEvent);
    aggregator.handle({
      type: "TEXT_MESSAGE_CONTENT",
      delta: "Hello",
    } as AgUiEvent);
    aggregator.handle({ type: "RUN_FINISHED", runId: "r1" } as AgUiEvent);

    const snapshot = aggregator.getSnapshot();
    expect(snapshot.status?.type).toBe("complete");
    const textPart = snapshot.content?.find((part) => part.type === "text");
    expect((textPart as any).text).toBe("Hello");

    // Calling it again must not mutate state or change the result.
    expect(aggregator.getSnapshot()).toEqual(snapshot);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter "@assistant-ui/react-ag-ui" exec vitest run test/run-aggregator.spec.ts -t "exposes getSnapshot"`
Expected: FAIL with `aggregator.getSnapshot is not a function` (the method doesn't exist yet).

- [ ] **Step 3: Extract `getSnapshot()` out of the private `emit()` method**

In `packages/react-ag-ui/src/runtime/adapter/run-aggregator.ts`, replace the existing `private emit(): void { ... }` method (currently lines 403-465, the one that builds `snapshot`/`metadata`/`result` and calls `this.emitUpdate(result)`) with:

```ts
  getSnapshot(): ChatModelRunResult {
    const snapshot: ThreadAssistantMessagePart[] = [];

    for (const part of this.partOrder) {
      if (part.kind === "reasoning") {
        if (this.showThinking) {
          const buffer = this.reasoningParts.get(part.key) ?? "";
          if (buffer.length > 0 || this.activeReasoningKey === part.key) {
            snapshot.push({ type: "reasoning", text: buffer } as const);
          }
        }
        continue;
      }

      if (part.kind === "text") {
        const entry = this.textParts.get(part.key);
        if (entry?.touched) {
          snapshot.push({ type: "text", text: entry.buffer } as const);
        }
        continue;
      }

      const entry = this.toolCalls.get(part.toolCallId);
      if (!entry) continue;
      const toolPart: ToolCallMessagePart = {
        type: "tool-call",
        toolCallId: entry.toolCallId,
        toolName: entry.toolCallName,
        args: (entry.parsedArgs ?? {}) as any,
        argsText: entry.argsText,
        ...(entry.result !== undefined ? { result: entry.result } : {}),
        ...(entry.isError !== undefined ? { isError: entry.isError } : {}),
        ...(entry.mcpAppResourceUri
          ? { mcp: { app: { resourceUri: entry.mcpAppResourceUri } } }
          : {}),
        ...(entry.parentMessageId ? { parentId: entry.parentMessageId } : {}),
        ...(entry.toolMessageId
          ? { unstable_toolMessageId: entry.toolMessageId }
          : {}),
      } as ToolCallMessagePart & { unstable_toolMessageId?: string };
      snapshot.push(toolPart);
    }

    const timing = this.getTiming();
    const metadata = {
      ...(timing ? { timing } : {}),
      ...(this.interrupts
        ? {
            custom: {
              [AG_UI_METADATA_NAMESPACE]: {
                interrupts: this.interrupts,
              } satisfies AgUiCustomMetadata,
            },
          }
        : {}),
    };
    return {
      content: snapshot,
      ...(this.status ? { status: this.status } : undefined),
      ...(Object.keys(metadata).length > 0 ? { metadata } : undefined),
    };
  }

  private emit(): void {
    this.emitUpdate(this.getSnapshot());
  }
```

This is a pure extraction: every internal `this.emit()` call site is untouched and behaves exactly as before, since `emit()` now just delegates to `getSnapshot()`.

- [ ] **Step 4: Run the new test to verify it passes**

Run: `pnpm --filter "@assistant-ui/react-ag-ui" exec vitest run test/run-aggregator.spec.ts -t "exposes getSnapshot"`
Expected: PASS.

- [ ] **Step 5: Run the full existing suite to confirm no regression**

Run: `pnpm --filter "@assistant-ui/react-ag-ui" run test`
Expected: all tests PASS, including the pre-existing ~30 cases in `run-aggregator.spec.ts` (mcp-apps stamping, reasoning ordering, timing metadata, etc.) — none of their assertions touch `emit()` internals directly, so this extraction must not change any result.

- [ ] **Step 6: Drop the unnecessary `"use client"` directive from the production file**

In `packages/react-ag-ui/src/runtime/adapter/run-aggregator.ts`, delete line 1 (`"use client";` followed by the blank line 2). `RunAggregator` contains no browser-only API usage (no DOM, no React hooks) — the directive was inherited from being co-located with client-only files and is meaningless (but harmless) for a backend consumer. Leave `"use client"` in `test/run-aggregator.spec.ts` untouched — it isn't part of this task's scope.

- [ ] **Step 7: Export `RunAggregator`, `RunAggregatorOptions`, and `AgUiEvent` from the package root**

In `packages/react-ag-ui/src/index.ts`, change:

```ts
export { useAgUiRuntime } from "./useAgUiRuntime";
export type { AgUiAssistantRuntime } from "./useAgUiRuntime";
export { fromAgUiMessages } from "./runtime/adapter/conversions";
export type { FromAgUiMessagesOptions } from "./runtime/adapter/conversions";
export type {
  AgUiInterrupt,
  AgUiInterruptReason,
  AgUiResumeEntry,
  AgUiRunFinishedOutcome,
  UseAgUiRuntimeOptions,
  UseAgUiRuntimeAdapters,
  UseAgUiThreadListAdapter,
} from "./runtime/types";
```

to:

```ts
export { useAgUiRuntime } from "./useAgUiRuntime";
export type { AgUiAssistantRuntime } from "./useAgUiRuntime";
export { fromAgUiMessages } from "./runtime/adapter/conversions";
export type { FromAgUiMessagesOptions } from "./runtime/adapter/conversions";
export { RunAggregator } from "./runtime/adapter/run-aggregator";
export type { RunAggregatorOptions } from "./runtime/adapter/run-aggregator";
export type {
  AgUiEvent,
  AgUiInterrupt,
  AgUiInterruptReason,
  AgUiResumeEntry,
  AgUiRunFinishedOutcome,
  UseAgUiRuntimeOptions,
  UseAgUiRuntimeAdapters,
  UseAgUiThreadListAdapter,
} from "./runtime/types";
```

- [ ] **Step 8: Run typecheck and the full test suite once more**

Run: `pnpm --filter "@assistant-ui/react-ag-ui" run typecheck && pnpm --filter "@assistant-ui/react-ag-ui" run test`
Expected: both PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/react-ag-ui/src/runtime/adapter/run-aggregator.ts packages/react-ag-ui/src/index.ts packages/react-ag-ui/test/run-aggregator.spec.ts
git commit -m "feat(react-ag-ui): expose RunAggregator.getSnapshot() and export RunAggregator for backend reuse"
```

---

### Task 3: Rewrite apps/api's RuntimeMessageAggregator as a thin wrapper around RunAggregator

**Files:**
- Modify: `apps/api/package.json`
- Modify: `apps/api/src/runtime/core/runtime-message-aggregator.ts`
- Test: `apps/api/src/runtime/core/runtime-message-aggregator.spec.ts`

**Interfaces:**
- Consumes: `RunAggregator`, `RunAggregatorOptions`, `AgUiEvent` from `@assistant-ui/react-ag-ui` (produced by Task 2). `RunAggregator.getSnapshot(): ChatModelRunResult` with shape `{ content: unknown[]; status?: unknown; metadata?: Record<string, unknown> }`.
- Produces: `RuntimeMessageAggregator` class — **unchanged external shape**: `new RuntimeMessageAggregator()`, `.handle(event: { type: string; [key: string]: unknown })`, `.build(complete: boolean, incompleteReason?: IncompleteMessageReason): AssistantMessageContent`. Exported types `AssistantMessageContent` and `IncompleteMessageReason` keep their exact existing field names/values so `runtime-active-store.ts`, `runtime-runner.ts`, and `agent-run-handler.ts` require zero changes.

- [ ] **Step 1: Add the workspace dependency**

In `apps/api/package.json`, add to `"dependencies"` (alphabetical position, next to the other `@a*` scoped packages):

```json
    "@assistant-ui/react-ag-ui": "workspace:*",
```

Run: `pnpm install`
Expected: completes without errors; `apps/api/node_modules/@assistant-ui/react-ag-ui` resolves to the workspace package (symlink).

- [ ] **Step 2: Write failing tests that lock in behavior the rewrite must preserve or intentionally change**

Add to `apps/api/src/runtime/core/runtime-message-aggregator.spec.ts`, after the existing three tests:

```ts
  it("reports the server messageId from TEXT_MESSAGE_START", () => {
    const aggregator = new RuntimeMessageAggregator();
    aggregator.handle({ type: "RUN_STARTED" });
    aggregator.handle({ type: "TEXT_MESSAGE_START", messageId: "msg-1", role: "assistant" });
    aggregator.handle({ type: "TEXT_MESSAGE_CONTENT", messageId: "msg-1", delta: "hello" });
    aggregator.handle({ type: "RUN_FINISHED" });

    expect(aggregator.build(true).messageId).toBe("msg-1");
  });

  it("reports complete/unknown for a normal RUN_FINISHED (shared with the frontend aggregator)", () => {
    const aggregator = new RuntimeMessageAggregator();
    aggregator.handle({ type: "RUN_STARTED" });
    aggregator.handle({ type: "TEXT_MESSAGE_CONTENT", delta: "hello" });
    aggregator.handle({ type: "RUN_FINISHED" });

    expect(aggregator.build(true).status).toEqual({
      type: "complete",
      reason: "unknown",
    });
  });

  it("stamps mcp-apps activity snapshots onto resolved tool calls (newly shared with the frontend aggregator)", () => {
    const aggregator = new RuntimeMessageAggregator();
    aggregator.handle({ type: "RUN_STARTED" });
    aggregator.handle({ type: "TOOL_CALL_START", toolCallId: "tool1", toolCallName: "show_map" });
    aggregator.handle({
      type: "TOOL_CALL_RESULT",
      toolCallId: "tool1",
      content: '{"ok":true}',
      role: "tool",
    });
    aggregator.handle({
      type: "ACTIVITY_SNAPSHOT",
      activityType: "mcp-apps",
      content: { resourceUri: "ui://srv/mcp-app.html" },
    });

    const snap = aggregator.build(false);
    const toolPart = snap.content.find(
      (part: any) => part.type === "tool-call",
    ) as any;
    expect(toolPart.mcp).toEqual({ app: { resourceUri: "ui://srv/mcp-app.html" } });
  });
```

- [ ] **Step 3: Run the new tests to verify they fail**

Run: `pnpm --filter api test -- runtime-message-aggregator.spec.ts`
Expected: FAIL — `messageId` is `undefined` instead of `"msg-1"`, status `reason` is `"stop"` instead of `"unknown"`, and the mcp-apps test fails because `toolPart` has no `mcp` field (current implementation has no `ACTIVITY_SNAPSHOT` handling at all).

- [ ] **Step 4: Replace the implementation**

Replace the entire contents of `apps/api/src/runtime/core/runtime-message-aggregator.ts` with:

```ts
// Thin persistence wrapper around @assistant-ui/react-ag-ui's RunAggregator.
// Delegates the AG-UI event state machine to RunAggregator and adds the
// backend-only concern of building a point-in-time snapshot for persistence
// (build() may be called many times during a run, not just once at the end).

import { RunAggregator, type AgUiEvent } from "@assistant-ui/react-ag-ui";

export type AssistantMessageContent = {
  messageId: string | undefined;
  content: unknown[];
  status: unknown;
  metadata?: Record<string, unknown>;
};

export type IncompleteMessageReason =
  | "streaming"
  | "cancelled"
  | "error"
  | "user_steered";

export class RuntimeMessageAggregator {
  private readonly aggregator: RunAggregator;
  private serverMessageId: string | undefined;

  constructor() {
    this.aggregator = new RunAggregator({
      // Backend persists reasoning regardless of UI display preference.
      showThinking: true,
      logger: { debug: () => {}, error: () => {} },
      // No streaming consumer here; build() pulls a snapshot on demand instead.
      emit: () => {},
      onServerMessageId: (id) => {
        if (!this.serverMessageId) this.serverMessageId = id;
      },
    });
  }

  handle(event: { type: string; [key: string]: unknown }): void {
    this.aggregator.handle(event as AgUiEvent);
  }

  build(
    complete: boolean,
    incompleteReason: IncompleteMessageReason = "streaming"
  ): AssistantMessageContent {
    const snapshot = this.aggregator.getSnapshot();

    return {
      messageId: this.serverMessageId,
      content: snapshot.content,
      status: complete
        ? (snapshot.status ?? { type: "complete", reason: "stop" })
        : this.incompleteStatus(snapshot.status, incompleteReason),
      ...(snapshot.metadata ? { metadata: snapshot.metadata } : {}),
    };
  }

  private incompleteStatus(status: unknown, reason: IncompleteMessageReason) {
    if (
      status &&
      typeof status === "object" &&
      "type" in status &&
      status.type === "incomplete"
    ) {
      if (reason !== "streaming") return { ...status, reason };
      return status;
    }

    return { type: "incomplete", reason };
  }
}
```

- [ ] **Step 5: Run the full aggregator spec file to verify all tests pass**

Run: `pnpm --filter api test -- runtime-message-aggregator.spec.ts`
Expected: all 6 tests PASS (the original 3 plus the 3 added in Step 2).

- [ ] **Step 6: Run the wider apps/api test suite to confirm no regression in call sites**

Run: `pnpm --filter api test -- runtime-event-processor.spec.ts runtime-runner.spec.ts agent-run-handler.spec.ts`
Expected: all PASS — these files construct `new RuntimeMessageAggregator()` and call `.handle()`/`.build()` exactly as before; none of them assert on the `"stop"` vs `"unknown"` reason string (verified during planning via repo-wide grep), so none should break.

- [ ] **Step 7: Typecheck apps/api**

Run: `pnpm --filter api typecheck`
Expected: PASS — confirms no file anywhere in `apps/api` imports `@assistant-ui/core` directly and that the wrapper's `unknown`-typed status doesn't trip any consumer's type expectations.

- [ ] **Step 8: Commit**

```bash
git add apps/api/package.json pnpm-lock.yaml apps/api/src/runtime/core/runtime-message-aggregator.ts apps/api/src/runtime/core/runtime-message-aggregator.spec.ts
git commit -m "refactor(api): delegate RuntimeMessageAggregator to react-ag-ui's RunAggregator"
```

---

### Task 4: Full-repo verification

**Files:** none (verification only — no code changes in this task).

**Interfaces:** none.

- [ ] **Step 1: Run the full apps/api test suite**

Run: `pnpm test:api`
Expected: PASS in full (not just the files touched in Task 3) — catches any indirect consumer of `runtime-message-aggregator.ts` missed during planning.

- [ ] **Step 2: Run the full packages/react-ag-ui test suite**

Run: `pnpm --filter "@assistant-ui/react-ag-ui" run test`
Expected: PASS in full.

- [ ] **Step 3: Typecheck everything**

Run: `pnpm typecheck`
Expected: PASS for every workspace package, including `apps/web` (confirms the Task 1 package.json edit didn't regress the frontend's existing consumption of `@assistant-ui/react-ag-ui`) and `apps/api`.

- [ ] **Step 4: Confirm and report**

No commit in this task (nothing changed). If all three checks above are green, the refactor is complete: `apps/api` now reuses `packages/react-ag-ui`'s `RunAggregator` instead of maintaining an independent copy of the AG-UI event state machine, and the two intentional behavior changes documented in Global Constraints are in effect.
