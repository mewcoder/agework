# Worker Docker Bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `apps/worker`'s Docker image as an esbuild-bundled, dependency-light artifact (no TS source, no `tsx`, no monorepo-wide `pnpm install`), fixing the current `better-sqlite3` build failure and shrinking the image.

**Architecture:** Add an `esbuild`-based `build` script to `apps/worker` that bundles `src/main.ts` plus `@agework/shared`/`@agework/adapters` source and all pure-JS deps into a single ESM file `dist/main.js`, leaving `@anthropic-ai/claude-agent-sdk` and `@openai/codex-sdk` external. Add a static `apps/worker/package.docker.json` listing just those two externals. Rewrite `apps/worker/Dockerfile` as a two-stage build: a `builder` stage that installs the full monorepo and runs the bundle build, and a final `node:22-slim` stage that installs only the two externals via `package.docker.json` and copies in `dist/main.js`.

**Tech Stack:** esbuild 0.28, pnpm workspaces, Docker multi-stage build, Node 22 ESM.

---

## Reference: design doc

Full rationale and constraints are in
`docs/superpowers/specs/2026-06-14-worker-docker-bundle-design.md`. Key points repeated here
so the plan is self-contained:

- `@anthropic-ai/claude-agent-sdk` (ESM-only, ships its own resources) and `@openai/codex-sdk`
  (ships its own `node_modules` with binaries, loaded via `await import("@openai/codex-sdk")`
  in `packages/adapters/src/codex/base/adapter.ts:615`) must stay as real `node_modules`
  packages — mark them `external` in esbuild and install them separately in the final image.
- Everything else reachable from `apps/worker/src/main.ts` (its own code,
  `@agework/shared`, `@agework/adapters`, `rxjs`, `zod`, `@ag-ui/*`, `@nestjs/common`'s
  `Logger`) is plain JS/TS with no native bindings and can be bundled.
- Output format must be ESM (`--format=esm`) because both externals are ESM-only.
- `apps/worker/package.json`'s existing `dependencies` (including `tsx`,
  `@agework/adapters`, `@agework/shared`, `rxjs`) must NOT be removed — `local-runtime-provider.ts`
  (`apps/api/src/runtime/providers/local-runtime-provider.ts:27-34`) runs `apps/worker/src/main.ts`
  directly via `tsx` for `RUNTIME_PROVIDER=local`, independent of the Docker image.
- `apps/worker/dist/` is already covered by the root `.gitignore` (`dist` on line 11).

---

### Task 1: Add esbuild bundle script to `apps/worker`

**Files:**
- Modify: `apps/worker/package.json`

- [ ] **Step 1: Add `esbuild` devDependency and `build` script**

Edit `apps/worker/package.json`. Current content:

```json
{
  "name": "@agework/worker",
  "version": "0.0.1",
  "private": true,
  "main": "./src/main.ts",
  "exports": {
    ".": "./src/main.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@agework/adapters": "workspace:*",
    "@agework/shared": "workspace:*",
    "rxjs": "7.8.1",
    "tsx": "^4.19.0"
  },
  "devDependencies": {
    "@swc/core": "^1.15.40",
    "@types/node": "^24.0.0",
    "typescript": "^5.7.3",
    "unplugin-swc": "^1.5.9",
    "vitest": "^4.1.8"
  }
}
```

Change `scripts` and `devDependencies` to:

```json
  "scripts": {
    "build": "esbuild src/main.ts --bundle --platform=node --target=node22 --format=esm --outfile=dist/main.js --external:@anthropic-ai/claude-agent-sdk --external:@openai/codex-sdk",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "@swc/core": "^1.15.40",
    "@types/node": "^24.0.0",
    "esbuild": "^0.28.0",
    "typescript": "^5.7.3",
    "unplugin-swc": "^1.5.9",
    "vitest": "^4.1.8"
  }
```

Do not change `dependencies`, `main`, or `exports` — they're required by the `local`
runtime provider (see Reference section above).

- [ ] **Step 2: Install dependencies**

Run from repo root:

```bash
pnpm install
```

