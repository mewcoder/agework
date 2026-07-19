# Package and Build Consolidation — Working Document

## Round 1 — Baseline map

### Package responsibilities and boundaries

- The workspace has 12 non-root packages/apps: three apps and nine `packages/*` entries. The dependency graph derived from manifests is acyclic.
- Strong package/deployment boundaries: `server`, `web`, `@agework/runtime`, `@agework/shared`, `@assistant-ui/react-ag-ui`, both plugin SDK contracts, and the optional OpenSandbox dependency boundary.
- The user has explicitly chosen Docker and ACP as separate official plugin/example packages. Their independent maintenance and example value is therefore a product requirement even though bundled production artifacts statically include them.
- `@agework/worker` has a real process responsibility but no independent publish or artifact lifecycle: its only production consumer is `apps/runtime`, which bundles its source into `main.js` and `runner.js`. It is the strongest package-removal candidate.
- `@agework/adapters` is also private/source-only and only used in production by the Worker bundled plugin. Moving it would reduce a package, but Claude/Codex form a coherent implementation/test area and the current user direction favored keeping Worker and adapters together until expansion requires more separation. Decision remains open pending later rounds.
- `@agework/agent-sdk` and `@agework/runtime-sdk` are separate logical ABIs. Whether they need two npm packages or can be one `@agework/plugin-sdk` with `/agent` and `/runtime` exports remains open.

### Plugin and deployment chain

- Runtime Host has only Native internally; Docker and configured external Runtime plugins enter the same registry. Docker is statically bundled, OpenSandbox is optional/dynamic.
- Worker registers Claude/Codex and ACP bundled Agent plugins, then loads configured external Agent packages by dynamic `import(packageName)` in the per-run Runner.
- `apps/runtime` emits `main.js`, `runner.js`, and `host.cjs`. Server consumes `host.cjs` and embeds the two ESM runtime artifacts.
- Claude/Codex SDKs must remain real external installs because they resolve platform binaries relative to their own installed package location.
- External Agent plugin installation is not yet uniform across embedded Native, standalone Native, and container workers. This is a pre-existing deployment gap and constrains claims in plugin documentation.

### Build graph

- Library emission currently uses `tsc` for shared, both SDKs, Docker, OpenSandbox, and ACP. Runtime uses esbuild; Web uses Vite; Server uses Nest CLI; Desktop uses tsc.
- Turbo already declares `build.dependsOn = ["^build"]`, but Server and Runtime build scripts manually invoke dependency builds again. Turbo cannot deduplicate commands hidden inside a task script, so a root `turbo build` repeats work.
- Direct filtered builds rely on those manual calls because several workspace exports resolve runtime code to `dist`. A safe cleanup needs either dependency-inclusive invocation, source-aware bundling conditions, or a dedicated orchestration command; simply deleting calls would break documented standalone commands.
- The Runtime build also runs a real `npm install` for platform SDKs. That cost is more material than TypeScript emission and should be cached by content/platform if build behavior is changed.
- tsdown is appropriate for single-entry SDK/plugin library emission while `tsc --noEmit` remains the type gate. Without `isolatedDeclarations`, dts generation still falls back to TypeScript, limiting speed gains.
- `@agework/shared` has many subpath exports and mixed browser/Node runtime code; it needs multi-entry/unbundle treatment and should not be the first tsdown migration.

### Manifest and documentation drift

- `apps/server` declares `@agework/adapters` but has no production import.
- `apps/runtime` directly declares `@agework/agent-sdk`, but imports are through Worker/bundled plugins; exact resolution needs re-evaluation after package consolidation.
- Server imports `@agework/runtime/host` in production source and declares `@agework/runtime` as a production dependency.
- `packages/shared/README.md` incorrectly describes the package as pure types and zero runtime/build code.
- Public SDK manifests are not yet fully publication-shaped (`files`, dist types/exports, compatibility/release policy).

### Round 1 open questions

- Merge the two SDK npm packages into one subpath-based SDK, or keep separate install surfaces?
- Move Worker source into Runtime while retaining its process/test boundary?
- Keep adapters as a package, rename it, or make it an internal Runtime area?
- How should direct filtered builds be preserved after removing nested dependency builds?
- Should server artifacts be self-contained outside the monorepo, and how should external Agent plugins be installed into each worker environment?

## Round 2 — Evidence-backed decisions and invariants

### Complete package decisions

