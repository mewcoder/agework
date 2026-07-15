import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  HostUpstreamNotification,
  RunPlacement,
  SubmitRunInput,
} from "@agework/shared/protocol";
import type { RuntimeHost } from "@agework/runtime/host";
import { RuntimeHostAdapter } from "./runtime-host.adapter";
import type { ConfigService } from "../../config/config.service";
import type { RunEventService } from "../../run-event/run-event.service";
import type { HostTunnelHandler } from "../gateway/host-tunnel.handler";

function makeBuiltinHost() {
  return {
    setUpstream: vi.fn(),
    submitRun: vi.fn().mockResolvedValue(undefined),
    command: vi.fn().mockResolvedValue(undefined),
    releaseRun: vi.fn(),
    releaseOwner: vi.fn().mockResolvedValue(undefined),
    detectEnv: vi.fn().mockResolvedValue({
      native: { available: true, scopes: ["workspace"] },
    }),
    installCli: vi.fn().mockResolvedValue({ executablePath: "/cli/claude" }),
    listDirectory: vi.fn().mockResolvedValue({ path: "/tmp", entries: [] }),
    createDirectory: vi.fn().mockResolvedValue(undefined),
    listFiles: vi
      .fn()
      .mockResolvedValue({ path: "", list: [], truncated: false }),
    readFile: vi.fn(),
    readFileDiff: vi.fn(),
    searchFiles: vi.fn().mockResolvedValue({ list: [], truncated: false }),
    listChangedFiles: vi.fn().mockResolvedValue({ list: [], truncated: false }),
    listWorkers: vi.fn().mockResolvedValue([]),
    stopWorker: vi.fn().mockResolvedValue(undefined),
  };
}

