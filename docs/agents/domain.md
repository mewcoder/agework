# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root, or
- **`CONTEXT-MAP.md`** at the repo root if it exists — it points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in. In multi-context repos, also check `src/<context>/docs/adr/` for context-scoped decisions.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## Layout: multi-context

This is a monorepo with separate contexts (frontend, backend, runtime, worker, providers). ADRs live **per-context** under `<context>/docs/adr/`, not in one global `docs/adr/`. There is no root `docs/adr/`.

The root `CONTEXT-MAP.md` indexes every context and points at its `docs/adr/`. Read it first, then dive into the context(s) relevant to the topic.

Contexts in this repo:

| Context | ADR location |
|---|---|
| `apps/runtime` | `apps/runtime/docs/adr/` |
| `apps/server` runtime module | `apps/server/src/runtime/docs/adr/` |
| `apps/server` runtime-host module | `apps/server/src/runtime-host/docs/adr/` |
| `packages/runtime-sdk` | `packages/runtime-sdk/docs/adr/` |
| `apps/runtime`（含 Worker） | `apps/runtime/docs/adr/` |

If a context has its own `CONTEXT.md` (per-context glossary), read it before working in that context. Most contexts currently have only `docs/adr/`, no `CONTEXT.md` yet — that's fine, `/domain-modeling` creates them lazily.

## File structure

```
/
├── CONTEXT-MAP.md                     ← indexes all contexts
└── (per-context ADR dirs, e.g.)
    apps/runtime/docs/adr/
    apps/server/src/runtime/docs/adr/
    apps/server/src/runtime-host/docs/adr/
    packages/runtime-sdk/docs/adr/
    apps/runtime/docs/adr/
```

Multi-context repo (presence of `CONTEXT-MAP.md` at the root):

```
/
├── CONTEXT-MAP.md
├── docs/adr/                          ← system-wide decisions (none in this repo yet)
└── src/
    ├── ordering/
    │   ├── CONTEXT.md
    │   └── docs/adr/                  ← context-specific decisions
    └── billing/
        ├── CONTEXT.md
        └── docs/adr/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
