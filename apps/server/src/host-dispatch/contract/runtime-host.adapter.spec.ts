import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  HostUpstreamNotification,
  RunPlacement,
  SubmitRunInput,
} from "@agework/shared/protocol";
import type { RuntimeHost } from "@agework/runtime/host";
import { RuntimeHostAdapter } from "./runtime-host.adapter";
import type { RuntimeHostService } from "../../runtime-host/runtime-host.service";
import type { ConfigService } from "../../config/config.service";
import type { RunEventService } from "../../run-event/run-event.service";

function makeBuiltinHost() {
  return {
    setUpstream: vi.fn(),
    submitRun: vi.fn().mockResolvedValue(undefined),
    command: vi.fn().mockResolvedValue(undefined),
    releaseRun: vi.fn(),
    releaseOwner: vi.fn().mockResolvedValue(undefined),
    listWorkers: vi.fn().mockResolvedValue([]),
    stopWorker: vi.fn().mockResolvedValue(undefined),
  };
}

function makeRuntimeService() {
  return {
    sendTunnelRequest: vi.fn().mockResolvedValue(null),
    sendTunnelNotification: vi.fn(),
    listConnectedRuntimeHostIds: vi.fn().mockReturnValue([]),
    setHostUpstreamPort: vi.fn(),
    getRuntimeHostRow: vi.fn().mockResolvedValue(null),
  };
}

function makeConfigService() {
  return {
    getLaunchTimeoutSeconds: vi.fn().mockReturnValue(60),
  };
}

function makeRunEvents() {
  return {
    append: vi.fn().mockResolvedValue(undefined),
    commandSent: vi.fn().mockImplementation((input: unknown) => input),
  };
}

function makeUpstream() {
  return {
    emit: vi.fn().mockResolvedValue(undefined),
    notifyRunFailed: vi.fn().mockResolvedValue(undefined),
    notifyRunCancelled: vi.fn().mockResolvedValue(undefined),
    notifyWorkerLost: vi.fn().mockResolvedValue(undefined),
  };
}

function makePlacement(
  runtimeHostId: string,
  overrides: Partial<RunPlacement> = {}
): RunPlacement {
  return {
    owner: "workspace:ws-1",
    runtimeType: "native",
    runtimeHostId,
    workspaceId: "ws-1",
    userId: "user-1",
    username: "admin-1",
    workspacePath: "/tmp/ws-1",
    ...overrides,
  };
}

function makeSubmitInput(runtimeHostId: string): SubmitRunInput {
  return {
    runId: "run-1",
    conversationId: "conversation-1",
    placement: makePlacement(runtimeHostId),
    agentProviderConfig: { agentType: "claude", source: "system" },
    input: { messages: [{ id: "msg-1" }] },
  };
}