function makeTunnelHandler() {
  return {
    sendRequest: vi.fn().mockResolvedValue(null),
    sendNotification: vi.fn(),
    listConnected: vi.fn().mockReturnValue([]),
    isConnected: vi.fn().mockReturnValue(false),
    setHostUpstreamPort: vi.fn(),
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
  let tunnelHandler: ReturnType<typeof makeTunnelHandler>;
  let runEvents: ReturnType<typeof makeRunEvents>;
  let upstream: ReturnType<typeof makeUpstream>;
  let adapter: RuntimeHostAdapter;

  beforeEach(() => {
    builtinHost = makeBuiltinHost();
    tunnelHandler = makeTunnelHandler();
    runEvents = makeRunEvents();
    adapter = new RuntimeHostAdapter(
      tunnelHandler as unknown as HostTunnelHandler,
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
    const port = tunnelHandler.setHostUpstreamPort.mock.calls[0][0] as {
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
    expect(tunnelHandler.setHostUpstreamPort).toHaveBeenCalledTimes(1);
  });

  it("reports builtin as connected and delegates registered connectivity", () => {
    expect(adapter.isConnected("builtin")).toBe(true);
    expect(tunnelHandler.isConnected).not.toHaveBeenCalled();

    tunnelHandler.isConnected.mockReturnValue(true);
    expect(adapter.isConnected("rt-registered-1")).toBe(true);
    expect(tunnelHandler.isConnected).toHaveBeenCalledWith("rt-registered-1");
  });

  describe("submitRun", () => {
    it("routes builtin to the in-process host", async () => {
      await adapter.submitRun(makeSubmitInput("builtin"));

      expect(builtinHost.submitRun).toHaveBeenCalledTimes(1);
      expect(tunnelHandler.sendRequest).not.toHaveBeenCalled();
    });

    it("routes everything else (registered) through the tunnel", async () => {
      await adapter.submitRun(makeSubmitInput("rt-registered-1"));

      expect(builtinHost.submitRun).not.toHaveBeenCalled();
      expect(tunnelHandler.sendRequest).toHaveBeenCalledTimes(1);
      const [runtimeHostId, request] = tunnelHandler.sendRequest.mock
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
      tunnelHandler.sendRequest.mockRejectedValue(new Error("host offline"));

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

      const call = tunnelHandler.sendRequest.mock.calls.find(
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

      expect(tunnelHandler.sendRequest).toHaveBeenCalledWith(
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
      expect(tunnelHandler.sendNotification).not.toHaveBeenCalled();
    });

    it("notifies the tunnel host to clean up its run state", async () => {
      adapter.releaseRun({
        runtimeHostId: "rt-registered-1",
        runId: "run-1",
      });

      expect(tunnelHandler.sendNotification).toHaveBeenCalledWith(
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
      expect(tunnelHandler.sendNotification).toHaveBeenCalledWith(
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

      const call = tunnelHandler.sendRequest.mock.calls.find(
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
      tunnelHandler.listConnected.mockReturnValue(["rt-registered-1"]);
      tunnelHandler.sendRequest.mockResolvedValue({
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
      tunnelHandler.listConnected.mockReturnValue(["rt-dead"]);
      tunnelHandler.sendRequest.mockRejectedValue(new Error("timeout"));

      await expect(adapter.listWorkers()).resolves.toEqual([
        { workerId: "w-local", runtimeHostId: "builtin" },
      ]);
    });

    it("listOwners exposes deduplicated Host + OwnerKey refs instead of worker snapshots", async () => {
      builtinHost.listWorkers.mockResolvedValue([
        { scope: "workspace", ownerId: "ws-1" },
        { scope: "workspace", ownerId: "ws-1" },
      ]);
      tunnelHandler.listConnected.mockReturnValue(["rt-registered-1"]);
      tunnelHandler.sendRequest.mockResolvedValue({
        workers: [{ scope: "user", ownerId: "user-1" }],
      });

      await expect(adapter.listOwners()).resolves.toEqual([
        { runtimeHostId: "builtin", owner: "workspace:ws-1" },
        { runtimeHostId: "rt-registered-1", owner: "user:user-1" },
      ]);
    });

    it("listOwners can query one registered Host without scanning the others", async () => {
      tunnelHandler.listConnected.mockReturnValue(["rt-other"]);
      tunnelHandler.sendRequest.mockResolvedValue({
        workers: [{ scope: "user", ownerId: "user-1" }],
      });

      await expect(adapter.listOwners("rt-1")).resolves.toEqual([
        { runtimeHostId: "rt-1", owner: "user:user-1" },
      ]);
      expect(builtinHost.listWorkers).not.toHaveBeenCalled();
      expect(tunnelHandler.sendRequest).toHaveBeenCalledWith(
        "rt-1",
        expect.objectContaining({ method: "host.listWorkers" }),
        expect.any(Number)
      );
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
      expect(tunnelHandler.sendRequest).not.toHaveBeenCalled();
    });

    it("stopWorker routes registered hosts through their own tunnel only", async () => {
      await adapter.stopWorker({
        runtimeHostId: "rt-registered-1",
        key: "workspace:ws-1#native",
      });

      expect(builtinHost.stopWorker).not.toHaveBeenCalled();
      expect(tunnelHandler.sendRequest).toHaveBeenCalledTimes(1);
      const [runtimeHostId, request] = tunnelHandler.sendRequest.mock
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
      expect(tunnelHandler.sendRequest).not.toHaveBeenCalled();
    });

    it("releaseOwner routes registered hosts through their own tunnel only", async () => {
      await adapter.releaseOwner({
        runtimeHostId: "rt-registered-1",
        owner: "workspace:ws-1",
      });

      expect(builtinHost.releaseOwner).not.toHaveBeenCalled();
      expect(tunnelHandler.sendRequest).toHaveBeenCalledTimes(1);
      const [runtimeHostId, request] = tunnelHandler.sendRequest.mock
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
    it("delegates builtin detection to the in-process Host", async () => {
      builtinHost.detectEnv.mockResolvedValue({
        docker: { available: true, scopes: ["user", "workspace"] },
      });

      const status = await adapter.detectEnv("builtin");

      expect(status).toEqual({
        docker: { available: true, scopes: ["user", "workspace"] },
      });
      expect(builtinHost.detectEnv).toHaveBeenCalledWith("builtin");
      expect(tunnelHandler.sendRequest).not.toHaveBeenCalled();
    });

    it("delegates registered detection through the tunnel", async () => {
      tunnelHandler.sendRequest.mockResolvedValue({
        docker: {
          available: true,
          scopes: ["user", "workspace"],
        },
      });

      const status = await adapter.detectEnv("rt-1");

      expect(status).toEqual({
        docker: {
          available: true,
          scopes: ["user", "workspace"],
        },
      });
      expect(tunnelHandler.sendRequest).toHaveBeenCalledWith(
        "rt-1",
        expect.objectContaining({ method: "host.detectEnv" }),
        expect.any(Number)
      );
    });
  });

  describe("workspace data operations", () => {
    it("routes builtin file reads to the in-process Host", async () => {
      builtinHost.readFile.mockResolvedValue({
        path: "a.ts",
        encoding: "utf8",
        content: "local",
        size: 5,
        truncated: false,
      });

      await adapter.readFile({
        runtimeHostId: "builtin",
        rootPath: "/workspace",
        path: "a.ts",
      });

      expect(builtinHost.readFile).toHaveBeenCalledWith({
        runtimeHostId: "builtin",
        rootPath: "/workspace",
        path: "a.ts",
      });
      expect(tunnelHandler.sendRequest).not.toHaveBeenCalled();
    });

    it("routes registered file reads through the tunnel", async () => {
      tunnelHandler.sendRequest.mockResolvedValue({
        path: "a.ts",
        encoding: "utf8",
        content: "remote",
        size: 6,
        truncated: false,
      });

      await adapter.readFile({
        runtimeHostId: "rt-1",
        rootPath: "/workspace",
        path: "a.ts",
      });

      expect(tunnelHandler.sendRequest).toHaveBeenCalledWith(
        "rt-1",
        expect.objectContaining({
          method: "host.readFile",
          params: {
            runtimeHostId: "rt-1",
            rootPath: "/workspace",
            path: "a.ts",
          },
        }),
        expect.any(Number)
      );
    });
  });
});
