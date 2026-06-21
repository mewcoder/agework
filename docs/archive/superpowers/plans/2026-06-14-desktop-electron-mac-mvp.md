# Desktop Electron (macOS arm64 MVP, local mode) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a self-contained macOS (Apple Silicon) Electron desktop app (`apps/desktop`) that forks the existing NestJS backend (local runtime provider, serve-static frontend), stores data under `userData`, and bundles the claude/codex Agent CLIs so a user can install a `.dmg` and have a working end-to-end AgeWork experience with zero external dependencies.

**Architecture:** Electron main process picks a free local port, prepares `userData` (copies a pre-built empty SQLite db on first run), forks the compiled `apps/api/dist/src/main.js` with `RUNTIME_PROVIDER=local` + `SERVE_FRONTEND=true` + bundled Agent CLI paths, waits for the backend health check, then opens a `BrowserWindow` pointed at `http://127.0.0.1:<port>`. A separate `prepare-resources.mjs` script stages everything electron-builder needs (api/worker deploy bundles, web dist, template db, bundled claude/codex binaries) before packaging.

**Tech Stack:** Electron, electron-builder, `@electron/rebuild`, `get-port-please`, existing NestJS `apps/api`, `apps/worker` (tsx), Vitest.

**Out of scope (follow-up plan):** Docker isolation mode toggle, Windows packaging, auto-update, notarization/signing, Intel mac.

Reference design: `docs/superpowers/specs/2026-06-14-desktop-electron-mac-mvp-design.md`

---

## File Structure

- `apps/worker/src/agent-cli-paths.ts` (new) — pure function resolving bundled claude/codex CLI paths from env vars
- `apps/worker/src/agent-cli-paths.spec.ts` (new)
- `apps/worker/src/main.ts` (modify) — wire `agent-cli-paths` into `createAdapter`
- `apps/desktop/package.json` (new)
- `apps/desktop/tsconfig.json` (new)
- `apps/desktop/vitest.config.ts` (new)
- `apps/desktop/src/user-data-paths.ts` (new) + `.spec.ts`
- `apps/desktop/src/resource-paths.ts` (new) + `.spec.ts`
- `apps/desktop/src/port.ts` (new)
- `apps/desktop/src/first-run-init.ts` (new) + `.spec.ts`
- `apps/desktop/src/backend-process.ts` (new)
- `apps/desktop/src/main.ts` (new) — Electron entry point
- `apps/desktop/scripts/prepare-resources.mjs` (new) — staging script for electron-builder
- `apps/desktop/electron-builder.yml` (new)
- `package.json` (modify) — add `desktop:*` scripts

---

### Task 1: Worker — resolve bundled Agent CLI paths from env

**Files:**
- Create: `apps/worker/src/agent-cli-paths.ts`
- Test: `apps/worker/src/agent-cli-paths.spec.ts`
- Modify: `apps/worker/src/main.ts:309-345`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/worker/src/agent-cli-paths.spec.ts
import { describe, it, expect } from "vitest";
import { resolveAgentCliPaths } from "./agent-cli-paths.js";