| Member | Evidence | Decision |
|---|---|---|
| `apps/runtime` (`@agework/runtime`) | `apps/runtime/package.json` exports Host CJS plus CLI artifacts; Server imports Host and embeds Runtime outputs | Keep deployment/library boundary |
| `apps/server` | Nest production application; imports Runtime Host/SDK, Shared, React AG-UI | Keep; remove unused adapters manifest dependency; treat Runtime Host as production dependency |
| `apps/web` | Vite application consuming Shared and React AG-UI | Keep |
| `packages/shared` | Ten subpath exports and runtime consumers across Server/Web/Runtime/Worker/plugins | Keep cross-app/protocol boundary; correct README |
| `packages/agent-sdk` | `private:false`; Agent plugin ABI consumed by Worker/adapters/ACP | Keep separate for now; external consumption is unverified, and merging couples release/version cadence |
| `packages/runtime-sdk` | `private:false`; Runtime ABI/helpers consumed by Host/Server/Docker/OpenSandbox | Keep separate for now for the same reason |
| `packages/runtime-docker` | Independent peer contract/emission; same plugin registered by builtin and registered Hosts | Keep by explicit user choice and official plugin-example role |
| `packages/runtime-opensandbox` | Isolates Alibaba SDK; optional/dynamic dependency | Keep optional plugin boundary |
| `packages/agent-acp` | Independent ACP SDK dependency and Agent SDK peer; Worker registers it as bundled plugin | Keep by explicit user choice and official plugin-example role |
| `packages/adapters` | Source-only but large dedicated Claude/Codex integration and codegen/test lifecycle | Keep; merging saves little build time and overloads Runtime responsibility |
| `packages/react-ag-ui` | Maintained upstream fork consumed by both Server and Web | Keep fork/synchronization boundary |
| `packages/worker` | Source-only, no artifact; only production consumer is Runtime's two bundle entries | Move into `apps/runtime/src/worker`, preserving process/test boundaries |

This reduces one workspace package without reversing earlier Docker/ACP plugin decisions. Renaming adapters is deferred because it changes references but removes neither a package nor a concept.

### Runtime behavior invariants

1. Runtime plugins continue to depend only on the Runtime SDK and export `createRuntimePlugin()`; allowlisted dynamic loading and registry validation remain unchanged (`packages/runtime-sdk/src/types.ts`, `apps/runtime/src/plugins/runtime-plugin-loader.ts`, `apps/runtime/src/providers/registry.ts`).
2. Agent plugins continue to depend only on the Agent SDK; bundled plugins register before external plugins and each `agentType` has one owner (`packages/agent-sdk/src/types.ts`, `packages/worker/src/agent/index.ts`, loader/registry).
3. Runtime continues to emit `host.cjs`, `main.js`, and sibling `runner.js`; Worker/Runner process isolation does not depend on the npm package boundary.
4. `AGEWORK_AGENT_PLUGINS` continues through Host -> Worker -> Runner, and dynamic import still occurs in Runner.
5. Claude/Codex SDKs remain external real platform installs; Docker installs Linux variants separately.
6. Moving Worker is safe only if role dispatch, sibling Runner derivation, IPC, environment whitelist, dependencies, and tests move intact.

Read-only resolution probes confirmed which exports currently resolve to source versus dist. Fixture-plugin execution across embedded/Docker/OpenSandbox remains unverified and is not broadened into this refactor.

### Build execution evidence

- Turbo dry-run confirms transitive `^build` tasks for Runtime Host and Server filters.
- Hidden nested commands cause major repetition in an uncached root build: Shared `tsc` can run five times, Runtime SDK six, Docker four, Agent SDK/ACP three each, and Runtime twice.
- The repetition exists because plain `pnpm --filter <pkg> build` does not include dependencies, while current runtime exports for SDKs/plugins and Shared rpc/wire point to `dist`.
- Canonical dependency-inclusive builds should be root/Turbo commands; package `build` scripts should emit only themselves. Existing documented plain filtered commands must be updated rather than silently kept with broken semantics.
- Runtime's real npm SDK install and Server embedding are packaging stages, not library dependency builds.
- Turbo env configuration is overly global: Vite env keys invalidate all build tasks, while Web's actual cross-package `apps/server/.env` input is not represented.

### tsdown decision