Expected: completes successfully, `pnpm-lock.yaml` gains an `esbuild` entry under
`apps/worker`'s `devDependencies` (esbuild 0.28.0 is already in the lockfile as a transitive
dependency, so this should resolve without network surprises).

- [ ] **Step 3: Run the build and verify output**

```bash
pnpm --filter @agework/worker build
```

Expected: succeeds, creates `apps/worker/dist/main.js`.

- [ ] **Step 4: Verify the two SDKs were left external**

```bash
grep -c "@anthropic-ai/claude-agent-sdk\|@openai/codex-sdk" apps/worker/dist/main.js
```

Expected: a non-zero count, and the matches should be `import ... from "@anthropic-ai/claude-agent-sdk"`
/ `import("@openai/codex-sdk")`-style references (not inlined package source). Spot check with:

```bash
grep -n "@anthropic-ai/claude-agent-sdk\|@openai/codex-sdk" apps/worker/dist/main.js
```

- [ ] **Step 5: Commit**

```bash
git add apps/worker/package.json pnpm-lock.yaml
git commit -m "feat(worker): add esbuild bundle script"
```

(`apps/worker/dist/` is gitignored and won't be staged.)

---

### Task 2: Add `apps/worker/package.docker.json`

**Files:**
- Create: `apps/worker/package.docker.json`

- [ ] **Step 1: Create the file**

```json
{
  "name": "agework-worker-runtime",
  "private": true,
  "type": "module",
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.3.158",
    "@openai/codex-sdk": "^0.135.0"
  }
}
```

These versions match `packages/adapters/package.json`'s `@anthropic-ai/claude-agent-sdk` and
`@openai/codex-sdk` entries. If those versions are bumped in the future, update this file too
(no automated sync — documented tradeoff in the design doc).

- [ ] **Step 2: Sanity-check it's valid JSON and pnpm can install from it**

```bash
cd /tmp && rm -rf worker-docker-pkg-test && mkdir worker-docker-pkg-test && cd worker-docker-pkg-test
cp /Users/mew/code/agework-dev/apps/worker/package.docker.json ./package.json
pnpm install --prod
ls node_modules/@anthropic-ai node_modules/@openai
cd /Users/mew/code/agework-dev && rm -rf /tmp/worker-docker-pkg-test
```

Expected: `pnpm install --prod` succeeds, and both `node_modules/@anthropic-ai/claude-agent-sdk`
and `node_modules/@openai/codex-sdk` directories exist.

- [ ] **Step 3: Commit**

```bash
git add apps/worker/package.docker.json
git commit -m "feat(worker): add minimal runtime package manifest for Docker image"
```

---

### Task 3: Rewrite `apps/worker/Dockerfile`

**Files:**
- Modify: `apps/worker/Dockerfile`

- [ ] **Step 1: Replace the Dockerfile contents**

Current content (for reference):

```dockerfile
# Build context must be the monorepo root:
#   docker build -t agework/worker:latest -f apps/worker/Dockerfile .
# (worker depends on workspace packages @agework/shared and @agework/adapters,
# so it can't be built from apps/worker alone.)

FROM node:22-slim AS deploy

WORKDIR /repo
RUN corepack enable pnpm

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @agework/worker deploy --prod --legacy /out

FROM node:22-slim

WORKDIR /app
RUN corepack enable pnpm

COPY --from=deploy /out .

# Claude CLI 拒绝在 root/sudo 下使用 bypassPermissions，
# 所以创建非 root 用户运行 worker。
RUN groupadd -r agent && useradd -r -g agent -d /home/agent -s /sbin/nologin agent \
    && mkdir -p /home/agent /app \
    && chown agent:agent /home/agent /app

USER agent
ENV HOME=/home/agent

# Run worker via tsx
CMD ["npx", "tsx", "src/main.ts"]
```

Replace the entire file with:

```dockerfile
# Build context must be the monorepo root:
#   docker build -t agework/worker:latest -f apps/worker/Dockerfile .
# (worker bundles workspace packages @agework/shared and @agework/adapters into
# dist/main.js, so the builder stage needs the full monorepo to run the build.)

FROM node:22-slim AS builder

WORKDIR /repo
RUN corepack enable pnpm

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @agework/worker build

FROM node:22-slim

WORKDIR /app
RUN corepack enable pnpm

COPY apps/worker/package.docker.json ./package.json
RUN pnpm install --prod
COPY --from=builder /repo/apps/worker/dist/main.js ./dist/main.js

# Claude CLI 拒绝在 root/sudo 下使用 bypassPermissions，
# 所以创建非 root 用户运行 worker。
RUN groupadd -r agent && useradd -r -g agent -d /home/agent -s /sbin/nologin agent \
    && mkdir -p /home/agent \
    && chown agent:agent /home/agent /app

USER agent
ENV HOME=/home/agent

CMD ["node", "dist/main.js"]
```

- [ ] **Step 2: Build the image**

```bash
docker build -t agework/worker:latest -f apps/worker/Dockerfile .
```

Expected: build completes successfully (no `better-sqlite3`/node-gyp errors).

- [ ] **Step 3: Compare image size to baseline**

```bash
docker images agework/worker:latest --format "{{.Repository}}:{{.Tag}} {{.Size}}"
```

Expected: noticeably smaller than the pre-change baseline of ~750MB.

- [ ] **Step 4: Smoke-test the bundle resolves its imports**

```bash
docker run --rm --entrypoint node agework/worker:latest --input-type=module -e "
import('./dist/main.js')
  .then(() => console.log('IMPORT_OK'))
  .catch((err) => { console.error('IMPORT_FAILED', err); process.exit(1); })
"
```

`main.ts` starts long-running worker logic (it will block waiting for transport setup), so this
command may hang rather than print `IMPORT_OK` immediately — that's fine as long as it does
**not** print `IMPORT_FAILED` with a `Cannot find module` / `ERR_MODULE_NOT_FOUND` error. Run
with a timeout and inspect output:

```bash
timeout 10 docker run --rm --entrypoint node agework/worker:latest --input-type=module -e "
import('./dist/main.js')
  .then(() => console.log('IMPORT_OK'))
  .catch((err) => { console.error('IMPORT_FAILED', err); process.exit(1); })
" || true
```

Expected: no `IMPORT_FAILED` / module-resolution error in the output. (macOS has no `timeout`
built in — if unavailable, run the `docker run` in the background and `docker kill` it after a
few seconds instead.)

- [ ] **Step 5: Commit**

```bash
git add apps/worker/Dockerfile
git commit -m "refactor(worker): rebuild Docker image from esbuild bundle"
```

---

### Task 4: End-to-end verification with opensandbox

**Files:** none (verification only)

- [ ] **Step 1: Rebuild via the opensandbox script**

```bash
pnpm opensandbox:rebuild
```

Expected: rebuilds `agework/worker:latest` from the new Dockerfile (same as Task 3 Step 2) and
restarts `opensandbox-server`. Should complete without errors.

- [ ] **Step 2: Bring the environment up**

```bash
pnpm opensandbox:up
```

Expected: completes successfully; `pnpm opensandbox:health` reports healthy
(`{"status":"ok"}` or equivalent from `GET /health`).

- [ ] **Step 3: Confirm no stale-image warning**

`pnpm opensandbox:up`'s output should NOT print the
`⚠️ apps/worker 源码比 agework/worker:latest 镜像新...` warning (since the image was just
rebuilt from current source in Task 4 Step 1).

- [ ] **Step 4: Manual real-agent smoke test (done by the user, not automated)**

Start the app (`pnpm dev` or `pnpm app:deploy` with `RUNTIME_PROVIDER=opensandbox`), create a
sandbox-backed agent run using a Claude adapter and one using a Codex adapter, and confirm both
complete without `Cannot find module` / `ERR_MODULE_NOT_FOUND` errors in the worker container
logs (`pnpm opensandbox:logs` or `docker logs <sandbox-container>`). This step requires real
API credentials, so it's called out for the user to run manually rather than scripted.
