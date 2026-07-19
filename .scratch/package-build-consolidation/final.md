# Package and Build Consolidation

> Date: 2026-07-19
> Core question: How should AgeWork reduce package and build complexity without weakening Runtime/Agent plugin boundaries or changing runtime behavior?
> Related docs: `research-plan.md`, `working.md`
> Exploration: 4 rounds, final verifier PASS

---

## 一、Current state

- Workspace members reduced from 12 to 11 by removing the private `@agework/worker` package boundary.
- The deployable execution package is named `@agework/runtime`; its Host API is exposed through `@agework/runtime/host`.
- Worker and per-run Runner remain distinct runtime components under `apps/runtime/src/worker` and still emit sibling Runtime artifacts.
- Agent SDK, Runtime SDK, adapters, ACP, Docker, OpenSandbox, Shared and React AG-UI retain independent package boundaries.
- Five single-entry SDK/plugin libraries use tsdown CJS emission; Shared retains tsc for its multi-subpath structure.
- Root, Runtime-only and Server-only builds are dependency-aware Turbo workflows. Package build scripts no longer rebuild other workspace packages.
- Platform Claude/Codex SDK installation is a separate non-cacheable package stage backed by an npm lock and local platform fingerprint.

## 二、Comparison

| Dimension | Before | After |
|---|---|---|
| Worker ownership | Private source-only workspace package | Runtime-internal component |
| Library emission | tsc for all emitted libraries | tsdown for five single-entry libraries; tsc for Shared |
| Type validation | tsc | unchanged: tsc `--noEmit` |
| Dependency build ordering | Turbo plus nested filtered builds | Turbo only |
| Platform SDK install | hidden inside Runtime build, unlocked npm install | explicit package task, npm lock, npm ci, local fingerprint |
| Vite cache inputs | global env invalidated every build | Web-specific env and Server `.env` input |

## 三、Gaps

- External Agent plugin installation is still environment-specific across embedded Native and container workers.
- Agent/Runtime dynamic product catalogs remain outside this refactor.
- Shared exports mix several Node/browser subpaths and should be normalized before any tsdown migration.
- Exact tsdown artifacts and ACP's preserved ESM dynamic import require an authorized build smoke before release acceptance.

## 四、Verification records

| Claim | Method | Result |
|---|---|---|
| Target graph is acyclic | Manifest-edge reconstruction and topological order | Passed |
| Worker move remains type-safe | Runtime Host typecheck including moved source/spec tree | Passed |
| SDK/plugin declarations support fast generation | `tsc --noEmit` with `isolatedDeclarations` configuration | Passed after two literal annotations |
| Server consumers remain type-safe | Server typecheck and Prisma generation | Passed |
| Build/package ordering | Turbo dry-run | One Runtime build/package; Runtime package precedes Server package |
| Hidden dependency builds removed | Dry-run command scan | None in build tasks |
| Formatting/whitespace | `git diff --check` | Passed |

## 五、Priority roadmap

| Priority | Item | Scope | Dependency |
|---|---|---|---|
| P0 | Artifact smoke for five tsdown packages | require/import/export and ACP dynamic import | Explicit build authorization |
| P1 | Cross-platform SDK lock validation | macOS/Linux/Windows package stage | CI matrix |
| P1 | External Agent plugin deployment contract | Native + Docker/OpenSandbox Runner | Plugin manifest packaging design |
| P2 | Shared export normalization | multi-entry Node/browser package | Consumer inventory |

## 六、Conclusion

The consolidation removes a package that did not own a real artifact while preserving all intentional plugin and SDK boundaries. Build performance work focuses on eliminating repeated work and separating platform packaging, with tsdown applied only where its single-entry library model fits.

## 七、Blind spots

No repository build, lint, unit test, browser test, Docker build or cross-platform artifact test was run, following project instructions. Type-level and task-graph verification cannot prove emitted module interoperability.