- Preserve current CJS library behavior. The current `tsc` NodeNext output is CommonJS because packages do not declare `type: module`; an ESM-only migration would be behavioral, especially for `host.cjs` requiring the Runtime SDK.
- First candidates: Agent SDK, Runtime SDK, Docker, OpenSandbox, ACP. Keep `tsc --noEmit` as the type gate.
- CJS tsdown config should use one `src/index.ts` entry, Node 22 target, dts/source maps, and externalize node_modules dependencies.
- Docker and OpenSandbox need one explicit exported-variable annotation each for `isolatedDeclarations`; ACP passed the isolated-declaration check, but its ESM-only ACP SDK still needs emitted-artifact smoke validation before relying on the fastest dts path.
- Defer Shared because it needs multi-entry/unbundle export normalization across browser and Node consumers.
- Latest inspected tsdown metadata requires Node `^22.18.0 || >=24.11.0`; the repository engine floor is only `>=22`, so tooling adoption must align the build environment contract.

### Round 2 decision

Proceed with a conservative consolidation target: move Worker into Runtime, keep the two SDK packages and all official plugin packages, migrate suitable emitted libraries to a shared tsdown convention, remove hidden dependency builds in favor of Turbo orchestration, and clean manifest/docs drift. Later rounds must validate the exact migration surface and reversibility before editing.

## Round 3 — Migration surface and executable design

### Worker move verification

- `packages/worker` has 30 tracked files: 14 production TS files, 11 specs, two docs, and three package/config files.
- Move the source/spec tree unchanged to `apps/runtime/src/worker`; internal relative imports remain valid. Runtime and Worker tsconfig/Vitest configurations are identical.
- Only two production package imports change: Runtime `main.ts` -> internal `worker/worker`, and Runtime `runner.ts` -> internal `worker/runner`.
- Preserve top-level Runtime `main.ts` and `runner.ts` as esbuild entries. The Worker subdirectory avoids a `runner.ts` name collision and leaves sibling-artifact derivation unchanged.
- Runtime already runs the adapters Codex type generator for build/typecheck/test, so Worker's duplicate generator scripts disappear.
- Move Worker dependencies (`adapters`, `agent-acp`, RxJS; Shared and Agent SDK already present) into Runtime and remove the Worker workspace importer.
- Update image staleness paths, CI filters, active docs/context maps, guides, and source comments. Historical archive paths remain unchanged.
- Quantified DX effect: workspace members 12 -> 11; remove one manifest/tsconfig/Vitest config and one public-looking filter name; Runtime absorbs Worker typecheck/test coverage.
- Reversal is a directory extraction plus manifest/import restoration; the private Worker package is explicitly not an external plugin dependency.

### Concrete tsdown convention

- Use tsdown 0.22.9 in the five single-entry emitted libraries. Keep `typecheck: tsc --noEmit`.
- Preserve CommonJS with `format: cjs`, `fixedExtension: true`, Node 22 target, source maps, dts maps, and `deps.skipNodeModulesBundle: true`.
- Runtime manifests resolve to `dist/index.cjs`; workspace `types` continue to resolve source to avoid requiring builds before typecheck. Published SDK declarations can use `publishConfig` later.
- Run isolated-declaration validation with cache disabled. Agent SDK, Runtime SDK, and ACP pass. Docker/OpenSandbox require explicit literal annotations for their exported runtime type constants.
- ACP retains the ESM-only ACP SDK as an external dynamic import; artifact loading remains a required later build smoke, not something typecheck proves.
- Tooling requires Node >=22.18 for current tsdown; update the repository build-engine floor accordingly.

### Concrete build/task separation

- Package `build` emits only its own portable JS/declarations. Turbo owns dependency ordering.
- Add a non-cacheable `package` task for platform/deployment stages:
  - Runtime package installs real platform Claude/Codex SDK dependencies.
  - Server package embeds the completed Runtime artifacts.
- Root/full, Runtime-only, and Server-only commands invoke `turbo run build package` with the appropriate filter, preserving dependency-inclusive workflows without hidden nested builds.
- Worker image creation runs Runtime `build` only, then lets Docker install Linux platform SDKs; it must not install host-platform SDKs first.
- Server/Runtime test commands rely on a Turbo `test.dependsOn: ["^build"]` graph rather than package scripts recursively building dependencies.
- Exclude Runtime platform `dist/node_modules` and Server embedded Runtime output from portable build caching. A local platform/hash stamp should skip an unchanged real SDK install; remote caching it is unsafe.
- Move Vite env keys from global `build.env` to `web#build`, and include Web's actual `apps/server/.env*` dependency.
- Runtime bundles source-only adapters, so its Turbo inputs must include adapters source and codegen script (or adapters must eventually gain its own emitted/codegen task). Worker source becomes a Runtime-local input after the move.

