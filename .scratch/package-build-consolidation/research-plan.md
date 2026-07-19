# Research Plan: Package and Build Consolidation

> Core question: How should AgeWork reduce package and build complexity without weakening Runtime/Agent plugin boundaries or changing runtime behavior?
> min_rounds: 4

## Dimensions

1. Package responsibility and dependency graph — distinguish real deploy/publish boundaries from folders that only became packages for convenience.
2. Plugin and SDK boundaries — preserve independent Runtime/Agent plugin development, dynamic loading, and bundled-plugin examples.
3. Build and type pipeline — separate type checking from emission, assess tsdown compatibility, and remove redundant nested builds.
4. Runtime packaging and deployment — verify Native, Docker, embedded Runtime Host, dynamic imports, exports, and external dependencies.
5. Developer experience and migration risk — reduce names and commands a contributor must understand while keeping changes reversible.

## Completion criteria

- [ ] Each dimension is covered by at least two independent investigations.
- [ ] Every current workspace package has an evidence-backed keep, merge, move, rename, or defer decision.
- [ ] The target dependency graph remains acyclic and preserves external plugin SDK contracts.
- [ ] Build changes distinguish `tsc --noEmit`, library emission, and application bundling.
- [ ] Important exports and runtime resolution claims are verified from code/configuration.
- [ ] Relevant typechecks pass after implementation; no automatic build, lint, or browser test is run.
- [ ] Guides and package documentation match the resulting layout.
- [ ] A fresh verifier returns PASS after at least four exploration rounds.

## Scope

- In: `packages/*`, `apps/runtime`, package manifests, `pnpm-workspace.yaml`, `turbo.json`, build scripts, plugin guides, Runtime/Agent loading boundaries.
- Out: product feature behavior, UI redesign, database schema, protocol behavior changes, release automation unrelated to package/build organization.
