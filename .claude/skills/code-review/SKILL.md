---
name: code-review
description: >
  Review staged git changes for correctness, style, and potential issues.
  Use when the user says "审查暂存区代码", "review 暂存区", "暂存区代码审查",
  "codereview", "review 代码", "审查代码", "review一下", or similar review requests.
---

# Code Review

Analyze staged (or unstaged) git changes and produce a structured review report.

## Trigger Phrases

- 审查暂存区代码 / 暂存区代码审查 / 暂存区代码审核
- review 暂存区 / codereview 暂存区
- review 一下代码 / 审查代码 / 审查最新提交
- review 一下 / Code review

## Workflow

### 1. Identify Changes

```bash
git diff --cached --stat       # staged changes (default)
git diff --stat                # unstaged changes (fallback)
git status --short             # overall status
```

- If staged changes exist → review staged
- If no staged but unstaged changes exist → review unstaged
- If neither → inform user and stop

### 2. Read Full Diff

```bash
git diff --cached              # or git diff if unstaged
```

Read the full diff. For large diffs, read in chunks but cover all changed files.

### 3. Read Context

For each changed file, read enough surrounding context to understand the change in isolation. Use `grep` to find related usages when a change affects a public interface.

### 4. Validate (Optional but Recommended)

Run project linters and type checks if available:

```bash
pnpm lint 2>&1 | tail -30
pnpm typecheck 2>&1 | tail -30
```

### 5. Analyze

Check each change for:

| Category | What to look for |
|----------|-----------------|
| **Correctness** | Logic errors, off-by-one, null/undefined, race conditions, missing error handling |
| **Consistency** | Naming conventions, file organization, existing patterns in the codebase |
| **Type Safety** | `any` casts, missing types, unsafe assertions |
| **Performance** | Unnecessary re-renders, N+1 queries, missing memoization, large bundle additions |
| **Security** | Hardcoded secrets, SQL injection, XSS, unsafe serialization |
| **Dead Code** | Imports/variables/functions made unused by this change |
| **Style** | Formatting inconsistencies, overly complex logic that could be simplified |

### 6. Report

Produce a structured review with:

```markdown
## Review Summary

**Files reviewed**: N files
**Issues found**: N (critical: X, warning: Y, suggestion: Z)

### Critical Issues
- `file.ts:42` — description of the issue

### Warnings
- `file.ts:100` — description

### Suggestions
- `file.ts:55` — description

### Positive Notes
- What was done well (optional, keep brief)
```

### 7. Offer Fixes (Optional)

If the user asks to fix issues, or if fixes are straightforward:
- Apply fixes with `edit`
- Re-run validation (lint/typecheck)
- Confirm fixes pass

## Rules

- Focus on the **changed lines** — don't review unrelated code
- Be specific: cite file paths and line numbers
- Distinguish severity: critical (must fix) vs warning (should fix) vs suggestion (nice to have)
- If changes are clean, say so — don't manufacture issues
- All feedback in the user's language (Chinese if they write Chinese)
- Don't auto-commit unless the user explicitly asks
