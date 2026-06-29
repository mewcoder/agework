# Agent Module Extraction Plan

**Date:** 2026-06-29  
**Status:** Proposed  
**Scope:** `apps/api/src`

## Goal

把“用户跟 agent 打交道”的入口从 `conversation/` 中抽出为平级 `agent/` feature module。

`agent/` 是 **Agent interaction entrypoint owner**：负责用户入口流程，包括创建对话、发起 run、resume、reply、stop、options。它不接管底层 run 生命周期、runtime、worker、adapter 或 model provider ownership。

## Current Problem

当前 agent 入口挂在 `conversation/` 内：

```text
ConversationController
  -> AgentService
      -> ConversationService
      -> WorkspaceService
      -> ModelProviderService
      -> RunService
```

这让 `conversation/` 同时承担两类职责：

- conversation 数据 owner：会话、消息、标题、归档、列表、搜索。
- agent 交互入口 owner：run / resume / reply / stop / options，以及后续 create conversation。

结果是模块关系读起来像 conversation 在编排 run/workspace/model-provider，边界不够清楚。

还有一个更隐蔽的问题：`ConversationService.create(...)` 现在通过
`ConversationRepository.findOwnedWorkspace(...)` 校验 workspace 归属。这个耦合不经过
`WorkspaceModule` import，所以只查 module import 会误判为边界已经干净。create 的 workspace
归属校验必须搬到 `agent/` 经 `WorkspaceService` 完成，并删除 conversation repo 对
`workspace` 表的直接读取。

## Target Boundary

本轮完成后的目标模块关系。注意：`RunConversationPort` bridge debt 本轮只显式保留，不在本计划内清理。

```text
agent/
  AgentController
    -> AgentService
        -> ConversationService
        -> WorkspaceService
        -> ModelProviderService
        -> RunService

conversation/
  ConversationController
    -> ConversationService
        -> ConversationRepository
  ConversationRunBridge
    -> RunService                 (tracked RunConversationPort bridge debt)

run/
  RunService
    -> run lifecycle / status / events / SSE
```

职责分工：

| Module | Owns | Does not own |
|---|---|---|
| `agent/` | 用户跟 agent 交互的入口流程: create conversation, run, resume, reply, stop, options | run lifecycle, runtime, worker, adapter implementation, model provider persistence |
| `conversation/` | conversation/message/title/archive/list/search 数据能力 | agent run 编排、workspace 入口校验、run HTTP 入口 |
| `run/` | 底层 run 生命周期、状态、事件、SSE、worker event 聚合 | 用户入口请求解析、conversation 创建 |
| `workspace/` | workspace 运行视图、目录和 runtime 配置 | agent 入口流程 |
| `model-provider/` | model provider 配置与解析 | agent 入口流程 |

## Naming Decision

使用 `agent/`，不使用 `agent-run/`。

理由：

- `agent/` 能覆盖 create conversation + run/reply/stop/resume/options。
- `agent-run/` 偏窄，容易只表达“执行一次 run”，盖不住创建对话入口。
- `AgentService` 是现有类名，迁移时可保持类名，降低 diff。
- `agent` 已是代码和产品中的领域词，例如 `agentType`、AG-UI agent。

护栏：

- `agent/` 只表示用户入口流程 owner。
- 不把 runtime、worker、adapter、model-provider 配置 ownership 吸入 `agent/`。
- 不新增 `AgentRunOrchestrator` 这类架构角色名；代码按业务名命名。

## Target Structure

```text
apps/api/src/agent/
├── agent.module.ts
├── agent.controller.ts
├── agent.service.ts
├── options/
│   ├── agent-options.ts
│   └── agent-options.spec.ts
└── dto/
    ├── agent-control.dto.ts
    ├── agent-run.dto.ts
    ├── create-conversation.dto.ts        # moved from conversation/ in Phase 2
    ├── create-conversation.dto.spec.ts
    └── ...
```

`AgentModule` imports:

```text
ConversationModule
WorkspaceModule
ModelProviderModule
RunModule
```

`ConversationModule` should stop importing `WorkspaceModule` **in Phase 1**: the only consumer of
`WorkspaceService` inside `conversation/` is `AgentService`, so once it moves out the Nest import is dead.
The repo-level `workspace` table read (`findOwnedWorkspace`) does not need `WorkspaceModule` (it goes through
the global `PrismaModule`), so deleting that read is a separate Phase 2 step.
It can only keep `RunModule` for the tracked `RunConversationPort` bridge debt. It should keep
`ModelProviderModule` in this plan because `TitleService` remains owned by `conversation/` and injects
`ModelProviderService`; moving title generation is a separate refactor, not an implicit side effect of this one.

## Route Strategy

第一轮不改外部 URL，先改 module owner。

Keep existing public routes stable:

