import { fork, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { join } from "node:path";
import type { ResourcePaths } from "./resource-paths";
import type { UserDataPaths } from "./user-data-paths";

export type BackendHandle = {
  process: ChildProcess;
  port: number;
  stop: () => Promise<void>;
};

const BLOCKED_ENV_PREFIXES = ["ELECTRON_", "VITE_"];
const BLOCKED_ENV_KEYS = new Set([
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  "UV_THREADPOOL_SIZE",
]);

/** Forks the compiled NestJS backend with desktop-specific environment variables. */
export function startBackend(
  resources: ResourcePaths,
  userData: UserDataPaths,
  port: number
): BackendHandle {
  const logStream = createWriteStream(join(userData.apiLogsDir, "api.log"), {
    flags: "a",
  });

  const env = createBackendEnv({
    PORT: String(port),
    NODE_ENV: "development",
    AGEWORK_PRIVATE_DATABASE_URL: userData.databaseUrl,
    AGEWORK_DATA_DIR: userData.root,
    AGEWORK_PRIVATE_JWT_SECRET: "agework-desktop-local-secret",
    AGEWORK_DEV_AUTH_DISABLED: "true",
    AGEWORK_SERVE_FRONTEND: "true",
    AGEWORK_RUNTIME_ALLOWED_TYPES: "native",
    AGEWORK_RUNTIME_ALLOWED_ISOLATION_SCOPES: "user",
  });
  if (!resources.backendExecPath) env.ELECTRON_RUN_AS_NODE = "1";
  if (resources.claudeCliPath) env.AGEWORK_CLAUDE_CLI_PATH = resources.claudeCliPath;
  if (resources.codexCliPath) env.AGEWORK_CODEX_CLI_PATH = resources.codexCliPath;

  const forkOptions = {
    cwd: resources.serverCwd,
    env,
    ...(resources.backendExecPath ? { execPath: resources.backendExecPath } : {}),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  } as Parameters<typeof fork>[2] & { windowsHide: boolean };

  const child = fork(resources.serverMainPath, [], forkOptions);

  child.stdout?.pipe(logStream);
  child.stderr?.pipe(logStream);

  return {
    process: child,
    port,
    stop: () => stopChild(child, logStream),
  };
}

export function createBackendEnv(
  overrides: NodeJS.ProcessEnv,
  baseEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (BLOCKED_ENV_KEYS.has(key)) continue;
    if (BLOCKED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    env[key] = value;
  }

  return {
    ...env,
    ...overrides,
  };
}

/** Polls the public `/api/v1/system/about` endpoint until the backend responds. */
export async function waitForBackendReady(
  handle: BackendHandle,
  timeoutMs = 30_000
): Promise<void> {
  const { port, process: child } = handle;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | undefined;

  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    exitInfo = { code, signal };
  };
  child.once("exit", onExit);

  try {
    while (Date.now() < deadline) {
      if (exitInfo || child.exitCode !== null || child.signalCode !== null) {
        const code = exitInfo?.code ?? child.exitCode;
        const signal = exitInfo?.signal ?? child.signalCode;
        throw new Error(
          `Backend exited before ready on port ${port} (code=${code ?? "null"}, signal=${signal ?? "null"})`
        );
      }

      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/v1/system/about`);
        if (res.ok) return;
        lastError = new Error(`HTTP ${res.status}`);
      } catch (error) {
        lastError = error;
      }
      await sleep(300);
    }

    throw new Error(
      `Backend did not become ready on port ${port} within ${timeoutMs}ms: ${String(
        lastError
      )}`
    );
  } finally {
    child.off("exit", onExit);
  }
}

/**
 * Polls the backend health endpoint at a fixed interval. Calls `onUnhealthy` once after
 * `maxFailures` consecutive failures, then stops. Returns a `stop` fn to cancel polling.
 */
export function startRuntimeHealthCheck(
  port: number,
  onUnhealthy: () => void,
  intervalMs = 30_000,
  maxFailures = 3
): () => void {
  let failures = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const check = async () => {
    if (stopped) return;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/system/about`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) {
        failures = 0;
      } else {
        failures += 1;
      }
    } catch {
      failures += 1;
    }

    if (stopped) return;

    if (failures >= maxFailures) {
      stopped = true;
      onUnhealthy();
      return;
    }

    timer = setTimeout(() => void check(), intervalMs);
    timer.unref();
  };

  timer = setTimeout(() => void check(), intervalMs);
  timer.unref();

  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stopChild(child: ChildProcess, logStream: WriteStream): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    logStream.end();
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceKillTimer);
      clearTimeout(settleTimer);
      logStream.end();
      resolve();
    };

    const forceKillTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, 2000);
    forceKillTimer.unref();

    const settleTimer = setTimeout(finish, 3000);
    settleTimer.unref();

    child.once("exit", finish);
    child.kill("SIGTERM");
  });
}
