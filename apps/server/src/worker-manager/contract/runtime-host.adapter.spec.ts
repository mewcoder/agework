import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  RunPlacement,
  RuntimeSpec,
  SubmitRunInput,
} from "@agework/shared/protocol";
import { RuntimeHostAdapter } from "./runtime-host.adapter";
import type { WorkerManagerService } from "../worker-manager.service";
import type { RuntimeService } from "../../runtime/runtime.service";
import type { ConfigService } from "../../config/config.service";
import type { RunEventService } from "../../run-event/run-event.service";
import type { RuntimeTunnelHandler } from "../../runtime/gateway/runtime-tunnel.handler";

const RUNTIME_LOG_DIR = "/tmp/agework-logs/runtime";

function makeTunnelHandler() {
  return {
    sendRequest: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    setUpstreamHandler: vi.fn(),
  };
}

function makeWorkerManager() {
  return {
    resolveInstance: vi.fn(),
    releaseInstanceForRun: vi.fn(),
    openSession: vi.fn(),
    sendCommand: vi.fn(),
    cleanupRun: vi.fn(),
    setUpstreamPort: vi.fn(),
    findRuntimeByRuntimeId: vi.fn().mockResolvedValue(null),
    getWorkerInstanceForAdmin: vi.fn().mockResolvedValue(null),
  };
}

function makeRuntimeService(runtimeType: "native" | "docker") {
  return {
    resolveRuntimeSpec: vi.fn().mockReturnValue(makeSpec(runtimeType)),
    getResolvedCliPaths: vi.fn().mockResolvedValue({
      claude: "/usr/local/bin/claude",
      codex: null,
      opencode: null,
    }),
  };
}

function makeConfigService() {
  return {
    getUserWorkspace: vi.fn().mockReturnValue("/root-user"),
    getRuntimeLogDir: vi.fn().mockReturnValue(RUNTIME_LOG_DIR),
    getAgentEventTraceConfig: vi
      .fn()
      .mockReturnValue({ enabled: true, maxFileMb: 5 }),
  };
}

function makeRunEvents() {
  return {
    append: vi.fn().mockResolvedValue(undefined),
    commandSent: vi.fn((input: Record<string, unknown>) => ({
      runId: input.runId,
      type: "command.sent",
      data: input,
    })),
  };
}

function makeUpstream() {
  return {
    emit: vi.fn().mockResolvedValue(undefined),
    notifyRunFailed: vi.fn().mockResolvedValue(undefined),
    notifyRunCancelled: vi.fn().mockResolvedValue(undefined),
    notifyWorkerLost: vi.fn().mockResolvedValue(undefined),
    notifyExecutionRef: vi.fn(),
  };
}

function makeSpec(runtimeType: "native" | "docker"): RuntimeSpec {
  return {
    runtimeType,
    ownerId: "ws-1",
    userId: "user-1",
    workspaceId: "ws-1",
    hostPath: "/tmp/ws-1",
    runtimePath: runtimeType === "native" ? "/tmp/ws-1" : "/workspace",
    runtimeLogDir:
      runtimeType === "native" ? RUNTIME_LOG_DIR : "/workspace-logs",
    ...(runtimeType === "docker"
      ? {
          sandbox: {
            isolationScope: "workspace" as const,
            mountTarget: "/workspace",
          },
        }
      : {}),
  } as RuntimeSpec;
}

function makePlacement(
  isolation: "native" | "docker",
  overrides: Partial<RunPlacement> = {}
): RunPlacement {
  return {
    owner: "workspace:ws-1",
    scope: "workspace",
    isolation,
    runtimeHostId: "managed-native",
    workspaceId: "ws-1",
    userId: "user-1",
    username: "admin-1",
    workspacePath: "/tmp/ws-1",
    ...overrides,
  };
}