describe("resolveAgentCliPaths", () => {
  it("returns undefined paths when env vars are not set", () => {
    expect(resolveAgentCliPaths({})).toEqual({
      claudeExecutablePath: undefined,
      codexExecutablePath: undefined,
    });
  });

  it("returns paths from AGEWORK_CLAUDE_CLI_PATH and AGEWORK_CODEX_CLI_PATH", () => {
    const env = {
      AGEWORK_CLAUDE_CLI_PATH: "/Resources/bin/claude",
      AGEWORK_CODEX_CLI_PATH: "/Resources/bin/codex",
    };
    expect(resolveAgentCliPaths(env)).toEqual({
      claudeExecutablePath: "/Resources/bin/claude",
      codexExecutablePath: "/Resources/bin/codex",
    });
  });

  it("treats empty-string env vars as unset", () => {
    expect(
      resolveAgentCliPaths({ AGEWORK_CLAUDE_CLI_PATH: "", AGEWORK_CODEX_CLI_PATH: "  " })
    ).toEqual({
      claudeExecutablePath: undefined,
      codexExecutablePath: undefined,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agework/worker test -- agent-cli-paths`
Expected: FAIL with "Cannot find module './agent-cli-paths.js'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/worker/src/agent-cli-paths.ts

/** Paths to bundled Agent CLI executables, set by the desktop app's main process. */
export type AgentCliPaths = {
  claudeExecutablePath?: string;
  codexExecutablePath?: string;
};

/**
 * Reads AGEWORK_CLAUDE_CLI_PATH / AGEWORK_CODEX_CLI_PATH from the environment.
 * Used by the desktop app to point the SDKs at bundled CLI binaries instead
 * of the platform packages resolved from node_modules.
 */
export function resolveAgentCliPaths(
  env: Record<string, string | undefined>
): AgentCliPaths {
  const claudeExecutablePath = env.AGEWORK_CLAUDE_CLI_PATH?.trim() || undefined;
  const codexExecutablePath = env.AGEWORK_CODEX_CLI_PATH?.trim() || undefined;
  return { claudeExecutablePath, codexExecutablePath };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agework/worker test -- agent-cli-paths`
Expected: PASS (3 tests)

- [ ] **Step 5: Wire into `createAdapter`**

Read `apps/worker/src/main.ts` around lines 309-345 first. Add the import near the top with the other relative imports:

```typescript
import { resolveAgentCliPaths } from "./agent-cli-paths.js";
```

Then update `createAdapter` (existing function, ~line 308-345):

```typescript
function createAdapter(
  config: RunConfig,
  trace: AgentTraceSink | undefined,
  emitRunStatusForAguiThread: (aguiThreadId: string, payload: RunStatusPayload) => void
) {
  const { adapter: adapterConfig, runtimePath } = config;
  const { claudeExecutablePath, codexExecutablePath } = resolveAgentCliPaths(process.env);

  const pendingActionSink = (event: {
    threadId: string;
    pendingAction: "question" | null;
  }) => {
    const payload: RunStatusPayload = event.pendingAction
      ? { status: "requires_action", pendingAction: event.pendingAction }
      : { status: "running", pendingAction: null };
    // AG-UI 边界：event.threadId 值即 AgeWork conversationId。
    emitRunStatusForAguiThread(event.threadId, payload);
  };

  if (adapterConfig.kind === "claude") {
    return new ClaudeAgentAdapter({
      apiKey: adapterConfig.apiKey,
      model: adapterConfig.model,
      baseUrl: adapterConfig.baseUrl,
      cwd: runtimePath,
      isEnvironmentConfig: adapterConfig.isEnvironmentConfig,
      pendingActionSink,
      trace,
      ...(claudeExecutablePath ? { pathToClaudeCodeExecutable: claudeExecutablePath } : {}),
    });
  }

  return new CodexAgentAdapter({
    apiKey: adapterConfig.apiKey,
    model: adapterConfig.model,
    baseUrl: adapterConfig.baseUrl,
    cwd: runtimePath,
    trace,
    ...(codexExecutablePath ? { codexPathOverride: codexExecutablePath } : {}),
  });
}
```

- [ ] **Step 6: Run worker test suite and typecheck**

Run: `pnpm --filter @agework/worker test && pnpm --filter @agework/worker typecheck`
Expected: All PASS, no type errors

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/agent-cli-paths.ts apps/worker/src/agent-cli-paths.spec.ts apps/worker/src/main.ts
git commit -m "feat(worker): resolve bundled Agent CLI paths from env for desktop"
```

---

### Task 2: Scaffold `apps/desktop` Electron package

**Files:**
- Create: `apps/desktop/package.json`
- Create: `apps/desktop/tsconfig.json`
- Create: `apps/desktop/vitest.config.ts`
- Create: `apps/desktop/src/main.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@agework/desktop",
  "private": true,
  "version": "0.0.1",
  "main": "dist/main.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "electron .",
    "dev": "pnpm build && electron .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "prepare:resources": "node scripts/prepare-resources.mjs",
    "dist:mac": "pnpm build && pnpm prepare:resources && electron-builder --mac --arm64"
  },
  "dependencies": {
    "get-port-please": "3.2.0"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "@electron/rebuild": "^3.7.1",
    "electron": "^33.2.0",
    "electron-builder": "^25.1.8",
    "typescript": "^5.7.3",
    "vitest": "^4.1.8"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "moduleResolution": "node",
    "esModuleInterop": true,
    "target": "ES2022",
    "lib": ["ES2022"],
    "types": ["node"],
    "sourceMap": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "skipLibCheck": true,
    "strict": true,
    "strictNullChecks": true,
    "forceConsistentCasingInFileNames": true,
    "noImplicitAny": true,
    "noEmit": false
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.spec.ts"],
  },
});
```

- [ ] **Step 4: Create placeholder `src/main.ts`**

```typescript
// apps/desktop/src/main.ts
import { app, BrowserWindow } from "electron";

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1280, height: 800 });
  void win.loadURL("data:text/html,<h1>AgeWork Desktop</h1>");
});

