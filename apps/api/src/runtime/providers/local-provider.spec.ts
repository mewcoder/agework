import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  LocalRuntimePlacement,
  RunConfig,
  RuntimeTarget,
} from "@agework/shared/protocol";
import { LocalRuntimeProvider } from "./local-provider";

const childProcessMock = vi.hoisted(() => {
  const child = {
    pid: 12345,
    send: vi.fn(),
    on: vi.fn(),
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    kill: vi.fn(),
    killed: false,
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
  return {
    ...makePlacement(),
    ownerId: "ws-1",
    ...overrides,
  } as RuntimeTarget;
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
    childProcessMock.child.killed = false;

    provider = new LocalRuntimeProvider();
    provider.setRunEventReceiver({
      sendEvent: vi.fn().mockResolvedValue(undefined),
      notifyWorkerError: vi.fn().mockResolvedValue(undefined),
      notifyCancelledBeforeReady: vi.fn().mockResolvedValue(undefined),
      recordCommandSent: vi.fn().mockResolvedValue(undefined),
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

  it("startWorkerExecution forks a local worker and sends the run config as RPC", () => {
    const runConfig = makeRunConfig();
    const runtimeTarget = makeRuntimeTarget();

    const handle = provider.startWorkerExecution({
      runtimeTarget,
      runConfig,
    });

    try {
      expect(childProcessMock.fork).toHaveBeenCalled();
      expect(childProcessMock.child.send).toHaveBeenCalledWith(
        expect.objectContaining({
          jsonrpc: "2.0",
          method: "run.config",
          params: {
            runId: "run-1",
            config: runConfig,
          },
          meta: expect.objectContaining({
            runId: "run-1",
            seq: 0,
          }),
        })
      );
      expect(provider.getHandle("run-1")).toBe(handle);
    } finally {
      provider.cleanup("run-1");
    }
  });

  it("startWorkerExecution fails fast when the runtime resource is not local", () => {
    expect(() =>
      provider.startWorkerExecution({
        runtimeTarget: makeRuntimeTarget({ runtimeType: "sandbox" }),
        runConfig: makeRunConfig(),
      })
    ).toThrow(
      "LocalRuntimeProvider cannot start worker for runtime type: sandbox"
    );
    expect(childProcessMock.fork).not.toHaveBeenCalled();
  });

  it("sendCommand sends JSON-RPC requests over IPC", () => {
    const handle = provider.startWorkerExecution({
      runtimeTarget: makeRuntimeTarget(),
      runConfig: makeRunConfig(),
    });
    childProcessMock.child.send.mockClear();

    provider.sendCommand(handle, {
      type: "interrupt",
      commandId: "cmd-1",
    });

    expect(childProcessMock.child.send).toHaveBeenCalledWith(
      expect.objectContaining({
        jsonrpc: "2.0",
        id: "cmd-1",
        method: "run.interrupt",
        params: { runId: "run-1" },
        meta: expect.objectContaining({
          runId: "run-1",
          seq: 1,
        }),
      })
    );
  });

  it("normalizes worker RPC notifications and responses before forwarding", () => {
    const sendEvent = vi.fn().mockResolvedValue(undefined);
    provider.setRunEventReceiver({
      sendEvent,
      notifyWorkerError: vi.fn().mockResolvedValue(undefined),
      notifyCancelledBeforeReady: vi.fn().mockResolvedValue(undefined),
      recordCommandSent: vi.fn().mockResolvedValue(undefined),
    });
    provider.startWorkerExecution({
      runtimeTarget: makeRuntimeTarget(),
      runConfig: makeRunConfig(),
    });
    const messageHandler = childProcessMock.child.on.mock.calls.find(
      ([event]) => event === "message"
    )?.[1] as ((message: unknown) => void) | undefined;
    expect(messageHandler).toBeTypeOf("function");

    messageHandler?.({
      jsonrpc: "2.0",
      method: "run.status",
      params: {
        runId: "run-1",
        status: { status: "running" },
      },
      meta: {
        runId: "run-1",
        seq: 1,
        ts: "2026-06-27T00:00:00.000Z",
      },
    });
    messageHandler?.({
      jsonrpc: "2.0",
      id: "cmd-1",
      result: {
        ok: true,
        commandType: "cancel",
      },
      meta: {
        runId: "run-1",
        seq: 2,
        ts: "2026-06-27T00:00:01.000Z",
      },
    });

    expect(sendEvent).toHaveBeenNthCalledWith(
      1,
      "run-1",
      expect.objectContaining({
        type: "run.status",
        seq: 1,
        payload: { status: "running" },
      })
    );
    expect(sendEvent).toHaveBeenNthCalledWith(
      2,
      "run-1",
      expect.objectContaining({
        type: "command.result",
        seq: 2,
        payload: {
          commandId: "cmd-1",
          commandType: "cancel",
          status: "ok",
        },
      })
    );
  });

  it("terminateExecution sends SIGTERM to the local worker and clears state", () => {
    const handle = provider.startWorkerExecution({
      runtimeTarget: makeRuntimeTarget(),
      runConfig: makeRunConfig(),
    });

    provider.terminateExecution("run-1", "run timeout");

    expect(childProcessMock.child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(provider.getHandle("run-1")).toBeUndefined();
    provider.sendCommand(handle, {
      type: "interrupt",
      commandId: "command-1",
    });
    expect(childProcessMock.child.send).toHaveBeenCalledTimes(1);
  });

  describe("recoverOrphan()", () => {
    it("sends SIGTERM to the pid encoded in a 'pid:token' runtimeInstanceId", async () => {
      const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);

      await provider.recoverOrphan("12345:some-token");

      expect(killSpy).toHaveBeenCalledWith(12345, "SIGTERM");
    });

    it("does nothing for a malformed runtimeInstanceId", async () => {
      const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);

      await provider.recoverOrphan("not-a-valid-runtime-id");

      expect(killSpy).not.toHaveBeenCalled();
    });

    it("ignores ESRCH when the process is already gone", async () => {
      vi.spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      });

      await expect(
        provider.recoverOrphan("12345:some-token")
      ).resolves.toBeUndefined();
    });
  });
});