function makeSubmitInput(
  isolation: "native" | "docker",
  overrides: Partial<SubmitRunInput> = {}
): SubmitRunInput {
  return {
    runId: "run-1",
    conversationId: "conversation-1",
    placement: makePlacement(isolation),
    agentProviderConfig: { agentType: "claude", source: "system" },
    input: { messages: [{ id: "msg-1" }] },
    ...overrides,
  };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe.each(["native", "docker"] as const)(
  "RuntimeHostAdapter (%s)",
  (isolation) => {
    let workerManager: ReturnType<typeof makeWorkerManager>;
    let runtimeService: ReturnType<typeof makeRuntimeService>;
    let runEvents: ReturnType<typeof makeRunEvents>;
    let upstream: ReturnType<typeof makeUpstream>;
    let adapter: RuntimeHostAdapter;

    beforeEach(() => {
      workerManager = makeWorkerManager();
      runtimeService = makeRuntimeService(isolation);
      runEvents = makeRunEvents();
      adapter = new RuntimeHostAdapter(
        workerManager as unknown as WorkerManagerService,
        runtimeService as unknown as RuntimeService,
        makeTunnelHandler() as unknown as RuntimeTunnelHandler,
        makeConfigService() as unknown as ConfigService,
        runEvents as unknown as RunEventService
      );
      upstream = makeUpstream();
      adapter.setUpstream(upstream);
    });

    it("wires the worker upstream port through to upstream.emit", async () => {
      expect(workerManager.setUpstreamPort).toHaveBeenCalledTimes(1);
      const port = workerManager.setUpstreamPort.mock.calls[0][0] as {
        sendEvent: (runId: string, message: unknown) => Promise<void>;
      };
      await port.sendEvent("run-1", { seq: 1 });
      expect(upstream.emit).toHaveBeenCalledWith("run-1", { seq: 1 });
    });

    it("derives the spec, assembles the RunConfig and starts the run once ready", async () => {
      workerManager.resolveInstance.mockResolvedValue({
        outcome: "ready",
        workerId: "worker-1",
        runtimeInstanceId: "instance-1",
      });

      await adapter.submitRun(makeSubmitInput(isolation));
      await settle();

      expect(runtimeService.resolveRuntimeSpec).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: "ws-1",
          workspaceRootPath: "/tmp/ws-1",
          userWorkspaceRootPath: "/root-user",
          runtimeType: isolation,
          ...(isolation === "docker" ? { isolationScope: "workspace" } : {}),
        })
      );
      const startInput = workerManager.resolveInstance.mock.calls[0][0] as {
        runConfig: Record<string, unknown>;
        targetRuntimeId: string;
      };
      expect(startInput.targetRuntimeId).toBe("managed-native");
      expect(startInput.runConfig).toEqual(
        expect.objectContaining({
          runId: "run-1",
          conversationId: "conversation-1",
          workspaceId: "ws-1",
          runtimePath: isolation === "native" ? "/tmp/ws-1" : "/workspace",
          input: { messages: [{ id: "msg-1" }] },
          agentProviderConfig: expect.objectContaining({
            agentType: "claude",
          }),
        })
      );
      if (isolation === "native") {
        // CLI 路径由 Host 侧合成（override > detected）
        expect(runtimeService.getResolvedCliPaths).toHaveBeenCalledWith(
          "managed-native"
        );
        expect(startInput.runConfig.claudeExecutablePath).toBe(
          "/usr/local/bin/claude"
        );
      } else {
        expect(runtimeService.getResolvedCliPaths).not.toHaveBeenCalled();
        // 运行时侧日志路径基于 spec.runtimeLogDir（容器挂载点）
        expect(startInput.runConfig.workerLogFilePath).toBe(
          "/workspace-logs/conversation-1.worker.log"
        );
      }

      expect(upstream.notifyExecutionRef).toHaveBeenCalledWith("run-1", {
        runtimeType: isolation,
        runtimeInstanceId: "instance-1",
      });
      expect(workerManager.openSession).toHaveBeenCalledWith(
        expect.objectContaining({ runId: "run-1", workerId: "worker-1" })
      );
      expect(workerManager.sendCommand).toHaveBeenCalledWith(
        "worker-1",
        "run-1",
        expect.objectContaining({ type: "user_message" })
      );
      expect(runEvents.commandSent).toHaveBeenCalledWith(
        expect.objectContaining({ runId: "run-1", commandType: "user_message" })
      );
    });

    it("is idempotent for a duplicate runId", async () => {
      workerManager.resolveInstance.mockResolvedValue(
        new Promise(() => {
          /* never resolves */
        })
      );
      await adapter.submitRun(makeSubmitInput(isolation));
      await adapter.submitRun(makeSubmitInput(isolation));

      expect(workerManager.resolveInstance).toHaveBeenCalledTimes(1);
    });

    it("notifies run failure when resolveInstance settles as error", async () => {
      workerManager.resolveInstance.mockResolvedValue({
        outcome: "error",
        error: "boom",
      });

      await adapter.submitRun(makeSubmitInput(isolation));
      await settle();

      expect(upstream.notifyRunFailed).toHaveBeenCalledWith("run-1", "boom");
      expect(workerManager.openSession).not.toHaveBeenCalled();
    });

    it("absorbs a cancel arriving before ready and reports cancelled instead of opening a session", async () => {
      let resolveAcquire!: (value: unknown) => void;
      workerManager.resolveInstance.mockReturnValue(
        new Promise((resolve) => {
          resolveAcquire = resolve;
        })
      );

      await adapter.submitRun(makeSubmitInput(isolation));
      await adapter.command("run-1", {
        type: "cancel",
        commandId: "cmd-1",
        runId: "run-1",
        conversationId: "conversation-1",
      });
      expect(workerManager.releaseInstanceForRun).toHaveBeenCalledWith("run-1");

      resolveAcquire({
        outcome: "ready",
        workerId: "worker-1",
        runtimeInstanceId: "instance-1",
      });
      await settle();

      expect(upstream.notifyRunCancelled).toHaveBeenCalledWith("run-1");
      expect(workerManager.openSession).not.toHaveBeenCalled();
      expect(workerManager.sendCommand).not.toHaveBeenCalled();
    });

    it("dispatches commands to the resolved worker once ready", async () => {
      workerManager.resolveInstance.mockResolvedValue({
        outcome: "ready",
        workerId: "worker-1",
        runtimeInstanceId: "instance-1",
      });
      await adapter.submitRun(makeSubmitInput(isolation));
      await settle();

      await adapter.command("run-1", {
        type: "cancel",
        commandId: "cmd-2",
        runId: "run-1",
        conversationId: "conversation-1",
      });

      expect(workerManager.sendCommand).toHaveBeenCalledWith(
        "worker-1",
        "run-1",
        expect.objectContaining({ type: "cancel" })
      );
    });

    it("drops commands for unknown runs", async () => {
      await adapter.command("run-x", {
        type: "cancel",
        commandId: "cmd-3",
        runId: "run-x",
        conversationId: "conversation-1",
      });
      expect(workerManager.sendCommand).not.toHaveBeenCalled();
    });

    it("releases queue state and fence index on releaseRun", () => {
      adapter.releaseRun("run-1");
      expect(workerManager.cleanupRun).toHaveBeenCalledWith("run-1");
      expect(workerManager.releaseInstanceForRun).toHaveBeenCalledWith("run-1");
    });

    it("forwards worker lost facts to the upstream", async () => {
      await adapter.onWorkerLost({ runId: "run-1", reason: "timeout" });
      expect(upstream.notifyWorkerLost).toHaveBeenCalledWith(
        "run-1",
        "timeout"
      );
    });
  }
);

