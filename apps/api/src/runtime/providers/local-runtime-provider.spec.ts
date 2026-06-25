import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  RunConfig,
  RuntimePlacement,
  RuntimeResourceHandle,
} from "@agework/shared/protocol";
import { LocalRuntimeProvider } from "./local-runtime-provider";

const childProcessMock = vi.hoisted(() => {
  const child = {
    pid: 12345,
    send: vi.fn(),
    on: vi.fn(),
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    kill: vi.fn(),
  };

  return {
    child,
    fork: vi.fn(() => child),
  };
});

vi.mock("node:child_process", () => ({
  fork: childProcessMock.fork,
}));

function makePlacement(
  overrides: Partial<RuntimePlacement> = {}
): RuntimePlacement {
  return {
    runtimeType: "local",
    isolationScope: "workspace",
    userId: "user-1",
    workspaceId: "ws-1",
    hostPath: "/tmp/ws",
    runtimePath: "/tmp/ws",
    mountTarget: "/tmp/ws",
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

function makeRuntimeResource(
  overrides: Partial<RuntimeResourceHandle> = {}
): RuntimeResourceHandle {
  const placement = makePlacement();
  return {
    runtimeType: "local",
    resourceKey: "ws-1",
    workspaceId: "ws-1",
    isolationScope: "workspace",
    placement,
    ...overrides,
  };
}

describe("LocalRuntimeProvider", () => {
  let provider: LocalRuntimeProvider;

  beforeEach(() => {
    childProcessMock.fork.mockClear();
    childProcessMock.child.send.mockClear();
    childProcessMock.child.on.mockClear();
    childProcessMock.child.stdout.on.mockClear();
    childProcessMock.child.stderr.on.mockClear();
    childProcessMock.child.kill.mockClear();

    provider = new LocalRuntimeProvider();
    provider.setRunEventReceiver({
      publish: vi.fn().mockResolvedValue(undefined),
      isTerminalOrFinalizing: vi.fn().mockReturnValue(false),
      forceErrorStatus: vi.fn().mockResolvedValue(undefined),
      forceCancelledStatus: vi.fn().mockResolvedValue(undefined),
      recordControlSent: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a provider instance", () => {
    expect(provider).toBeDefined();
  });

  it("getHandle returns undefined for unknown runId", () => {
    expect(provider.getHandle("nonexistent")).toBeUndefined();
  });

  it("provision returns a local runtime resource handle without forking a worker", () => {
    const placement = makePlacement();

    const runtimeResource = provider.provision(placement);

    expect(runtimeResource).toEqual({
      runtimeType: "local",
      resourceKey: "ws-1",
      workspaceId: "ws-1",
      isolationScope: "workspace",
      placement,
    });
    expect(childProcessMock.fork).not.toHaveBeenCalled();
  });

  it("startWorkerExecution forks a local worker and sends the run config", () => {
    const runConfig = makeRunConfig();
    const runtimeResource = makeRuntimeResource();

    const handle = provider.startWorkerExecution({
      runtimeResource,
      runConfig,
    });

    expect(childProcessMock.fork).toHaveBeenCalled();
    expect(childProcessMock.child.send).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        seq: 0,
        type: "run.config",
        payload: runConfig,
      })
    );
    expect(provider.getHandle("run-1")).toBe(handle);
  });

  it("startWorkerExecution fails fast when the runtime resource is not local", () => {
    expect(() =>
      provider.startWorkerExecution({
        runtimeResource: makeRuntimeResource({ runtimeType: "sandbox" }),
        runConfig: makeRunConfig(),
      })
    ).toThrow(
      "LocalRuntimeProvider cannot start worker for runtime type: sandbox"
    );
    expect(childProcessMock.fork).not.toHaveBeenCalled();
  });

  describe("recoverOrphan()", () => {
    it("sends SIGTERM to the pid encoded in a 'pid:token' runtimeResourceId", async () => {
      const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);

      await provider.recoverOrphan("12345:some-token");

      expect(killSpy).toHaveBeenCalledWith(12345, "SIGTERM");
    });

    it("does nothing for a malformed runtimeResourceId", async () => {
      const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);

      await provider.recoverOrphan("not-a-valid-runtime-id");

      expect(killSpy).not.toHaveBeenCalled();
    });

    it("ignores ESRCH when the process is already gone", async () => {
      vi.spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      });

      await expect(provider.recoverOrphan("12345:some-token")).resolves.toBeUndefined();
    });
  });
});
