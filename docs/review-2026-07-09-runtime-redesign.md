# Code Review — `a4b9bae7`

> refactor: redesign runtime/worker roles and tunnel RPC
> Author: mewcoder | Date: 2026-07-09 21:27
> Scope: 137 files, +3,642 / −2,090

---

## 1. Summary

This commit is a **major architecture refactor** of the runtime/worker subsystem. It
re-aligns runtime/worker roles around a managed/registered split with a
**workerId-keyed** control-plane protocol. The work is driven by 7 design tickets
(`01`–`07`) and backed by two new ADRs (`0005` managed container runtime
process, `0006` composite unique key overturns `0003`).

### Theme of the change

| Before | After |
|--------|-------|
| `builtin` runtime (in-process) | `managed` runtime (in-process `native` + forked `docker`/`opensandbox`) |
| `local` runtimeType | `native` runtimeType |
| `Worker.ownerId` `@unique` (one worker per owner) | composite `@@unique([ownerId, runtimeId, isolationScope])` |
| command/seq identity keyed on `ownerId` | command/seq identity keyed on `workerId` |
| file preview via `wm-0004` owner-scoped file-command channel | file preview on the runtime **tunnel RPC** |
| `LocalRuntime` dispatches to docker/opensandbox providers | `LocalRuntime` = `native` only; container runtimes are separate processes |

---

## 2. Change Breakdown (by ticket)

### Ticket 01 — Main concept & responsibilities (rename builtin→managed, local→native)
Pure mechanical rename across schema, providers, shared protocol, web, and all specs.
- `LocalRuntimeProvider` → `NativeRuntimeProvider`
- `LocalRuntimeSpec` → `NativeRuntimeSpec`
- `builtinRuntimeId()` → `managedRuntimeId()`
- `isBuiltinRuntimeId()` → `isManagedRuntimeId()` + new `isManagedNativeRuntimeId()`
- `RuntimeType "local"` → `"native"`
- `source: "builtin"` → `"managed"`

**Risk: low.** No logic change, but extremely broad (touching every consumer).
A single missed rename would be a TS compile error, so it is self-checking.

### Ticket 02 — DB composite unique key (overturns wm-0003)
`Worker.ownerId @unique` → composite `@@unique([ownerId, runtimeId, isolationScope])`.
This allows the **same owner to run parallel workers** across runtimes/workspaces.

### Ticket 03 — Protocol identity ownerId → workerId
The entire worker-manager control plane (command poll, register, liveness touch,
command queue partition, seq counter) now keys on `workerId` (the `Worker.id`
primary key) instead of `ownerId`.
- Route: `GET /worker/owners/:ownerId/commands` → `GET /worker/:workerId/commands`
- Header: `x-agework-owner-id` → `x-agework-worker-id`
- Env: `AGEWORK_WORKER_OWNER_ID` → `AGEWORK_WORKER_ID`
- `nextOwnerCommand` / `OwnerCommand` envelope removed from shared protocol

### Ticket 04 — Managed container runtime process (new `ManagedRuntimeSupervisor`)
For `docker`/`opensandbox`, the server now **forks a separate `apps/runtime`
process** (same binary as a Registered runtime, but connected via loopback
tunnel) instead of managing containers in-process. `native` stays in-process.
- `RuntimeService.onApplicationBootstrap`: generates a managed token (sha256
  stored in `Runtime.tokenHash`), forks the child via the supervisor.
- `ManagedRuntimeSupervisor`: exponential backoff restart (immediate → 1s → 2s →
  4s → … → 30s cap), idempotent start, SIGTERM on shutdown, clears pending
  timers.
- `RuntimeTunnelHandler.close`: managed runtimes are **not** marked offline on
  disconnect (the supervisor will restart them); only registered runtimes are.

### Ticket 05 — Capability RPC (file preview on tunnel)
File preview (`listFiles` / `readFile` / `listChangedFiles` / `readFileDiff`)
moves from the owner-scoped `wm-0004` file-command channel onto the runtime
**tunnel RPC** (`runtime.list-files`, `runtime.read-file`,
`runtime.list-changed-files`, `runtime.read-file-diff`).
- Deleted: `WorkspaceFileCommandHandler`, `WorkspaceFileCommandStore`,
  `WorkspaceFileCommandController`, `workspace-file-command.ts` protocol,
  `nextOwnerCommand`, `OwnerCommand`, `ensureWorkerForFilePreview`.
- `RuntimeService.listFiles/readFile/listChangedFiles/readFileDiff` now take `runtimeId`
  and route through `runtimeFor(runtimeId)` (LocalRuntime for native, RemoteRuntime
  tunnel for docker/opensandbox/registered).

### Ticket 06 — LocalRuntime narrowed to native
`LocalRuntime` no longer dispatches by `runtimeType` to a provider resolver;
it holds a single `nativeProvider` and serves **only** `managed-native`.
All file/git direct-read methods are retained (they are the native path).

### Ticket 07 — Retire wm-0004 file channel
Covered by Tickets 03 + 05; the owner-scoped file-command channel is gone.

---

## 3. What's Good

1. **Architectural symmetry achieved.** `managed-native` (in-process) vs
   `managed-docker`/`managed-opensandbox`/`registered` (tunnel RPC) — three
   runtime topologies now share one protocol and one process binary. The old
   `LocalRuntime` "越权代理 docker/opensandbox 文件能力" problem is eliminated.