```text
GET  /api/v1/conversations/agent/options
POST /api/v1/conversations/agent/run
GET  /api/v1/conversations/agent/resume
POST /api/v1/conversations/agent/reply
POST /api/v1/conversations/agent/stop
POST /api/v1/conversations/create
```

Implementation detail:

- `AgentController` can use the existing route prefixes to preserve frontend compatibility.
- URL naming can be revisited later as a separate API migration.
- Do not mix API route renaming into this module-boundary refactor.

## Phase 1 - Move Existing Agent Entry Points

Objective: move existing agent subfolder out of `conversation/` without changing behavior.

Tasks:

- Create `apps/api/src/agent/agent.module.ts`.
- Move files:
  - `apps/api/src/conversation/agent/agent.service.ts` -> `apps/api/src/agent/agent.service.ts`
  - `apps/api/src/conversation/agent/agent-options.ts` -> `apps/api/src/agent/options/agent-options.ts`
  - `apps/api/src/conversation/agent/agent-options.spec.ts` -> `apps/api/src/agent/options/agent-options.spec.ts`
  - `apps/api/src/conversation/agent/dto/*` -> `apps/api/src/agent/dto/*`
- Create `apps/api/src/agent/agent.controller.ts`.
- Move these handlers from `ConversationController` to `AgentController`:
  - `agent/options`
  - `agent/run`
  - `agent/resume`
  - `agent/reply`
  - `agent/stop`
- Keep route paths stable.
- Register `AgentModule` in `AppModule`.
- Remove `AgentService` from `ConversationModule.providers`.
- Remove `WorkspaceModule` from `ConversationModule.imports` (after `AgentService` leaves it has no
  remaining consumer; the `findOwnedWorkspace` repo read uses global `PrismaModule`, removed in Phase 2).
- Register `agent` in the `FEATURES` set of `apps/api/src/common/module-boundary.spec.ts`, so cross-module
  imports into `agent/` internals (e.g. `agent/dto`) are covered by the boundary guard instead of skipped.
- Update `apps/api/src/common/api-route-convention.spec.ts`: register `AgentController` and move the
  `agent/*` route assertions from `ConversationController` to `AgentController`, while keeping the public
  URL prefix unchanged.
- Fix imports and tests.

Expected dependency improvement:

```text
Before:
conversation -> model-provider
conversation -> workspace
conversation -> run

After Phase 1:
agent -> conversation
agent -> model-provider
agent -> workspace
agent -> run

conversation -> workspace (WorkspaceModule import)            REMOVED in Phase 1
conversation -> workspace (repo-level prisma.workspace read)  STILL PRESENT — tracked debt, removed in Phase 2
conversation -> run                                          STILL PRESENT — RunConversationPort bridge debt
conversation -> model-provider                              STILL PRESENT — TitleService
conversation no longer owns agent entry routes
```

Phase 1 只移除 `WorkspaceModule` 的 Nest import;`findOwnedWorkspace` 的直接 `prisma.workspace`
读取仍是 tracked debt,留到 Phase 2 删。不要在 Phase 1 就用 Phase 4 的 repo 级 rg 检查去验收。

## Phase 2 - Move Conversation Create Entry

Objective: make `agent/` own the “start talking to an agent” entry, including conversation creation.

Tasks:

- Move `POST /conversations/create` handler from `ConversationController` to `AgentController`, keeping the route path stable for now.
- Move `CreateConversationDto` from `conversation/dto/create-conversation.dto.ts` to
  `agent/dto/create-conversation.dto.ts`; `AgentController` imports the agent-owned DTO (no cross-module DTO
  import, per architecture §1.5). Its test cases currently live **inside** `conversation/dto/conversation-id.dto.spec.ts`
  and `conversation.dto.spec.ts` — extract them into `agent/dto/create-conversation.dto.spec.ts` (cannot move a
  whole file). Make `workspaceId` required via class-validator so the manual `workspaceId is required` check drops.
- Add `AgentService.createConversation(...)`.
- In `AgentService.createConversation(...)`, validate workspace ownership through `WorkspaceService`
  before creating the conversation. Add a narrow `WorkspaceService` method if needed, backed by
  `WorkspaceRepository.findOwnedId(...)`.
- **Preserve current API behavior**: a missing/unowned workspace must keep returning `BadRequestException`
  (HTTP 400), matching `ConversationService.create` today. The new `WorkspaceService` validation method (or the
  agent-layer null check) must throw `BadRequest`, NOT `NotFoundException` — do not inherit `workspace.delete`'s
  404 behavior, that would be an accidental status-code drift.
- Change `ConversationService.create(...)` so it only creates conversation data for a pre-validated
  `workspaceId`; it must not read `workspace` or validate workspace ownership itself. Update its target
  signature to **drop `userId`** — it exists today only to feed `findOwnedWorkspace` ownership validation,
  which now lives in `AgentService`; do not leave an unused `userId` in the public service contract.
