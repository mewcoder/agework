---
name: conventional-commit
description: >
  Generate standardized conventional commit messages from staged git changes.
  Use when the user asks to commit staged code, generate a commit message,
  or says "commit", "提交", "提 commit". Also use when preparing commits
  before pushing code.
---

# Conventional Commit

Generate and execute a commit from staged changes with a standardized message.

## Format

```
<type>(<scope>): <description>
```

- **type**: `feat` | `fix` | `refactor` | `docs` | `chore` | `test` | `perf` | `ci` | `build`
- **scope** (optional): `server` | `web` | `worker` | `shared` | `protocol` | `infra`
- **description**: lowercase English, ≤50 chars, no trailing period
- Body (optional): explain **why** not what, wrap at 72 chars

## Type Selection

| Type | When |
|---|---|
| `feat` | New user-facing feature or capability |
| `fix` | Bug fix |
| `refactor` | Code restructuring without behavior change |
| `docs` | Documentation only |
| `chore` | Tooling, config, deps, CI — no production code change |
| `test` | Adding or updating tests only |
| `perf` | Performance improvement |
| `ci` | CI/CD pipeline changes |
| `build` | Build system or external dependency changes |

## Scope Selection

Determine scope from changed file paths:

- `apps/server/` → `server`
- `apps/web/` → `web`
- `apps/worker/` → `worker`
- `packages/shared/` → `shared`
- `packages/protocol/` → `protocol`
- `infra/` → `infra`
- Mixed or root-level → omit scope

## Workflow

1. Run `git diff --cached --stat` to see staged files
2. Run `git diff --cached` to review actual changes
3. Analyze changes and determine type, scope, description
4. If no files are staged, inform the user and stop
5. Present the proposed message to the user for confirmation
6. Execute `git commit` with the approved message

## Rules

- All English, all lowercase
- Description ≤ 50 characters after the colon
- No vague messages: avoid "update", "fix", "changes" without context
- If changes span multiple types, use the dominant type
- If unsure about scope, omit it rather than guess
- Always show the message before committing — never auto-commit silently
