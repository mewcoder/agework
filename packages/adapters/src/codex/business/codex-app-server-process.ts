/**
 * Codex app-server subprocess lifecycle manager.
 *
 * Lives in `business/` because it owns execution concerns: spawning the
 * codex binary, env whitelist, stdio, kill / SIGTERM→SIGKILL. It does **not**
 * understand the JSON-RPC protocol — that is `base/app-server/client.ts`.
 *
 * Implements {@link AppServerTransport} so the client can be constructed
 * directly with a process instance.
 *
 * Pattern mirrors `AcpProcess` (`packages/agent-acp/src/engine/process.ts`).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { AppServerTransport } from "../base/app-server/types";

export type CodexAppServerProcessOptions = {
  /** Path to the codex CLI binary (already resolved via worker `codexExecutablePath`). */
  codexPath: string;
  /** Working directory — must be the validated Runtime workspace path. */
  cwd: string;
  /** Full environment for the child. Caller is responsible for safe-env filtering. */
  env: Record<string, string>;
  /** Grace period between SIGTERM and SIGKILL on terminate. Default 5000ms. */
  killGraceMs?: number;
  /** Max stderr lines retained in the diagnostic ring buffer. Default 50. */
  stderrRingSize?: number;
  /** Invoked for each stderr line (raw trace / log hook). */
  onStderr?: (line: string) => void;
};

export type CodexAppServerExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

const DEFAULT_KILL_GRACE_MS = 5_000;
const DEFAULT_STDERR_RING = 50;