app.on("window-all-closed", () => {
  app.quit();
});
```

- [ ] **Step 5: Install dependencies**

Run: `pnpm install`
Expected: pnpm resolves and installs `electron`, `electron-builder`, `@electron/rebuild`, `get-port-please`, `vitest`, `typescript`, `@types/node` for `apps/desktop`

- [ ] **Step 6: Build and launch placeholder app**

Run: `pnpm --filter @agework/desktop build && pnpm --filter @agework/desktop start`
Expected: An Electron window opens showing "AgeWork Desktop". Close the window to quit.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/package.json apps/desktop/tsconfig.json apps/desktop/vitest.config.ts apps/desktop/src/main.ts pnpm-lock.yaml
git commit -m "feat(desktop): scaffold Electron app skeleton"
```

---

### Task 3: `user-data-paths` module

**Files:**
- Create: `apps/desktop/src/user-data-paths.ts`
- Test: `apps/desktop/src/user-data-paths.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/desktop/src/user-data-paths.spec.ts
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { getUserDataPaths } from "./user-data-paths";

describe("getUserDataPaths", () => {
  it("derives all paths from the given userData root", () => {
    const root = "/Users/test/Library/Application Support/AgeWork";
    const paths = getUserDataPaths(root);

    expect(paths.root).toBe(root);
    expect(paths.dbPath).toBe(join(root, "agework.db"));
    expect(paths.databaseUrl).toBe(`file:${join(root, "agework.db")}`);
    expect(paths.workspaceDir).toBe(join(root, "workspaces"));
    expect(paths.logsDir).toBe(join(root, "logs"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agework/desktop test -- user-data-paths`
Expected: FAIL with "Cannot find module './user-data-paths'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/desktop/src/user-data-paths.ts
import { join } from "node:path";

export type UserDataPaths = {
  root: string;
  dbPath: string;
  databaseUrl: string;
  workspaceDir: string;
  logsDir: string;
};