describe("RuntimeHostAdapter (Phase 2 路由)", () => {
  let builtinHost: ReturnType<typeof makeBuiltinHost>;
  let runtimeService: ReturnType<typeof makeRuntimeService>;
  let runEvents: ReturnType<typeof makeRunEvents>;
  let upstream: ReturnType<typeof makeUpstream>;
  let adapter: RuntimeHostAdapter;

  beforeEach(() => {
    builtinHost = makeBuiltinHost();
    runtimeService = makeRuntimeService();
    runEvents = makeRunEvents();
    adapter = new RuntimeHostAdapter(
      runtimeService as unknown as RuntimeHostService,
      makeConfigService() as unknown as ConfigService,
      runEvents as unknown as RunEventService,
      builtinHost as unknown as RuntimeHost
    );
    upstream = makeUpstream();
    adapter.setUpstream(upstream);
  });

  function tunnelUpstreamHandler(): (
    runtimeHostId: string,
    notification: HostUpstreamNotification
  ) => Promise<void> {
    const port = runtimeService.setHostUpstreamPort.mock.calls[0][0] as {
      onHostUpstream: (
        runtimeHostId: string,
        notification: HostUpstreamNotification
      ) => Promise<void>;
    };
    return (runtimeHostId, notification) =>
      port.onHostUpstream(runtimeHostId, notification);
  }

  it("setUpstream wires the in-process host and the host upstream port", () => {
    expect(builtinHost.setUpstream).toHaveBeenCalledWith(upstream);
    expect(runtimeService.setHostUpstreamPort).toHaveBeenCalledTimes(1);
  });

  describe("submitRun", () => {
    it("routes builtin to the in-process host", async () => {
      await adapter.submitRun(makeSubmitInput("builtin"));

      expect(builtinHost.submitRun).toHaveBeenCalledTimes(1);
      expect(runtimeService.sendTunnelRequest).not.toHaveBeenCalled();
    });

    it("routes everything else (registered) through the tunnel", async () => {
      await adapter.submitRun(makeSubmitInput("rt-registered-1"));

      expect(builtinHost.submitRun).not.toHaveBeenCalled();
      expect(runtimeService.sendTunnelRequest).toHaveBeenCalledTimes(1);
      const [runtimeHostId, request] = runtimeService.sendTunnelRequest.mock
        .calls[0] as [string, { method: string }];
      expect(runtimeHostId).toBe("rt-registered-1");
      expect(request.method).toBe("host.submitRun");
    });

    it("delegates runId idempotency to the target Host", async () => {
      await adapter.submitRun(makeSubmitInput("builtin"));
      await adapter.submitRun(makeSubmitInput("builtin"));

      expect(builtinHost.submitRun).toHaveBeenCalledTimes(2);
    });

    it("propagates in-process submit failures and clears the state", async () => {
      builtinHost.submitRun.mockRejectedValue(new Error("bad spec"));

      await expect(
        adapter.submitRun(makeSubmitInput("builtin"))
      ).rejects.toThrow("bad spec");

      // state 已清:重试同 runId 会再次提交而不是被幂等吸收
      builtinHost.submitRun.mockResolvedValue(undefined);
      await adapter.submitRun(makeSubmitInput("builtin"));
      expect(builtinHost.submitRun).toHaveBeenCalledTimes(2);
    });

    it("reports tunnel submit failures upstream instead of throwing", async () => {
      runtimeService.sendTunnelRequest.mockRejectedValue(
        new Error("host offline")
      );

      await adapter.submitRun(makeSubmitInput("rt-registered-1"));

      expect(upstream.notifyRunFailed).toHaveBeenCalledWith(
        "run-1",
        expect.stringContaining("host offline")
      );
    });
  });

  describe("command", () => {
    const cancel = {
      type: "cancel",
      commandId: "cmd-1",
      runId: "run-1",
      conversationId: "conversation-1",
    } as const;

    it("routes builtin commands to the in-process host", async () => {
      await adapter.command({ runtimeHostId: "builtin", payload: cancel });

      expect(builtinHost.command).toHaveBeenCalledWith({
        runtimeHostId: "builtin",
        payload: cancel,
      });
    });

    it("routes tunnel commands via host.command and records the audit event", async () => {
      await adapter.command({
        runtimeHostId: "rt-registered-1",
        payload: cancel,
      });

      const call = runtimeService.sendTunnelRequest.mock.calls.find(
        ([, request]) =>
          (request as { method: string }).method === "host.command"
      );
      expect(call?.[0]).toBe("rt-registered-1");
      expect(runEvents.commandSent).toHaveBeenCalledWith({
        runId: "run-1",
        commandId: "cmd-1",
        commandType: "cancel",
      });
    });

    it("routes commands without requiring submit state in the server process", async () => {
      await adapter.command({
        runtimeHostId: "rt-registered-1",
        payload: { ...cancel, runId: "run-x" },
      });

      expect(runtimeService.sendTunnelRequest).toHaveBeenCalledWith(
        "rt-registered-1",
        expect.objectContaining({ method: "host.command" }),
        expect.any(Number)
      );
    });
  });

  describe("releaseRun", () => {
    it("releases builtin runs on the in-process host", async () => {
      adapter.releaseRun({ runtimeHostId: "builtin", runId: "run-1" });

      expect(builtinHost.releaseRun).toHaveBeenCalledWith({
        runtimeHostId: "builtin",
        runId: "run-1",
      });
      expect(runtimeService.sendTunnelNotification).not.toHaveBeenCalled();
    });

    it("notifies the tunnel host to clean up its run state", async () => {
      adapter.releaseRun({
        runtimeHostId: "rt-registered-1",
        runId: "run-1",
      });

      expect(runtimeService.sendTunnelNotification).toHaveBeenCalledWith(
        "rt-registered-1",
        expect.objectContaining({
          method: "host.releaseRun",
          params: { runtimeHostId: "rt-registered-1", runId: "run-1" },
        })
      );
    });
  });

  describe("tunnel upstream 回流", () => {
    it("forwards notifications to the upstream and awaits processing", async () => {
      const handler = tunnelUpstreamHandler();

      await handler("rt-registered-1", {
        kind: "emit",
        runId: "run-9",
        message: {
          runId: "run-9",
          seq: 1,
          type: "agui.event",
          payload: {},
          ts: "t",
        },
      });
      await handler("rt-registered-1", {
        kind: "runFailed",
        runId: "run-9",
        error: "boom",
      });

      expect(upstream.emit).toHaveBeenCalledTimes(1);
      expect(upstream.notifyRunFailed).toHaveBeenCalledWith("run-9", "boom");
      expect(runtimeService.sendTunnelNotification).toHaveBeenCalledWith(
        "rt-registered-1",
        expect.objectContaining({
          method: "host.releaseRun",
          params: {
            runtimeHostId: "rt-registered-1",
            runId: "run-9",
          },
        })
      );
    });

    it("routes post-restart commands from their explicit runtimeHostId", async () => {
      const handler = tunnelUpstreamHandler();
      await handler("rt-registered-1", {
        kind: "emit",
        runId: "run-9",
        message: {
          runId: "run-9",
          seq: 1,
          type: "agui.event",
          payload: {},
          ts: "t",
        },
      });

      await adapter.command({
        runtimeHostId: "rt-registered-1",
        payload: {
          type: "cancel",
          commandId: "cmd-9",
          runId: "run-9",
          conversationId: "conversation-1",
        },
      });

      const call = runtimeService.sendTunnelRequest.mock.calls.find(
        ([, request]) =>
          (request as { method: string }).method === "host.command"
      );
      expect(call?.[0]).toBe("rt-registered-1");
    });
  });

  describe("观测与 owner 级动作", () => {
    it("listWorkers merges hosts and stamps each snapshot with its runtimeHostId", async () => {
      builtinHost.listWorkers.mockResolvedValue([
        { workerId: "w-local", runtimeHostId: "" },
      ]);
      runtimeService.listConnectedRuntimeHostIds.mockReturnValue([
        "rt-registered-1",
      ]);
      runtimeService.sendTunnelRequest.mockResolvedValue({
        workers: [{ workerId: "w-remote", runtimeHostId: "" }],
      });

      const workers = await adapter.listWorkers();

      expect(workers.map((w) => [w.workerId, w.runtimeHostId])).toEqual([
        ["w-local", "builtin"],
        ["w-remote", "rt-registered-1"],
      ]);
    });

    it("listWorkers tolerates an unreachable tunnel host", async () => {
      builtinHost.listWorkers.mockResolvedValue([{ workerId: "w-local" }]);
      runtimeService.listConnectedRuntimeHostIds.mockReturnValue(["rt-dead"]);
      runtimeService.sendTunnelRequest.mockRejectedValue(new Error("timeout"));

      await expect(adapter.listWorkers()).resolves.toEqual([
        { workerId: "w-local", runtimeHostId: "builtin" },
      ]);
    });

    it("stopWorker routes builtin to the in-process host without touching the tunnel", async () => {
      await adapter.stopWorker({
        runtimeHostId: "builtin",
        key: "workspace:ws-1#native",
      });

      expect(builtinHost.stopWorker).toHaveBeenCalledWith({
        runtimeHostId: "builtin",
        key: "workspace:ws-1#native",
      });
      expect(runtimeService.sendTunnelRequest).not.toHaveBeenCalled();
    });

    it("stopWorker routes registered hosts through their own tunnel only", async () => {
      await adapter.stopWorker({
        runtimeHostId: "rt-registered-1",
        key: "workspace:ws-1#native",
      });

      expect(builtinHost.stopWorker).not.toHaveBeenCalled();
      expect(runtimeService.sendTunnelRequest).toHaveBeenCalledTimes(1);
      const [runtimeHostId, request] = runtimeService.sendTunnelRequest.mock
        .calls[0] as [string, { method: string; params: unknown }];
      expect(runtimeHostId).toBe("rt-registered-1");
      expect(request.method).toBe("host.stopWorker");
      expect(request.params).toEqual({
        runtimeHostId: "rt-registered-1",
        key: "workspace:ws-1#native",
      });
    });

    it("releaseOwner routes builtin to the in-process host without touching the tunnel", async () => {
      await adapter.releaseOwner({
        runtimeHostId: "builtin",
        owner: "workspace:ws-1",
      });

      expect(builtinHost.releaseOwner).toHaveBeenCalledWith({
        runtimeHostId: "builtin",
        owner: "workspace:ws-1",
      });
      expect(runtimeService.sendTunnelRequest).not.toHaveBeenCalled();
    });

    it("releaseOwner routes registered hosts through their own tunnel only", async () => {
      await adapter.releaseOwner({
        runtimeHostId: "rt-registered-1",
        owner: "workspace:ws-1",
      });

      expect(builtinHost.releaseOwner).not.toHaveBeenCalled();
      expect(runtimeService.sendTunnelRequest).toHaveBeenCalledTimes(1);
      const [runtimeHostId, request] = runtimeService.sendTunnelRequest.mock
        .calls[0] as [string, { method: string; params: unknown }];
      expect(runtimeHostId).toBe("rt-registered-1");
      expect(request.method).toBe("host.releaseOwner");
      expect(request.params).toEqual({
        runtimeHostId: "rt-registered-1",
        owner: "workspace:ws-1",
      });
    });
  });

  describe("detectEnv", () => {
    it("returns the Runtime Host capability matrix", async () => {
      runtimeService.getRuntimeHostRow.mockResolvedValue({
        source: "registered",
        capabilities: {
          docker: { available: true, scopes: ["user", "workspace"] },
        },
        envConfig: null,
      });

      const status = await adapter.detectEnv("builtin");

      expect(status).toEqual({
        docker: { available: true, scopes: ["user", "workspace"] },
      });
    });

    it("throws when the runtime host row is missing", async () => {
      runtimeService.getRuntimeHostRow.mockResolvedValue(null);

      await expect(adapter.detectEnv("missing")).rejects.toThrow(/not found/);
    });
  });
});
