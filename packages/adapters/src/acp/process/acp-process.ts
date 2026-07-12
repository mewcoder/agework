import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export type AcpProcessOptions = {
  /** Executable to launch (e.g. resolved `opencode` binary). */
  command: string;
  /** Arguments (e.g. `["acp"]`). */
  args: readonly string[];
  /** Working directory — must be the Runtime workspace path. */
  cwd: string;
  /** Full environment for the child. Caller is responsible for safe-env filtering. */
  env: Record<string, string>;
  /** Max stderr lines retained in the diagnostic ring buffer. Default 50. */
  stderrRingSize?: number;
  /** Grace period between SIGTERM and SIGKILL on terminate. Default 3000ms. */
  killGraceMs?: number;
  /** Invoked for each stderr line (raw trace hook). */
  onStderr?: (line: string) => void;
};

export type AcpExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

const DEFAULT_STDERR_RING = 50;
const DEFAULT_KILL_GRACE_MS = 3000;

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
 * Owns a single ACP agent subprocess and its byte streams. It does not
 * understand the ACP protocol, sessions, or AG-UI — only process lifecycle and
 * stdout/stderr separation.
 *
 * - `stdout` is the ACP wire; it is exposed raw and consumed by the connection layer.
 * - `stderr` is drained here into a ring buffer and forwarded to `onStderr`.
 */
export class AcpProcess {
  private child?: ChildProcess;
  private exitPromise?: Promise<AcpExit>;
  private readonly stderrRing: string[] = [];
  private terminating?: Promise<void>;
  private exited = false;
  private exitInfo: AcpExit = { code: null, signal: null };
  /** Populated when the process failed to spawn (e.g. ENOENT). */
  private spawnError?: Error;

  constructor(private readonly opts: AcpProcessOptions) {}

  /** Spawn the subprocess. Throws if called more than once. */
  start(): void {
    if (this.child) throw new Error("AcpProcess already started");

    const isWindows = process.platform === "win32";
    // Node ≥18 requires a shell to launch `.cmd`/`.bat` on Windows.
    const useShell = isWindows && /\.(cmd|bat)$/i.test(this.opts.command);

    const child = spawn(this.opts.command, [...this.opts.args], {
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: useShell,
    });
    this.child = child;

    this.exitPromise = new Promise<AcpExit>((resolve) => {
      child.once("exit", (code, signal) => {
        this.exited = true;
        this.exitInfo = { code, signal };
        resolve(this.exitInfo);
      });
      child.once("error", (err) => {
        // Spawn failure: `exit` never fires, so resolve here.
        this.spawnError = err instanceof Error ? err : new Error(String(err));
        this.exited = true;
        this.exitInfo = { code: null, signal: null };
        resolve(this.exitInfo);
      });
    });

    this.drainStderr(child);
  }

  /** The stream we write outgoing JSON-RPC to (the child's stdin). */
  get stdin(): Writable {
    return this.requireChild().stdin as Writable;
  }

  /** The ACP wire — incoming JSON-RPC from the agent (the child's stdout). */
  get stdout(): Readable {
    return this.requireChild().stdout as Readable;
  }

  /** Resolves when the process exits (or fails to spawn). Never rejects. */
  get exit(): Promise<AcpExit> {
    if (!this.exitPromise) throw new Error("AcpProcess not started");
    return this.exitPromise;
  }

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

  /** Snapshot of the most recent stderr lines retained for diagnostics. */
  recentStderr(): string[] {
    return [...this.stderrRing];
  }

  /**
   * Terminate the subprocess tree. Idempotent — repeated calls return the same
   * in-flight promise. Sequence: SIGTERM → grace timeout → SIGKILL (Windows uses
   * `taskkill /T /F` for tree termination).
   */
  terminate(): Promise<void> {
    if (!this.terminating) this.terminating = this.doTerminate();
    return this.terminating;
  }

  private async doTerminate(): Promise<void> {
    const child = this.child;
    if (!child || this.exited) return;

    if (process.platform === "win32" && child.pid != null) {
      // Kill the whole tree so no orphaned agent grandchildren survive.
      try {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
      } catch {
        child.kill("SIGKILL");
      }
      await this.exit;
      return;
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

  private drainStderr(child: ChildProcess): void {
    if (!child.stderr) return;
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

  private requireChild(): ChildProcess {
    if (!this.child) throw new Error("AcpProcess not started");
    return this.child;
  }
}