/** Derives all on-disk locations the desktop app needs from Electron's userData dir. */
export function getUserDataPaths(userDataRoot: string): UserDataPaths {
  const dbPath = join(userDataRoot, "agework.db");
  return {
    root: userDataRoot,
    dbPath,
    databaseUrl: `file:${dbPath}`,
    workspaceDir: join(userDataRoot, "workspaces"),
    logsDir: join(userDataRoot, "logs"),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agework/desktop test -- user-data-paths`
Expected: PASS (1 test)

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/user-data-paths.ts apps/desktop/src/user-data-paths.spec.ts
git commit -m "feat(desktop): add user-data-paths module"
```

---

### Task 4: `resource-paths` module (dev vs packaged)

**Files:**
- Create: `apps/desktop/src/resource-paths.ts`
- Test: `apps/desktop/src/resource-paths.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/desktop/src/resource-paths.spec.ts
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { getResourcePaths } from "./resource-paths";

describe("getResourcePaths", () => {
  it("resolves paths against the repo when not packaged", () => {
    const repoRoot = "/repo";
    const paths = getResourcePaths({
      isPackaged: false,
      resourcesPath: "/unused",
      repoRoot,
    });

    expect(paths.apiCwd).toBe(join(repoRoot, "apps", "api"));
    expect(paths.apiMainPath).toBe(join(repoRoot, "apps", "api", "dist", "src", "main.js"));
    expect(paths.templateDbPath).toBe(join(repoRoot, "apps", "api", "prisma", "dev.db"));
    expect(paths.claudeCliPath).toBeUndefined();
    expect(paths.codexCliPath).toBeUndefined();
  });

  it("resolves paths under resourcesPath/app when packaged", () => {
    const resourcesPath = "/Applications/AgeWork.app/Contents/Resources";
    const paths = getResourcePaths({
      isPackaged: true,
      resourcesPath,
      repoRoot: "/unused",
    });

    expect(paths.apiCwd).toBe(join(resourcesPath, "app", "api"));
    expect(paths.apiMainPath).toBe(
      join(resourcesPath, "app", "api", "dist", "src", "main.js")
    );
    expect(paths.templateDbPath).toBe(join(resourcesPath, "template.db"));
    expect(paths.claudeCliPath).toBe(join(resourcesPath, "bin", "claude"));
    expect(paths.codexCliPath).toBe(join(resourcesPath, "bin", "codex"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agework/desktop test -- resource-paths`
Expected: FAIL with "Cannot find module './resource-paths'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/desktop/src/resource-paths.ts
import { join } from "node:path";

export type ResourcePaths = {
  /** cwd to fork the NestJS backend from (so `../web/dist` resolves correctly). */
  apiCwd: string;
  /** Absolute path to the compiled NestJS entry point. */
  apiMainPath: string;
  /** Pre-built empty SQLite db copied into userData on first run. */
  templateDbPath: string;
  /** Bundled claude CLI binary (packaged builds only). */
  claudeCliPath?: string;
  /** Bundled codex CLI binary (packaged builds only). */
  codexCliPath?: string;
};

export type ResourcePathsOptions = {
  isPackaged: boolean;
  resourcesPath: string;
  repoRoot: string;
};

/**
 * Resolves filesystem locations for the bundled backend, frontend, template
 * database and Agent CLI binaries.
 *
 * In dev mode everything is read from the monorepo build output. In packaged
 * builds everything lives under `process.resourcesPath`, staged by
 * `scripts/prepare-resources.mjs`.
 */
export function getResourcePaths(options: ResourcePathsOptions): ResourcePaths {
  const { isPackaged, resourcesPath, repoRoot } = options;

  if (isPackaged) {
    const appDir = join(resourcesPath, "app");
    return {
      apiCwd: join(appDir, "api"),
      apiMainPath: join(appDir, "api", "dist", "src", "main.js"),
      templateDbPath: join(resourcesPath, "template.db"),
      claudeCliPath: join(resourcesPath, "bin", "claude"),
      codexCliPath: join(resourcesPath, "bin", "codex"),
    };
  }

  return {
    apiCwd: join(repoRoot, "apps", "api"),
    apiMainPath: join(repoRoot, "apps", "api", "dist", "src", "main.js"),
    templateDbPath: join(repoRoot, "apps", "api", "prisma", "dev.db"),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agework/desktop test -- resource-paths`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/resource-paths.ts apps/desktop/src/resource-paths.spec.ts
git commit -m "feat(desktop): add resource-paths module for dev/packaged resolution"
```

---

### Task 5: `port` module

**Files:**
- Create: `apps/desktop/src/port.ts`

- [ ] **Step 1: Write the implementation**

`get-port-please` is an established library; this is a thin, one-line wrapper not worth a unit test (no branching logic). It will be exercised by the manual end-to-end verification in Task 11.

```typescript
// apps/desktop/src/port.ts
import { getRandomPort } from "get-port-please";

/** Picks a free local TCP port for the backend to bind to. */
export async function pickAvailablePort(): Promise<number> {
  return getRandomPort("127.0.0.1");
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @agework/desktop typecheck`
Expected: No type errors (confirms `get-port-please` exports `getRandomPort`)

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/port.ts
git commit -m "feat(desktop): add port allocation helper"
```

---

### Task 6: `first-run-init` module

**Files:**
- Create: `apps/desktop/src/first-run-init.ts`
- Test: `apps/desktop/src/first-run-init.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/desktop/src/first-run-init.spec.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getUserDataPaths } from "./user-data-paths";
import { ensureUserData } from "./first-run-init";

describe("ensureUserData", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function setup() {
    const userDataRoot = mkdtempSync(join(tmpdir(), "agework-desktop-userdata-"));
    const templateDb = mkdtempSync(join(tmpdir(), "agework-desktop-template-"));
    dirs.push(userDataRoot, templateDb);
    const templateDbPath = join(templateDb, "template.db");
    writeFileSync(templateDbPath, "TEMPLATE-DB-CONTENT");
    return { userDataRoot, templateDbPath };
  }

  it("creates workspace/log dirs and copies the template db on first run", () => {
    const { userDataRoot, templateDbPath } = setup();
    const userData = getUserDataPaths(userDataRoot);

    ensureUserData(userData, { templateDbPath } as any);

    expect(existsSync(userData.workspaceDir)).toBe(true);
    expect(existsSync(userData.logsDir)).toBe(true);
    expect(readFileSync(userData.dbPath, "utf8")).toBe("TEMPLATE-DB-CONTENT");
  });

  it("does not overwrite an existing database on subsequent runs", () => {
    const { userDataRoot, templateDbPath } = setup();
    const userData = getUserDataPaths(userDataRoot);

    ensureUserData(userData, { templateDbPath } as any);
    writeFileSync(userData.dbPath, "USER-DATA");
    ensureUserData(userData, { templateDbPath } as any);

    expect(readFileSync(userData.dbPath, "utf8")).toBe("USER-DATA");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agework/desktop test -- first-run-init`
Expected: FAIL with "Cannot find module './first-run-init'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/desktop/src/first-run-init.ts
import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import type { UserDataPaths } from "./user-data-paths";
import type { ResourcePaths } from "./resource-paths";

/**
 * Ensures the userData directory is ready to use: creates the workspace and
 * logs directories, and copies the bundled empty-schema template database on
 * first run. Never overwrites an existing database.
 */
export function ensureUserData(
  userData: UserDataPaths,
  resources: Pick<ResourcePaths, "templateDbPath">
): void {
  mkdirSync(userData.root, { recursive: true });
  mkdirSync(userData.workspaceDir, { recursive: true });
  mkdirSync(userData.logsDir, { recursive: true });

  if (!existsSync(userData.dbPath)) {
    copyFileSync(resources.templateDbPath, userData.dbPath);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agework/desktop test -- first-run-init`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/first-run-init.ts apps/desktop/src/first-run-init.spec.ts
git commit -m "feat(desktop): add first-run userData initialization"
```

---

### Task 7: `backend-process` module

**Files:**
- Create: `apps/desktop/src/backend-process.ts`

This module forks a real child process and polls HTTP — it is exercised end-to-end in Task 11 rather than unit tested.

- [ ] **Step 1: Write the implementation**

```typescript
// apps/desktop/src/backend-process.ts
import { fork, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import type { ResourcePaths } from "./resource-paths";
import type { UserDataPaths } from "./user-data-paths";

export type BackendHandle = {
  process: ChildProcess;
  port: number;
  stop: () => void;
};

/** Forks the compiled NestJS backend with desktop-specific environment variables. */
export function startBackend(
  resources: ResourcePaths,
  userData: UserDataPaths,
  port: number
): BackendHandle {
  const logStream = createWriteStream(join(userData.logsDir, "api.log"), { flags: "a" });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DATABASE_URL: userData.databaseUrl,
    AGENT_WORKSPACE: userData.workspaceDir,
    DEV_AUTH_DISABLED: "true",
    SERVE_FRONTEND: "true",
    RUNTIME_PROVIDER: "local",
  };
  if (resources.claudeCliPath) env.AGEWORK_CLAUDE_CLI_PATH = resources.claudeCliPath;
  if (resources.codexCliPath) env.AGEWORK_CODEX_CLI_PATH = resources.codexCliPath;

  const child = fork(resources.apiMainPath, [], {
    cwd: resources.apiCwd,
    env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });

  child.stdout?.pipe(logStream);
  child.stderr?.pipe(logStream);

  return {
    process: child,
    port,
    stop: () => {
      child.kill();
    },
  };
}

/** Polls the public `/api/v1/system/about` endpoint until the backend responds. */
export async function waitForBackendReady(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/system/about`);
      if (res.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  throw new Error(
    `Backend did not become ready on port ${port} within ${timeoutMs}ms: ${String(lastError)}`
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @agework/desktop typecheck`
Expected: No type errors

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/backend-process.ts
git commit -m "feat(desktop): add backend process manager"
```

---

### Task 8: Wire up `main.ts` orchestration

**Files:**
- Modify: `apps/desktop/src/main.ts`

- [ ] **Step 1: Replace the placeholder main.ts**

```typescript
// apps/desktop/src/main.ts
import { app, BrowserWindow } from "electron";
import { join } from "node:path";
import { getUserDataPaths } from "./user-data-paths";
import { getResourcePaths } from "./resource-paths";
import { ensureUserData } from "./first-run-init";
import { pickAvailablePort } from "./port";
import { startBackend, waitForBackendReady, type BackendHandle } from "./backend-process";

let backend: BackendHandle | undefined;

async function createMainWindow(port: number): Promise<void> {
  const win = new BrowserWindow({ width: 1280, height: 800 });
  await win.loadURL(`http://127.0.0.1:${port}`);
}

function showStartupError(message: string): void {
  const win = new BrowserWindow({ width: 600, height: 300 });
  void win.loadURL(
    `data:text/html,<h1>AgeWork failed to start</h1><pre>${encodeURIComponent(message)}</pre>`
  );
}

app.whenReady().then(async () => {
  // dist/main.js -> apps/desktop -> apps -> repo root
  const repoRoot = join(__dirname, "..", "..", "..");

  const userData = getUserDataPaths(app.getPath("userData"));
  const resources = getResourcePaths({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    repoRoot,
  });

  ensureUserData(userData, resources);

  const port = await pickAvailablePort();
  backend = startBackend(resources, userData, port);

  try {
    await waitForBackendReady(port);
  } catch (error) {
    showStartupError(error instanceof Error ? error.message : String(error));
    return;
  }

  await createMainWindow(port);
});

app.on("window-all-closed", () => {
  backend?.stop();
  app.quit();
});

app.on("before-quit", () => {
  backend?.stop();
});
```

- [ ] **Step 2: Build**

Run: `pnpm --filter @agework/desktop build`
Expected: Compiles with no errors

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/main.ts
git commit -m "feat(desktop): wire up Electron main process orchestration"
```

(End-to-end manual verification of this happens in Task 11, after `apps/api`/`apps/web` are built and the template db exists — see Task 9.)

---

### Task 9: `prepare-resources.mjs` staging script

**Files:**
- Create: `apps/desktop/scripts/prepare-resources.mjs`

This script stages everything `electron-builder` needs to package into `Resources/`:
- `apps/api` deployed in production mode (includes `@agework/worker` and `@agework/adapters` as real `node_modules` folders, mirroring `apps/worker/Dockerfile`'s `pnpm deploy` approach)
- `apps/web/dist` copied to `app/web/dist` (so `apps/api`'s `process.cwd()/../web/dist` resolves)
- a `template.db` built by running `prisma db push` against an empty temp database (no seed data; the admin user is created by the first-run Web setup flow when auth is enabled)
- the bundled darwin-arm64 `claude` and `codex` CLI binaries, located by walking `node_modules/.pnpm` for the platform packages

- [ ] **Step 1: Write the script**

```javascript
#!/usr/bin/env node
// apps/desktop/scripts/prepare-resources.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, cpSync, rmSync, readdirSync, chmodSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const desktopDir = join(repoRoot, "apps/desktop");
const resourcesDir = join(desktopDir, "resources");
const appDir = join(resourcesDir, "app");

function findPnpmDir(prefix) {
  const pnpmRoot = join(repoRoot, "node_modules", ".pnpm");
  const match = readdirSync(pnpmRoot).find((name) => name.startsWith(prefix));
  if (!match) {
    throw new Error(`Could not find a node_modules/.pnpm entry starting with "${prefix}"`);
  }
  return join(pnpmRoot, match);
}

console.log("Resetting resources directory...");
rmSync(resourcesDir, { recursive: true, force: true });
mkdirSync(appDir, { recursive: true });

console.log("Deploying apps/api (production deps, includes worker + adapters)...");
execFileSync(
  "pnpm",
  ["--filter", "api", "deploy", "--prod", "--legacy", join(appDir, "api")],
  { cwd: repoRoot, stdio: "inherit" }
);

console.log("Copying apps/web/dist...");
cpSync(join(repoRoot, "apps/web/dist"), join(appDir, "web", "dist"), { recursive: true });

console.log("Building template.db (empty schema, no seed data)...");
const templateDb = join(resourcesDir, "template.db");
rmSync(templateDb, { force: true });
execFileSync(
  "pnpm",
  ["--filter", "api", "exec", "prisma", "db", "push", "--skip-generate"],
  {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: `file:${templateDb}` },
    stdio: "inherit",
  }
);
if (!existsSync(templateDb)) {
  throw new Error(`prisma db push did not create ${templateDb}`);
}

console.log("Copying bundled Agent CLI binaries (darwin-arm64)...");
const binDir = join(resourcesDir, "bin");
mkdirSync(binDir, { recursive: true });

const claudeDir = findPnpmDir("@anthropic-ai+claude-agent-sdk-darwin-arm64@");
cpSync(
  join(claudeDir, "node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude"),
  join(binDir, "claude")
);

const codexDir = findPnpmDir("@openai+codex@");
const codexMatch = readdirSync(join(repoRoot, "node_modules/.pnpm")).find(
  (name) => name.startsWith("@openai+codex@") && name.includes("darwin-arm64")
);
if (!codexMatch) {
  throw new Error("Could not find @openai/codex darwin-arm64 package in node_modules/.pnpm");
}
cpSync(
  join(
    repoRoot,
    "node_modules/.pnpm",
    codexMatch,
    "node_modules/@openai/codex/vendor/aarch64-apple-darwin/bin/codex"
  ),
  join(binDir, "codex")
);

chmodSync(join(binDir, "claude"), 0o755);
chmodSync(join(binDir, "codex"), 0o755);

console.log("Done. Resources staged at", resourcesDir);
```

- [ ] **Step 2: Build prerequisites**

Run: `pnpm build` (builds `apps/api`, `apps/web`, and workspace packages)
Expected: All packages build successfully, `apps/api/dist/src/main.js` and `apps/web/dist/index.html` exist

- [ ] **Step 3: Run the staging script**

Run: `node apps/desktop/scripts/prepare-resources.mjs`
Expected: Completes with "Done. Resources staged at .../apps/desktop/resources"

- [ ] **Step 4: Verify staged output**

Run:
```bash
ls apps/desktop/resources
ls apps/desktop/resources/app/api/dist/src/main.js
ls apps/desktop/resources/app/web/dist/index.html
ls -la apps/desktop/resources/bin
file apps/desktop/resources/template.db
```
Expected: `app/`, `bin/`, `template.db` all present; `bin/claude` and `bin/codex` are executable (`-rwxr-xr-x`); `template.db` is a SQLite database file

- [ ] **Step 5: Add resources/ to .gitignore**

Read `apps/desktop/.gitignore` if it exists (it won't yet), then create it:

```
# apps/desktop/.gitignore
dist/
resources/
```

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/scripts/prepare-resources.mjs apps/desktop/.gitignore
git commit -m "feat(desktop): add prepare-resources staging script"
```

---

### Task 10: electron-builder packaging config + better-sqlite3 rebuild

**Files:**
- Create: `apps/desktop/electron-builder.yml`
- Modify: `apps/desktop/package.json`
- Modify: `package.json`

- [ ] **Step 1: Create `electron-builder.yml`**

```yaml
# apps/desktop/electron-builder.yml
appId: com.agework.desktop
productName: AgeWork
directories:
  output: out
  buildResources: build
files:
  - dist/**/*
  - package.json
extraResources:
  - from: resources/app
    to: app
  - from: resources/bin
    to: bin
  - from: resources/template.db
    to: template.db
mac:
  target:
    - target: dmg
      arch:
        - arm64
  category: public.app-category.developer-tools
afterPack: scripts/after-pack.cjs
```

- [ ] **Step 2: Create the `afterPack` hook to rebuild better-sqlite3 for Electron's Node ABI**

```javascript
// apps/desktop/scripts/after-pack.cjs
const path = require("node:path");
const { rebuild } = require("@electron/rebuild");

module.exports = async function afterPack(context) {
  const apiDir = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    "Contents",
    "Resources",
    "app",
    "api"
  );

  await rebuild({
    buildPath: apiDir,
    electronVersion: context.packager.config.electronVersion,
    arch: "arm64",
    onlyModules: ["better-sqlite3"],
  });
};
```

- [ ] **Step 3: Update `apps/desktop/package.json` scripts**

Modify the `scripts` block (existing `dist:mac` already calls `prepare:resources`; add the explicit `build:resources` alias used by docs and ensure `electronVersion` is available to the afterPack hook by adding a `build` config key):

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "electron .",
    "dev": "pnpm build && electron .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "prepare:resources": "node scripts/prepare-resources.mjs",
    "dist:mac": "pnpm build && pnpm prepare:resources && electron-builder --config electron-builder.yml --mac --arm64"
  }
}
```

- [ ] **Step 4: Add root convenience scripts**

Read `package.json` at repo root, then add to the `scripts` block (alphabetically near other `desktop`-ish entries — place after `db:studio`):

```json
    "desktop:dev": "pnpm --filter @agework/desktop dev",
    "desktop:dist:mac": "pnpm --filter @agework/desktop dist:mac",
```

- [ ] **Step 5: Build the `.dmg`**

Run: `pnpm desktop:dist:mac`
Expected: Completes successfully, producing `apps/desktop/out/AgeWork-<version>-arm64.dmg`

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/electron-builder.yml apps/desktop/scripts/after-pack.cjs apps/desktop/package.json package.json
git commit -m "feat(desktop): add electron-builder config and better-sqlite3 rebuild hook"
```

---

### Task 11: End-to-end verification

This task has no code changes — it validates the full flow in both dev and packaged form.

- [ ] **Step 1: Dev-mode end-to-end run**

Prerequisites: `apps/api/prisma/dev.db` must exist (run `pnpm db:push` if not) and `pnpm build` must have produced `apps/api/dist`.

Run: `pnpm desktop:dev`

Expected:
- Electron window opens and loads the AgeWork frontend (not the placeholder page)
- Backend log at `~/Library/Application Support/AgeWork/logs/api.log` shows `Server running on http://localhost:<port>`
- In the UI, start a new conversation with a Claude-backed agent and send a message; confirm a response streams back
- Repeat with a Codex-backed agent; confirm a response streams back
- Quit the app (Cmd+Q); confirm the forked backend process exits (check `ps aux | grep main.js`)

- [ ] **Step 2: Packaged `.dmg` end-to-end run**

Run:
```bash
open apps/desktop/out/AgeWork-*-arm64.dmg
```

Then in Finder: drag `AgeWork.app` to a test location (e.g. `/Applications` or `~/Desktop`), and since the build is unsigned, allow it via:

```bash
xattr -cr /Applications/AgeWork.app
```

Launch `AgeWork.app`.

Expected:
- App opens, shows the AgeWork frontend
- First launch creates `~/Library/Application Support/AgeWork/agework.db` (copied from the bundled `template.db`)
- Start a conversation with a Claude-backed agent — confirms the bundled `Resources/bin/claude` binary is used (no system `claude` CLI required)
- Start a conversation with a Codex-backed agent — confirms the bundled `Resources/bin/codex` binary works
- Quit the app; relaunch; confirm previous conversations are still listed (data persisted in `userData`)

- [ ] **Step 3: Port conflict check**

Run `pnpm dev` in the repo root (starts the normal dev server on port 3000) in one terminal, then launch the packaged `AgeWork.app` while it's running.

Expected: The desktop app starts successfully on a different port (check `logs/api.log` for the actual port) without conflicting with the dev server.

- [ ] **Step 4: Cleanup check**

Quit the app, then run:
```bash
rm -rf ~/Library/Application\ Support/AgeWork
```

Expected: Relaunching the app re-creates the directory and re-copies `template.db`, producing a fresh empty install (no leftover conversations).

- [ ] **Step 5: Record results**

If any step fails, note the failure and file it as a follow-up — do not fix unrelated issues as part of this task. If all steps pass, this plan is complete.

---

## Self-Review Notes

- **Spec coverage**: Items 1-7 and 9-10 of the design doc are covered by Tasks 1-10. Item 8 (Docker mode) and items under "范围外" (Windows, auto-update, notarization, Intel) are explicitly out of scope per the design doc and noted at the top of this plan as a follow-up.
- **Template DB vs `prisma db push` at runtime**: the design doc's "首启自动初始化...执行 `prisma db push`" step is implemented here via a **build-time** `template.db` (Task 9) copied at first run (Task 6), avoiding the need to bundle the `prisma` CLI + schema-engine binary (~23MB extra + complexity) in the packaged app. This is a simplification over the literal design doc wording but achieves the same observable outcome (fresh empty DB on first launch) with less packaging risk.
- **`.env` file**: the design doc mentions writing a `.env` in `userData`. This plan instead passes all required environment variables directly to the forked backend process (Task 7), which is simpler and sufficient for local-mode-only MVP. Persisted settings (e.g. for the Docker mode toggle) are deferred to the follow-up plan, which will introduce a settings file at that point.
- **Type consistency**: `ResourcePaths` (Task 4) is consumed by `first-run-init.ts` (Task 6, via `Pick<ResourcePaths, "templateDbPath">`) and `backend-process.ts` (Task 7, full type) — fields (`apiCwd`, `apiMainPath`, `templateDbPath`, `claudeCliPath`, `codexCliPath`) are consistent across all three. `UserDataPaths` fields (`root`, `dbPath`, `databaseUrl`, `workspaceDir`, `logsDir`) are consistent between Task 3, 6, and 7.