- Delete `ConversationRepository.findOwnedWorkspace(...)` and update the affected service/repository tests.
- Keep `ConversationService.create(...)` as the conversation persistence capability owner.
- Remove create route from `ConversationController` after tests are adjusted.
- Update `apps/api/src/common/api-route-convention.spec.ts` again so the `create` route assertion belongs
  to `AgentController`, not `ConversationController`.

Why this belongs in `agent/`:

- User intent is “start an agent interaction”.
- Conversation persistence still belongs to `conversation/`.
- `agent/` becomes the entrypoint owner, not the data owner.

## Phase 3 - Slim Conversation Module

Objective: make `conversation/` only own conversation data workflows.

`ConversationController` should keep:

```text
list
search
query
statuses/query
update
archive
unarchive
remove
clear-archived
messages/list
```

`ConversationService` should keep:

```text
conversation data CRUD
message persistence
title generation delegation
active run status fields
pending user action fields
agent session id field
```

`TitleService` stays in `conversation/` for this plan. Therefore `conversation/` has an explicit, accepted
dependency on `model-provider/` until a later title-specific refactor moves that responsibility elsewhere.

But `conversation/` should not own:

```text
agent run request parsing
model provider resolution for agent execution
workspace run view lookup for agent execution
run/reply/stop/resume HTTP entrypoints
```

## Phase 4 - Recheck Module Boundaries

Run module boundary checks after migration:

```text
conversation -> run              only allowed for tracked RunConversationPort bridge debt
conversation -> workspace         should be gone as module import and direct workspace table read
conversation -> model-provider    allowed while TitleService stays in conversation/
agent -> conversation             expected
agent -> workspace                expected
agent -> model-provider           expected
agent -> run                      expected
```

Boundary checks must include repository/model access, not only module imports:

```bash
rg -n "findOwnedWorkspace|prisma\\.workspace" apps/api/src/conversation
rg -n "WorkspaceModule" apps/api/src/conversation
```

Expected result: no direct workspace table read from `conversation/`, and no `WorkspaceModule` import.
Relation filters that scope conversation-owned queries by the caller's workspace ownership can remain, but
conversation must not expose a workspace lookup capability.

Known separate debt:

- `RunConversationPort` is a historical broad port debt.
- This extraction should not expand `RunConversationPort`.
- Reducing `RunConversationPort` belongs to a later boundary cleanup after `agent/` exists.

## Non-Goals

- Do not rename external API routes in this refactor.
- Do not change AG-UI request/response contracts.
- Do not change `RunService` lifecycle behavior.
- Do not change runtime / worker-host execution boundaries.
- Do not move `TitleService` out of `conversation/` in this refactor.
- Do not change the create workspace-error status code: keep HTTP 400 / `BadRequestException`, do not drift to 404.
- Do not introduce `ports/` or `adapters/` directories.
- Do not create an `AgentRunOrchestrator` or other architecture-role class.

## Verification

Follow project instruction: do not automatically build, lint, or open a browser.

Useful targeted checks when implementing:

```bash
pnpm --filter api typecheck
pnpm --filter api test -- agent
pnpm --filter api test -- conversation
```

Expected test updates:

- Move `conversation/agent/*` specs to `agent/*`.
- Add/adjust `AgentController` tests for stable route behavior.
- Update `ConversationController` tests to assert agent routes are no longer owned there.
- Update `apps/api/src/common/api-route-convention.spec.ts` for `AgentController` ownership of
  `agent/*` routes in Phase 1 and `create` in Phase 2.
- Keep ownership/authorization tests for run/resume/reply/stop:
  - unauthorized or non-owner conversation must not call `RunService`.
- Add create-ownership regression coverage: `AgentService.createConversation(...)` must reject a workspace
  not owned by the caller before calling `ConversationService.create(...)`.

## Success Criteria

- `apps/api/src/agent/` exists as a normal feature module with `agent.module.ts`, `agent.service.ts`, and `agent.controller.ts`.
- Existing agent HTTP routes behave the same.
- `ConversationController` no longer injects `AgentService`.
- `ConversationModule` no longer registers `AgentService`.
- `ConversationRepository.findOwnedWorkspace(...)` is deleted.
- `ConversationService.create(...)` does not read or validate workspace ownership, and no longer takes `userId`.
- `ConversationModule` does not import `WorkspaceModule`.
- `CreateConversationDto` lives in `agent/dto/`; no `conversation/` DTO is imported across the module boundary.
- Missing/unowned workspace on create still returns HTTP 400 (`BadRequestException`), unchanged from today.
- `agent` is registered in `module-boundary.spec.ts` `FEATURES`, so imports into `agent/` internals are guarded.
- `apps/api/src/common/api-route-convention.spec.ts` names `AgentController` as the owner for agent entry routes.
- Cross-module imports remain public-surface-only.
- No `forwardRef` or `ModuleRef` is introduced.
- No new business `Port` is introduced.