/** Detached timer so a pending grace timeout never keeps the event loop alive. */
function delay(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timer: NodeJS.Timeout;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/**
 * Owns a single `codex app-server` subprocess and its byte streams.
 *
 * - `stdout` is the JSON-RPC wire (newline-delimited JSON).
 * - `stderr` is drained here into a ring buffer and forwarded to `onStderr`.
 *
 * Implements {@link AppServerTransport} for direct use with
 * {@link CodexAppServerClient}.
 */
export class CodexAppServerProcess implements AppServerTransport {
  private child?: ChildProcess;
  private exitPromise?: Promise<CodexAppServerExit>;
  private readonly stderrRing: string[] = [];
  private terminating?: Promise<void>;
  private exited = false;
  private exitInfo: CodexAppServerExit = { code: null, signal: null };
  private spawnError?: Error;

  /** Lines received before `onMessage` is called are buffered here. */
  private lineBuffer: string[] = [];
  private lineHandler?: (line: string) => void;
  private readonly closeHandlers = new Set<() => void>();

  constructor(private readonly opts: CodexAppServerProcessOptions) {}

  /** Spawn the `codex app-server` subprocess. Throws if called more than once. */
  start(): void {
    if (this.child) throw new Error("CodexAppServerProcess already started");

    const child = spawn(this.opts.codexPath, ["app-server"], {
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    this.child = child;

    this.exitPromise = new Promise<CodexAppServerExit>((resolve) => {
      child.once("exit", (code, signal) => {
        this.exited = true;
        this.exitInfo = { code, signal };
        this.fireCloseHandlers();
        resolve(this.exitInfo);
      });
      child.once("error", (err) => {
        // Spawn failure: `exit` never fires, so resolve here.
        this.spawnError =
          err instanceof Error ? err : new Error(String(err));
        this.exited = true;
        this.exitInfo = { code: null, signal: null };
        this.fireCloseHandlers();
        resolve(this.exitInfo);
      });
    });

    // Drain stderr into ring buffer + callback
    if (child.stderr) {
      const ringSize = this.opts.stderrRingSize ?? DEFAULT_STDERR_RING;
      const rl = createInterface({ input: child.stderr });
      rl.on("line", (line) => {
        this.stderrRing.push(line);
        if (this.stderrRing.length > ringSize) this.stderrRing.shift();
        try {
          this.opts.onStderr?.(line);
        } catch {
          // A trace hook must never break stderr draining.
        }
      });
    }

    // Read stdout line by line (the JSON-RPC wire)
    if (child.stdout) {
      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        if (this.lineHandler) {
          this.lineHandler(line);
        } else {
          this.lineBuffer.push(line);
        }
      });
    }
  }

  // ── AppServerTransport ────────────────────────────────────────────────────

  /** Write a raw string to the server's stdin (newline already included). */
  send(message: string): void {
    if (!this.child?.stdin) {
      throw new Error("CodexAppServerProcess not started or stdin closed");
    }
    this.child.stdin.write(message);
  }

  /** Register a handler for each line from the server's stdout. */
  onMessage(handler: (line: string) => void): void {
    this.lineHandler = handler;
    // Flush any lines that arrived before the handler was registered.
    if (this.lineBuffer.length > 0) {
      for (const line of this.lineBuffer) {
        handler(line);
      }
      this.lineBuffer = [];
    }
  }

  /** Register a handler for when the process exits. */
  onClose(handler: () => void): void {
    if (this.exited) {
      // Already exited — fire on next tick to be async-safe.
      setImmediate(() => {
        try {
          handler();
        } catch {
          // Handler must not throw.
        }
      });
      return;
    }
    this.closeHandlers.add(handler);
  }

  // ── Process info ──────────────────────────────────────────────────────────

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get hasExited(): boolean {
    return this.exited;
  }

  /** Error captured if the process failed to spawn. */
  get error(): Error | undefined {
    return this.spawnError;
  }

  /** Resolves when the process exits (or fails to spawn). Never rejects. */
  get exit(): Promise<CodexAppServerExit> {
    if (!this.exitPromise) {
      throw new Error("CodexAppServerProcess not started");
    }
    return this.exitPromise;
  }

  /** Snapshot of the most recent stderr lines retained for diagnostics. */
  recentStderr(): string[] {
    return [...this.stderrRing];
  }

  // ── Spawn configuration (for testing) ─────────────────────────────────────

  /** @internal — the binary path passed to spawn. */
  get spawnFile(): string | undefined {
    return this.child?.spawnfile;
  }

  /** @internal — the args passed to spawn. Always `["app-server"]`. */
  get spawnArgs(): string[] {
    return this.child?.spawnargs ?? [];
  }

  // ── Termination ───────────────────────────────────────────────────────────

  /**
   * Terminate the subprocess. Idempotent — repeated calls return the same
   * in-flight promise. Sequence: SIGTERM → grace timeout → SIGKILL.
   */
  terminate(): Promise<void> {
    if (!this.terminating) this.terminating = this.doTerminate();
    return this.terminating;
  }

  /**
   * Synchronously SIGKILL the child process. Used as a last-resort
   * cleanup in `process.on('exit')` to prevent orphaned subprocesses
   * when the runner is force-killed (§7 of migration doc).
   *
   * This is **not** a replacement for `terminate()` — it skips the
   * graceful SIGTERM → grace period → SIGKILL sequence and immediately
   * sends SIGKILL. Only call from exit handlers or fatal error paths.
   */
  forceKill(): void {
    const child = this.child;
    if (!child || this.exited) return;
    try {
      child.kill("SIGKILL");
    } catch {
      // Already dead or pid reused — nothing to do.
    }
  }

  private async doTerminate(): Promise<void> {
    const child = this.child;
    if (!child || this.exited) return;

    // Close stdin first to signal the server to shut down gracefully.
    try {
      child.stdin?.end();
    } catch {
      // stdin may already be closed.
    }

    child.kill("SIGTERM");
    const grace = this.opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    const timeout = delay(grace);
    const outcome = await Promise.race([
      this.exit.then(() => "exited" as const),
      timeout.promise.then(() => "timeout" as const),
    ]);
    timeout.cancel();
    if (outcome === "timeout" && !this.exited) {
      child.kill("SIGKILL");
    }
    await this.exit;
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private fireCloseHandlers(): void {
    for (const handler of this.closeHandlers) {
      try {
        handler();
      } catch {
        // A handler error must not break cleanup.
      }
    }
  }
}
