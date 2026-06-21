import { describe, it, expect, vi } from "vitest";
import { RuntimeWorkspaceController } from "./runtime-workspace.controller";
import { RuntimeControlQueue } from "./runtime-control-queue";
import { RuntimeProviderRegistry } from "../providers/runtime-provider-registry";

describe("RuntimeWorkspaceController", () => {
  describe("pollWorkspaceControls()", () => {
    it("polls the control queue by workspaceId and afterSeq", async () => {
      const controlQueue: Partial<RuntimeControlQueue> = {
        pollByWorkspace: vi.fn().mockReturnValue([
          { seq: 1, runId: "run-1", payload: { type: "cancel" } },
        ]),
      };
      const runtimeProviderRegistry = {
        resolve: vi.fn().mockReturnValue({ heartbeatWorkspace: vi.fn() }),
      } as unknown as RuntimeProviderRegistry;
      const workspaceRuntimeService = {
        findActiveByWorkspace: vi.fn(),
      };

      const controller = new RuntimeWorkspaceController(
        controlQueue as RuntimeControlQueue,
        runtimeProviderRegistry,
        workspaceRuntimeService as never
      );

      const result = await controller.pollWorkspaceControls("ws-1", "3");

      expect(controlQueue.pollByWorkspace).toHaveBeenCalledWith("ws-1", 3);
      expect(result).toEqual({
        controls: [{ seq: 1, runId: "run-1", payload: { type: "cancel" } }],
      });
    });

    it("defaults afterSeq to 0 when not provided", async () => {
      const controlQueue: Partial<RuntimeControlQueue> = {
        pollByWorkspace: vi.fn().mockReturnValue([]),
      };
      const runtimeProviderRegistry = {
        resolve: vi.fn().mockReturnValue({ heartbeatWorkspace: vi.fn() }),
      } as unknown as RuntimeProviderRegistry;
      const workspaceRuntimeService = {
        findActiveByWorkspace: vi.fn(),
      };

      const controller = new RuntimeWorkspaceController(
        controlQueue as RuntimeControlQueue,
        runtimeProviderRegistry,
        workspaceRuntimeService as never
      );

      await controller.pollWorkspaceControls("ws-1");

      expect(controlQueue.pollByWorkspace).toHaveBeenCalledWith("ws-1", 0);
    });

    it("long-polls when waitMs is provided", async () => {
      const controlQueue: Partial<RuntimeControlQueue> = {
        waitForWorkspace: vi.fn().mockResolvedValue([
          { seq: 2, runId: "run-2", payload: { type: "user_message" } },
        ]),
      };
      const runtimeProviderRegistry = {
        resolve: vi.fn().mockReturnValue({ heartbeatWorkspace: vi.fn() }),
      } as unknown as RuntimeProviderRegistry;
      const workspaceRuntimeService = {
        findActiveByWorkspace: vi.fn(),
      };

      const controller = new RuntimeWorkspaceController(
        controlQueue as RuntimeControlQueue,
        runtimeProviderRegistry,
        workspaceRuntimeService as never
      );

      const result = await controller.pollWorkspaceControls("ws-1", "1", "25000");

      expect(controlQueue.waitForWorkspace).toHaveBeenCalledWith("ws-1", 1, 25000);
      expect(result.controls).toHaveLength(1);
    });
  });

  describe("heartbeat()", () => {
    it("dispatches sandbox heartbeat directly by resource key", async () => {
      const heartbeatWorkspace = vi.fn();
      const controlQueue = {} as RuntimeControlQueue;
      const runtimeProviderRegistry = {
        resolve: vi.fn().mockReturnValue({ heartbeatWorkspace }),
      } as unknown as RuntimeProviderRegistry;
      const workspaceRuntimeService = {
        findActiveByWorkspace: vi.fn().mockResolvedValue({
          resource: { runtimeType: "sandbox" },
        }),
      };

      const controller = new RuntimeWorkspaceController(
        controlQueue,
        runtimeProviderRegistry,
        workspaceRuntimeService as never
      );

      const result = await controller.heartbeat("ws-1");

      expect(workspaceRuntimeService.findActiveByWorkspace).toHaveBeenCalledWith("ws-1");
      expect(runtimeProviderRegistry.resolve).toHaveBeenCalledWith("sandbox");
      expect(heartbeatWorkspace).toHaveBeenCalledWith("ws-1");
      expect(result).toEqual({ ok: true });
    });

    it("still dispatches sandbox heartbeat when binding is not visible", async () => {
      const heartbeatWorkspace = vi.fn();
      const controlQueue = {} as RuntimeControlQueue;
      const runtimeProviderRegistry = {
        resolve: vi.fn().mockReturnValue({ heartbeatWorkspace }),
      } as unknown as RuntimeProviderRegistry;
      const workspaceRuntimeService = {
        findActiveByWorkspace: vi.fn().mockResolvedValue(null),
      };

      const controller = new RuntimeWorkspaceController(
        controlQueue,
        runtimeProviderRegistry,
        workspaceRuntimeService as never
      );

      const result = await controller.heartbeat("ws-1");

      expect(runtimeProviderRegistry.resolve).toHaveBeenCalledWith("sandbox");
      expect(heartbeatWorkspace).toHaveBeenCalledWith("ws-1");
      expect(result).toEqual({ ok: true });
    });

    it("does not fail heartbeat when binding lookup fails", async () => {
      const heartbeatWorkspace = vi.fn();
      const controlQueue = {} as RuntimeControlQueue;
      const runtimeProviderRegistry = {
        resolve: vi.fn().mockReturnValue({ heartbeatWorkspace }),
      } as unknown as RuntimeProviderRegistry;
      const workspaceRuntimeService = {
        findActiveByWorkspace: vi.fn().mockRejectedValue(new Error("db busy")),
      };

      const controller = new RuntimeWorkspaceController(
        controlQueue,
        runtimeProviderRegistry,
        workspaceRuntimeService as never
      );

      const result = await controller.heartbeat("ws-1");

      expect(heartbeatWorkspace).toHaveBeenCalledWith("ws-1");
      expect(result).toEqual({ ok: true });
    });
  });
});