describe("RuntimeHostAdapter.sendRecoveryCancel", () => {
  function makeAdapter(workerManager: ReturnType<typeof makeWorkerManager>) {
    return new RuntimeHostAdapter(
      workerManager as unknown as WorkerManagerService,
      makeRuntimeService("docker") as unknown as RuntimeService,
      makeTunnelHandler() as unknown as RuntimeTunnelHandler,
      makeConfigService() as unknown as ConfigService,
      makeRunEvents() as unknown as RunEventService
    );
  }

  it("skips native refs entirely (worker died with the server)", async () => {
    const workerManager = makeWorkerManager();
    const adapter = makeAdapter(workerManager);

    await adapter.sendRecoveryCancel({
      runId: "run-1",
      conversationId: "conversation-1",
      ref: { runtimeType: "native", runtimeInstanceId: "4242:token" },
    });

    expect(workerManager.findRuntimeByRuntimeId).not.toHaveBeenCalled();
    expect(workerManager.sendCommand).not.toHaveBeenCalled();
  });

  it("skips when no registry row is found for the instance", async () => {
    const workerManager = makeWorkerManager();
    const adapter = makeAdapter(workerManager);

    await adapter.sendRecoveryCancel({
      runId: "run-1",
      conversationId: "conversation-1",
      ref: { runtimeType: "docker", runtimeInstanceId: "container-xyz" },
    });

    expect(workerManager.findRuntimeByRuntimeId).toHaveBeenCalledWith(
      "docker",
      "container-xyz"
    );
    expect(workerManager.sendCommand).not.toHaveBeenCalled();
  });

  it("sends a cancel to the still-alive worker", async () => {
    const workerManager = makeWorkerManager();
    workerManager.findRuntimeByRuntimeId.mockResolvedValue({
      ownerId: "ws-1",
    });
    const adapter = makeAdapter(workerManager);

    await adapter.sendRecoveryCancel({
      runId: "run-1",
      conversationId: "conversation-1",
      ref: { runtimeType: "docker", runtimeInstanceId: "container-abc" },
    });

    expect(workerManager.sendCommand).toHaveBeenCalledWith(
      "ws-1",
      "run-1",
      expect.objectContaining({
        type: "cancel",
        runId: "run-1",
        conversationId: "conversation-1",
      })
    );
  });
});
