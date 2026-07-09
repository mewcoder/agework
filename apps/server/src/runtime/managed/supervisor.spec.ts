import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { ConfigService } from "../../config/config.service";
import { ManagedRuntimeSupervisor, type ProcessSpawner } from "./supervisor";

/** 创建一个 mock ChildProcess,可通过 emit 模拟 exit/error 事件。 */
function createMockChild(pid: number): ChildProcess & EventEmitter {
  const ee = new EventEmitter();
  return {
    pid,
    kill: vi.fn(),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    on: ee.on.bind(ee) as never,
    emit: ee.emit.bind(ee) as never,
    once: ee.once.bind(ee) as never,
    off: ee.off.bind(ee) as never,
    removeAllListeners: ee.removeAllListeners.bind(ee) as never,
  } as unknown as ChildProcess & EventEmitter;
}

function makeConfigService(): Partial<ConfigService> {
  return {
    getRuntimeLogDir: vi.fn().mockReturnValue("/tmp/agework-logs"),
  };
}

describe("ManagedRuntimeSupervisor", () => {
  let configService: Partial<ConfigService>;
  let children: (ChildProcess & EventEmitter)[];
  let spawner: ReturnType<typeof vi.fn>;
  let supervisor: ManagedRuntimeSupervisor;

  beforeEach(() => {
    vi.useFakeTimers();
    configService = makeConfigService();
    children = [];
    let pidCounter = 1000;
    spawner = vi.fn(() => {
      const child = createMockChild(++pidCounter);
      children.push(child);
      return child;
    });
    supervisor = new ManagedRuntimeSupervisor(
      configService as ConfigService,
      spawner as unknown as ProcessSpawner
    );
  });

  afterEach(() => {
    supervisor.onApplicationShutdown();
    vi.useRealTimers();
  });

  it("skips native (stays in-process, no fork)", () => {
    supervisor.startManagedRuntime("native", "token-native");
    expect(spawner).not.toHaveBeenCalled();
  });

  it("forks a runtime process for docker with loopback + token env", () => {
    supervisor.startManagedRuntime("docker", "managed-token-123");

    expect(spawner).toHaveBeenCalledTimes(1);
    const [entryPath, env] = spawner.mock.calls[0];
    expect(entryPath).toEqual(expect.any(String));
    expect(env.AGEWORK_SERVER_BASE_URL).toContain("http://127.0.0.1:");
    expect(env.AGEWORK_RUNTIME_TOKEN).toBe("managed-token-123");
    expect(env.AGEWORK_RUNTIME_TYPE).toBe("docker");
    expect(env.AGEWORK_RUNTIME_WORKER_IMAGE).toBeDefined();
    expect(env.AGEWORK_RUNTIME_LOG_DIR).toBe("/tmp/agework-logs");
  });

  it("is idempotent: calling start twice for same type is a no-op", () => {
    supervisor.startManagedRuntime("docker", "token-1");
    supervisor.startManagedRuntime("docker", "token-2");

    expect(spawner).toHaveBeenCalledTimes(1);
  });

  it("restarts immediately on first crash", () => {
    supervisor.startManagedRuntime("docker", "token-1");
    expect(spawner).toHaveBeenCalledTimes(1);
    expect(children).toHaveLength(1);

    // simulate crash
    children[0].emit("exit", 1, "SIGTERM");

    // should have respawned immediately (no timer)
    expect(spawner).toHaveBeenCalledTimes(2);
    expect(children).toHaveLength(2);
  });

  it("applies exponential backoff on subsequent crashes", () => {
    supervisor.startManagedRuntime("docker", "token-1");

    // first crash: immediate restart
    children[0].emit("exit", 1, null);
    expect(spawner).toHaveBeenCalledTimes(2);

    // second crash: 1s delay
    children[1].emit("exit", 1, null);
    expect(spawner).toHaveBeenCalledTimes(2); // not yet, waiting for timer

    vi.advanceTimersByTime(999);
    expect(spawner).toHaveBeenCalledTimes(2); // still waiting

    vi.advanceTimersByTime(2);
    expect(spawner).toHaveBeenCalledTimes(3); // respawned after 1s

    // third crash: 2s delay
    children[2].emit("exit", 1, null);
    vi.advanceTimersByTime(1999);
    expect(spawner).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(2);
    expect(spawner).toHaveBeenCalledTimes(4);
  });

  it("capped at 30s backoff", () => {
    supervisor.startManagedRuntime("docker", "token-1");

    // crash many times to reach the cap
    let childIndex = 0;
    const crash = () => {
      children[childIndex].emit("exit", 1, null);
      childIndex++;
    };

    crash(); // immediate → delay becomes 1s
    vi.advanceTimersByTime(1000); // respawn after 1s

    crash(); // 1s delay → delay becomes 2s
    vi.advanceTimersByTime(2000);

    crash(); // 2s → 4s
    vi.advanceTimersByTime(4000);

    crash(); // 4s → 8s
    vi.advanceTimersByTime(8000);

    crash(); // 8s → 16s
    vi.advanceTimersByTime(16000);

    crash(); // 16s → 30s (capped)
    vi.advanceTimersByTime(30000);

    // after 30s wait, should have respawned
    const countAfterCap = spawner.mock.calls.length;

    crash(); // 30s → 30s (stays capped)
    vi.advanceTimersByTime(29999);
    expect(spawner.mock.calls.length).toBe(countAfterCap); // still waiting
    vi.advanceTimersByTime(2);
    expect(spawner.mock.calls.length).toBe(countAfterCap + 1); // respawned
  });

  it("kills all child processes on shutdown and stops restarting", () => {
    supervisor.startManagedRuntime("docker", "token-1");
    supervisor.startManagedRuntime("opensandbox", "token-2");

    supervisor.onApplicationShutdown();

    // both children should have been killed
    expect(children[0].kill).toHaveBeenCalledWith("SIGTERM");
    expect(children[1].kill).toHaveBeenCalledWith("SIGTERM");

    // crash after shutdown should not trigger restart
    const spawnCountBefore = spawner.mock.calls.length;
    children[0].emit("exit", 1, null);
    expect(spawner.mock.calls.length).toBe(spawnCountBefore);
  });

  it("cancels pending restart timer on shutdown", () => {
    supervisor.startManagedRuntime("docker", "token-1");

    // crash to schedule a delayed restart
    children[0].emit("exit", 1, null); // immediate restart
    children[1].emit("exit", 1, null); // schedules 1s delay

    const spawnCountBeforeShutdown = spawner.mock.calls.length;

    supervisor.onApplicationShutdown();

    // advancing timers should not trigger respawn
    vi.advanceTimersByTime(60_000);
    expect(spawner.mock.calls.length).toBe(spawnCountBeforeShutdown);
  });
});