2. **The Supervisor is well-engineered.** Exponential backoff with 30s cap,
   idempotent `startManagedRuntime`, clean shutdown (kills children + clears
   timers), and managed-disconnect-doesn't-mark-offline is the correct
   semantics. The 188-line spec covers immediate-restart, backoff escalation,
   cap, and shutdown-cancels-timer.

3. **Net code deletion.** ~300 lines removed (the entire `wm-0004` channel:
   store, controller, handler, protocol envelope, provisioner method). File
   preview now rides the same tunnel as start/stop/destroy.

4. **Tests migrated in lockstep.** Every spec touched by the rename/protocol
   change was updated (command-queue, dispatcher, provisioner, tunnel,
   supervisor, config, web). No stale test references remain.

5. **Composite unique key is the right call** for multi-runtime parallel
   execution — it is a prerequisite for the workerId-keyed protocol.

---

## 4. Issues & Risks

### P0 — Blockers before merge (only if historical data matters)

> **User note: redeploy from scratch, no historical data.** So these two are
> non-issues here — listed only for completeness.

1. **No Prisma migration.** `schema.prisma` changes `Worker` unique constraint,
   `Run.runtimeType` default `local`→`native`, `Runtime.id` prefix
   `builtin-`→`managed-`. With fresh deploy + `db push --force-reset` this is
   fine. With existing data it would need an id-rewrite migration.

2. **Breaking env/header/path changes.** `AGEWORK_WORKER_OWNER_ID` →
   `AGEWORK_WORKER_ID`, `x-agework-owner-id` → `x-agework-worker-id`,
   route `/worker/owners/*` → `/worker/*`. Any in-flight worker/container
   built against the old contract would fail to register/poll. Fresh deploy
   avoids this.

### P1 — Should fix (correctness / robustness)

3. **Supervisor `state.child` undefined on spawn failure.**
   `supervisor.ts` line ~67: `child: undefined as unknown as ChildProcess` is a
   placeholder, overwritten in `spawnAndAttach`. If `spawnAndAttach`
   throws before assigning `state.child`, a later `onApplicationShutdown`
   calling `state.child.kill("SIGTERM")` will crash. **Fix:** wrap
   `spawnAndAttach` in try/catch and remove the state from `this.processes`
   on failure.

4. **`resolveInstance` became async — heartbeat gap during acquire.**
   Old code called `ownerRunStore.registerRun(runId, ownerId)` *before*
   `provisioner.acquireInstanceForRun`. New code registers `runId → workerId`
   only *after* acquire resolves. During a slow container cold-start, a worker
   reporting events in that window has no `workerId` mapping, so
   `postEvent`'s liveness `touch(workerId)` is skipped — the worker can be
   fenced by `WorkerLivenessSweeper` mid-acquire. The commit message claims
   "早登记的取舍不变", but the behavior actually changed. **Fix:** either
   register before acquire (accepting the old "few ms of stale entry"
   tradeoff), or have the sweeper ignore workers in `starting` status.

5. **`ownerKey` string-concatenation collision risk.**
   `provisioner.ts`: `ownerKey = `${ownerId}:${runtimeId}:${isolationScope}``.
   If any value contains `:`, keys collide. Current values are UUIDs/enums so
   it's safe today, but it's a latent footgun. **Fix:** use a structured
   `Map<{ownerId, runtimeId, scope}, …>` or a separator guaranteed
   outside the value charset.

6. **`AcquireInstanceResult.ready` gained `workerId`.** This is a
   **public shared-protocol type**. Any external consumer (or a separately-built
   Registered runtime manager) depending on the old shape breaks. The
   version-mismatch warning in `registerWorker` acknowledges drift but doesn't
   gate on it.

### P2 — Minor / polish

7. **`resolveRuntimeEntry` now exported** from `runtime-config.ts` and
   imported by `supervisor.ts`. Previously a private helper; now shared. Acceptable,
   but the entry-resolution responsibility is now split across two modules —
   a future change to entry resolution touches both.

8. **Stale `builtin` text in a schema comment.** `Worker` model comment still
   reads awkwardly after a partial edit
   (`/// 同 owner 换过 runtimeType"的旧终态行。立刻物理删就没有这个残留窗口。`).
   Cosmetic; should be cleaned up.

9. **`web` `FileEntry` import moved** from `@agework/shared/protocol` to
   `@agework/shared/filesystem/types`. Correct follow-through of retiring the
   file-command protocol, but worth a repo-wide grep to confirm no other
   consumer still imports `FileEntry` from the old path.

---

## 5. Verdict

**Architecturally sound, well-documented (`design.md` + 7 issue docs + 2
ADRs), tests in lockstep.** The refactor achieves the intended symmetry and
removes a meaningful amount of dead/duplicated code.

Merge-readiness depends on deploy strategy:
- **Fresh deploy (no historical data):** ✅ ready — fix P1 #3 and #4
  opportunistically, the rest are polish.
- **Existing-data deploy:** ⛔ blocked on P0 #1 (migration) + P0 #2
  (deploy coordination).

Recommended follow-ups before/after merge: P1 #3 (supervisor crash on
spawn failure), P1 #4 (liveness gap during acquire), P1 #5 (key collision
hardening).