### Reproducible evidence used

- `pnpm turbo run build --dry=json` for task graph and transitive dependencies.
- `import.meta.resolve()` probes for source-vs-dist package resolution.
- `tsc --noEmit --composite false --incremental false --declaration --isolatedDeclarations` for dts compatibility.
- npm metadata and official tsdown option documents for engine/config semantics.
- File/import/reference counts for Worker migration and contributor-command reduction.

### Round 3 remaining risks

- Exact tsdown output and ACP dynamic import cannot be fully validated without an authorized build; configuration will be implemented but final verification is limited to typecheck by project instruction.
- The proposed platform SDK stamp needs a precise lock/hash contract; current `package.docker.json` has no dedicated lockfile.
- Turbo task ordering between Runtime `package` and Server `package` must be verified in dry-run after edits.
- Active documentation has many stale Worker paths; the final consistency search must distinguish current docs from archives/history.

## Round 4 — Final verification before implementation

### Target dependency graph

The post-move graph was independently reconstructed from proposed manifests and topologically sorted. It is acyclic:

```text
agent-sdk, runtime-sdk, shared, react-ag-ui
  -> runtime-docker / runtime-opensandbox / adapters / agent-acp
  -> runtime-host (with internal Worker/Runner)
  -> server

shared + react-ag-ui -> web
```

Exact Runtime dependencies after the move are adapters, ACP, Agent SDK, Docker, optional OpenSandbox, Runtime SDK, Shared, and RxJS. No plugin or SDK points back to Runtime/Server.

### SDK boundary final decision

- Public npm lookups for both AgeWork SDK names returned 404; there is no repository publish workflow or publish configuration. External private consumption remains unknowable.
- Despite no current public release, keep the SDK packages separate: their consumer graphs and ABI evolution are disjoint, while a single package peer version would couple unrelated Agent and Runtime compatibility.
- This is a logical boundary decision, not fear of renaming. A future merge remains possible if unified ABI versioning becomes an explicit product choice.

### Active migration inventory

- 36 non-archive files mention `@agework/worker` or `packages/worker`; 32 require move/update/delete treatment.
- Functional changes are limited to Runtime imports/manifest, CI filters, lockfile importer, and image-staleness inputs. Other changes are maintained docs/context maps/comments.
- Historical archive files and historical ADR bodies retain old paths; the Worker ADR moves under Runtime and a new ADR records package dissolution.
- CI Runtime filters resolve to the final `@agework/runtime` package name after removing Worker duplicates.

### Final build orchestration

- Turbo `build` remains portable/cacheable and dependency-aware.
- Turbo `package` depends on its own `build` plus dependency `package` tasks, is non-cacheable, and owns platform/deployment side effects.
- Preserve the existing user expectation that root `pnpm build` is deploy-ready by invoking both `turbo run build package`, not by requiring a second manual root command.
- Runtime/Server-only root scripts similarly invoke both tasks. Worker image creation invokes only Runtime portable build because Docker performs its own Linux SDK install.
- `dev` must depend on dependency `package` tasks so Server development has Runtime's local platform SDK installation; test preparation remains conservative until targeted direct-test workflows are redesigned.
- Server moves Runtime Host to production dependencies, guaranteeing the `server#package -> runtime-host#package` graph edge.
- After edits, Turbo dry-run acceptance is: one Runtime build, Runtime package before Server package, no cycle, no hidden dependency build commands.

### SDK install contract

- Keep the existing exact two-SDK manifest, add a committed npm lock dedicated to Runtime SDK installation, and use `npm ci` both locally and in Docker.
- Local installation stamp hashes manifest + lock + platform + arch + Linux libc + Node ABI + npm version. Skip only when the stamp and installed package manifests match.
- Platform `dist/node_modules`, stamp, and Server embedded Runtime output are not portable Turbo outputs.
- Cross-platform optional-dependency lock behavior remains an artifact/CI concern, not a blocker for organizing portable build tasks.

### Implementation gate

- Worker move: no blocker.
- Build/task separation: no blocker; verify post-edit graph with dry-run.
- tsdown: raise repository Node build floor to `>=22.18.0`, then proceed with CJS output. Artifact-level named exports and ACP dynamic import remain explicitly deferred because the user prohibited automatic builds.
- Allowed validation: relevant `tsc --noEmit`, Turbo dry-run, manifest/path consistency searches, and `git diff --check`.
