import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  LocalRuntimePlacement,
  RunConfig,
  RuntimeTarget,
} from "@agework/shared/protocol";
import { LocalRunExecutor } from "./local.executor";
import type { WorkerHostService } from "../../worker-host/worker-host.service";

function makeWorkerHost(overrides: Record<string, unknown> = {}) {
  return {
    acquireLocalInstanceForRun: vi
      .fn()
      .mockResolvedValue({ outcome: "ready", runtimeInstanceId: "4242:token" }),
    openSession: vi.fn(),
    sendCommand: vi.fn(),
    cleanupRun: vi.fn(),
    recoverOrphanLocalInstance: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makePlacement(
  overrides: Partial<LocalRuntimePlacement> = {}
): LocalRuntimePlacement {
  return {
    runtimeType: "local",
    userId: "user-1",
    workspaceId: "ws-1",
    hostPath: "/tmp/ws",
    runtimePath: "/tmp/ws",
    ...overrides,
  };
}

function makeRunConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    runId: "run-1",
    conversationId: "conversation-1",
    workspaceId: "ws-1",
    input: {},
    ...overrides,
  } as RunConfig;
}

function makeRuntimeTarget(
  overrides: Partial<RuntimeTarget> = {}
): RuntimeTarget {
  return { ...makePlacement(), ownerId: "ws-1", ...overrides } as RuntimeTarget;
}

describe("LocalRunExecutor", () => {
  let executor: LocalRunExecutor;
  let workerHost: ReturnType<typeof makeWorkerHost>;
  let receiver: {
    recordCommandSent: ReturnType<typeof vi.fn>;
    notifyWorkerError: ReturnType<typeof vi.fn>;
    notifyCancelledBeforeReady: ReturnType<typeof vi.fn>;
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  beforeEach(() => {
    workerHost = makeWorkerHost();
    executor = new LocalRunExecutor(workerHost as unknown as WorkerHostService);
    receiver = {
      recordCommandSent: vi.fn().mockResolvedValue(undefined),
      notifyWorkerError: vi.fn().mockResolvedValue(undefined),
      notifyCancelledBeforeReady: vi.fn().mockResolvedValue(undefined),
    };
    executor.setRunEventPort(receiver as never);
  });

  it("declares the local runtime type", () => {
    expect(executor.type).toBe("local");
  });

  it("returns a handle synchronously and acquires the instance via worker-host", () => {
    const handle = executor.start({
      runtimeTarget: makeRuntimeTarget(),
      runConfig: makeRunConfig(),
    });
    expect(handle.runId).toBe("run-1");
    expect(handle.runtimeInstanceId).toBe("");
    expect(workerHost.acquireLocalInstanceForRun).toHaveBeenCalled();
  });

  it("on ready: opens the worker session and dispatches the first user_message", async () => {
    const handle = executor.start({
      runtimeTarget: makeRuntimeTarget(),
      runConfig: makeRunConfig(),
    });
    await flush();

    expect(handle.runtimeInstanceId).toBe("4242:token");
    expect(workerHost.openSession).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", ownerId: "ws-1" })
    );
    expect(workerHost.sendCommand).toHaveBeenCalledWith(
      "ws-1",
      "run-1",
      expect.objectContaining({ type: "user_message", runId: "run-1" })
    );
    expect(receiver.recordCommandSent).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", commandType: "user_message" })
    );
  });

  it("on error: notifies run, never opens a session", async () => {
    workerHost.acquireLocalInstanceForRun.mockResolvedValueOnce({
      outcome: "error",
      error: "boom",
    });
    executor.start({
      runtimeTarget: makeRuntimeTarget(),
      runConfig: makeRunConfig(),
    });
    await flush();

    expect(workerHost.openSession).not.toHaveBeenCalled();
    expect(receiver.notifyWorkerError).toHaveBeenCalledWith("run-1", "boom");
  });

  it("cancel before ready: marks cancelled, skips the session even if ready arrives later", async () => {
    let resolveAcquire!: (result: unknown) => void;
    workerHost.acquireLocalInstanceForRun.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveAcquire = resolve;
      })
    );
    const handle = executor.start({
      runtimeTarget: makeRuntimeTarget(),
      runConfig: makeRunConfig(),
    });

    executor.cancel(handle);
    resolveAcquire({ outcome: "ready", runtimeInstanceId: "4242:token" });
    await flush();

    expect(workerHost.openSession).not.toHaveBeenCalled();
    expect(receiver.notifyCancelledBeforeReady).toHaveBeenCalledWith("run-1");
  });

  it("cancel after ready: dispatches a cancel command", async () => {
    const handle = executor.start({
      runtimeTarget: makeRuntimeTarget(),
      runConfig: makeRunConfig(),
    });
    await flush();
    workerHost.sendCommand.mockClear();

    executor.cancel(handle);

    expect(workerHost.sendCommand).toHaveBeenCalledWith(
      "ws-1",
      "run-1",
      expect.objectContaining({ type: "cancel", runId: "run-1" })
    );
  });

  it("cleanup releases the worker session via worker-host", async () => {
    executor.start({
      runtimeTarget: makeRuntimeTarget(),
      runConfig: makeRunConfig(),
    });
    await flush();

    executor.cleanup("run-1");

    expect(workerHost.cleanupRun).toHaveBeenCalledWith("run-1");
  });

  it("cleanupInterruptedExecution delegates to worker-host", async () => {
    await executor.cleanupInterruptedExecution("4242:token-9");
    expect(workerHost.recoverOrphanLocalInstance).toHaveBeenCalledWith(
      "4242:token-9"
    );
  });
});
