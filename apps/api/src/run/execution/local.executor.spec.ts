import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  LocalRuntimePlacement,
  RunConfig,
  RuntimeTarget,
} from "@agework/shared/protocol";
import { LocalRunExecutor } from "./local.executor";
import type { RuntimeService } from "../../runtime/runtime.service";

const childMock = vi.hoisted(() => ({
  pid: 12345,
  send: vi.fn(),
  on: vi.fn(),
  stdout: { on: vi.fn() },
  stderr: { on: vi.fn() },
  kill: vi.fn(),
  killed: false,
}));

function makeRuntimeService(overrides: Record<string, unknown> = {}) {
  return {
    launchLocal: vi.fn(() => ({
      runtimeInstanceId: "12345:test-token",
      channel: childMock,
    })),
    recoverOrphanLocal: vi.fn().mockResolvedValue(undefined),
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
  return {
    ...makePlacement(),
    ownerId: "ws-1",
    ...overrides,
  } as RuntimeTarget;
}

describe("LocalRunExecutor", () => {
  let provider: LocalRunExecutor;
  let runtimeService: ReturnType<typeof makeRuntimeService>;

  beforeEach(() => {
    childMock.send.mockClear();
    childMock.on.mockClear();
    childMock.stdout.on.mockClear();
    childMock.stderr.on.mockClear();
    childMock.kill.mockClear();
    childMock.killed = false;

    runtimeService = makeRuntimeService();
    provider = new LocalRunExecutor(
      runtimeService as unknown as RuntimeService
    );
    provider.setRunEventPort({
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

  it("start launches a local runtime instance via RuntimeService and sends the run config as RPC", () => {
    const runConfig = makeRunConfig();
    const runtimeTarget = makeRuntimeTarget();

    const handle = provider.start({ runtimeTarget, runConfig });

    try {
      expect(runtimeService.launchLocal).toHaveBeenCalledWith({
        runId: "run-1",
        env: expect.objectContaining({
          AGEWORK_WORKER_KEEP_ALIVE: "false",
          AGEWORK_WORKER_CHANNEL: "ipc",
          AGEWORK_WORKER_RUN_ID: "run-1",
        }),
      });
      expect(childMock.send).toHaveBeenCalledWith(
        expect.objectContaining({
          jsonrpc: "2.0",
          method: "run.config",
          params: { runId: "run-1", config: runConfig },
          meta: expect.objectContaining({ runId: "run-1", seq: 0 }),
        })
      );
      expect(handle).toMatchObject({
        runId: "run-1",
        runtimeType: "local",
        runtimeInstanceId: "12345:test-token",
        conversationId: "conversation-1",
      });
    } finally {
      provider.cleanup("run-1");
    }
  });

  it("start fails fast when the runtime resource is not local", () => {
    expect(() =>
      provider.start({
        runtimeTarget: makeRuntimeTarget({ runtimeType: "sandbox" }),
        runConfig: makeRunConfig(),
      })
    ).toThrow("LocalRunExecutor cannot start worker for runtime type: sandbox");
    expect(runtimeService.launchLocal).not.toHaveBeenCalled();
  });

  it("sendCommand sends JSON-RPC requests over IPC", () => {
    const handle = provider.start({
      runtimeTarget: makeRuntimeTarget(),
      runConfig: makeRunConfig(),
    });
    childMock.send.mockClear();

    provider.sendCommand(handle, { type: "interrupt", commandId: "cmd-1" });

    expect(childMock.send).toHaveBeenCalledWith(
      expect.objectContaining({
        jsonrpc: "2.0",
        id: "cmd-1",
        method: "run.interrupt",
        params: { runId: "run-1" },
        meta: expect.objectContaining({ runId: "run-1", seq: 1 }),
      })
    );
  });

  it("normalizes worker RPC notifications and responses before forwarding", () => {
    const sendEvent = vi.fn().mockResolvedValue(undefined);
    provider.setRunEventPort({
      sendEvent,
      notifyWorkerError: vi.fn().mockResolvedValue(undefined),
      notifyCancelledBeforeReady: vi.fn().mockResolvedValue(undefined),
      recordCommandSent: vi.fn().mockResolvedValue(undefined),
    });
    provider.start({
      runtimeTarget: makeRuntimeTarget(),
      runConfig: makeRunConfig(),
    });
    const messageHandler = childMock.on.mock.calls.find(
      ([event]) => event === "message"
    )?.[1] as ((message: unknown) => void) | undefined;
    expect(messageHandler).toBeTypeOf("function");

    messageHandler?.({
      jsonrpc: "2.0",
      method: "run.status",
      params: { runId: "run-1", status: { status: "running" } },
      meta: { runId: "run-1", seq: 1, ts: "2026-06-27T00:00:00.000Z" },
    });
    messageHandler?.({
      jsonrpc: "2.0",
      id: "cmd-1",
      result: { ok: true, commandType: "cancel" },
      meta: { runId: "run-1", seq: 2, ts: "2026-06-27T00:00:01.000Z" },
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
        payload: { commandId: "cmd-1", commandType: "cancel", status: "ok" },
      })
    );
  });

  it("terminateExecution sends SIGTERM to the local worker and clears state", () => {
    const handle = provider.start({
      runtimeTarget: makeRuntimeTarget(),
      runConfig: makeRunConfig(),
    });

    provider.terminateExecution("run-1", "run timeout");

    expect(childMock.kill).toHaveBeenCalledWith("SIGTERM");
    provider.sendCommand(handle, { type: "interrupt", commandId: "command-1" });
    expect(childMock.send).toHaveBeenCalledTimes(1);
  });

  it("onApplicationShutdown terminates all in-flight local workers", () => {
    provider.start({
      runtimeTarget: makeRuntimeTarget(),
      runConfig: makeRunConfig(),
    });

    provider.onApplicationShutdown();

    expect(childMock.kill).toHaveBeenCalledWith("SIGTERM");
    provider.sendCommand(
      {
        runId: "run-1",
        runtimeType: "local",
        runtimeInstanceId: "1:token",
        conversationId: "conversation-1",
      },
      { type: "interrupt", commandId: "command-1" }
    );
    expect(childMock.send).toHaveBeenCalledTimes(1); // only the run.config send
  });

  describe("cleanupInterruptedExecution()", () => {
    it("delegates to RuntimeService.recoverOrphanLocal", async () => {
      await provider.cleanupInterruptedExecution("12345:some-token");
      expect(runtimeService.recoverOrphanLocal).toHaveBeenCalledWith(
        "12345:some-token"
      );
    });
  });
});
