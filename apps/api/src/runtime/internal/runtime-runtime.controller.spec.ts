import { describe, it, expect, vi } from "vitest";
import { RuntimeRuntimeController } from "./runtime-runtime.controller";
import { RuntimeControlQueue } from "./runtime-control-queue";
import { RuntimeInternalAccessService } from "./runtime-internal-access.service";
import { RuntimeProviderRegistry } from "../providers/runtime-provider-registry";

describe("RuntimeRuntimeController", () => {
  describe("pollRuntimeControls()", () => {
    it("resolves resourceKey from runtimeResourceId and polls the workspace queue", async () => {
      const controlQueue: Partial<RuntimeControlQueue> = {
        pollByWorkspace: vi.fn().mockReturnValue([{ seq: 1, runId: "run-1", payload: { type: "cancel" } }]),
      };
      const runtimeAccess: Partial<RuntimeInternalAccessService> = {
        getResourceKeyForRuntimeResource: vi.fn().mockReturnValue("ws-1"),
        getRuntimeTypeForRuntimeResource: vi.fn().mockReturnValue("sandbox"),
      };
      const runtimeProviderRegistry = {
        resolve: vi.fn().mockReturnValue({ heartbeatWorkspace: vi.fn() }),
      } as unknown as RuntimeProviderRegistry;
      const controller = new RuntimeRuntimeController(
        controlQueue as RuntimeControlQueue,
        runtimeAccess as RuntimeInternalAccessService,
        runtimeProviderRegistry
      );

      const result = await controller.pollRuntimeControls("rr-1", "3");

      expect(runtimeAccess.getResourceKeyForRuntimeResource).toHaveBeenCalledWith("rr-1");
      expect(controlQueue.pollByWorkspace).toHaveBeenCalledWith("ws-1", 3);
      expect(result.controls).toHaveLength(1);
      expect(result.controls[0].seq).toBe(1);
    });

    it("defaults afterSeq to 0 when not provided", async () => {
      const controlQueue: Partial<RuntimeControlQueue> = {
        pollByWorkspace: vi.fn().mockReturnValue([]),
      };
      const runtimeAccess: Partial<RuntimeInternalAccessService> = {
        getResourceKeyForRuntimeResource: vi.fn().mockReturnValue("ws-1"),
        getRuntimeTypeForRuntimeResource: vi.fn().mockReturnValue("sandbox"),
      };
      const runtimeProviderRegistry = {
        resolve: vi.fn().mockReturnValue({ heartbeatWorkspace: vi.fn() }),
      } as unknown as RuntimeProviderRegistry;
      const controller = new RuntimeRuntimeController(
        controlQueue as RuntimeControlQueue,
        runtimeAccess as RuntimeInternalAccessService,
        runtimeProviderRegistry
      );

      await controller.pollRuntimeControls("rr-1");

      expect(controlQueue.pollByWorkspace).toHaveBeenCalledWith("ws-1", 0);
    });

    it("handles invalid afterSeq as 0", async () => {
      const controlQueue: Partial<RuntimeControlQueue> = {
        pollByWorkspace: vi.fn().mockReturnValue([]),
      };
      const runtimeAccess: Partial<RuntimeInternalAccessService> = {
        getResourceKeyForRuntimeResource: vi.fn().mockReturnValue("ws-1"),
      };
      const runtimeProviderRegistry = {
        resolve: vi.fn().mockReturnValue({ heartbeatWorkspace: vi.fn() }),
      } as unknown as RuntimeProviderRegistry;
      const controller = new RuntimeRuntimeController(
        controlQueue as RuntimeControlQueue,
        runtimeAccess as RuntimeInternalAccessService,
        runtimeProviderRegistry
      );

      await controller.pollRuntimeControls("rr-1", "not-a-number");

      expect(controlQueue.pollByWorkspace).toHaveBeenCalledWith("ws-1", 0);
    });

    it("long-polls the resolved resource key when waitMs is provided", async () => {
      const controlQueue: Partial<RuntimeControlQueue> = {
        waitForWorkspace: vi.fn().mockResolvedValue([{ seq: 2, runId: "run-2", payload: { type: "user_message" } }]),
      };
      const runtimeAccess: Partial<RuntimeInternalAccessService> = {
        getResourceKeyForRuntimeResource: vi.fn().mockReturnValue("ws-1"),
      };
      const runtimeProviderRegistry = {
        resolve: vi.fn().mockReturnValue({ heartbeatWorkspace: vi.fn() }),
      } as unknown as RuntimeProviderRegistry;
      const controller = new RuntimeRuntimeController(
        controlQueue as RuntimeControlQueue,
        runtimeAccess as RuntimeInternalAccessService,
        runtimeProviderRegistry
      );

      const result = await controller.pollRuntimeControls("rr-1", "1", "25000");

      expect(controlQueue.waitForWorkspace).toHaveBeenCalledWith("ws-1", 1, 25000);
      expect(result.controls).toHaveLength(1);
    });

    it("returns no controls when resourceKey is not found", async () => {
      const controlQueue: Partial<RuntimeControlQueue> = {
        pollByWorkspace: vi.fn().mockReturnValue([{ seq: 1, runId: "run-1", payload: { type: "cancel" } }]),
      };
      const runtimeAccess: Partial<RuntimeInternalAccessService> = {
        getResourceKeyForRuntimeResource: vi.fn().mockReturnValue(undefined),
      };
      const runtimeProviderRegistry = {
        resolve: vi.fn().mockReturnValue({ heartbeatWorkspace: vi.fn() }),
      } as unknown as RuntimeProviderRegistry;
      const controller = new RuntimeRuntimeController(
        controlQueue as RuntimeControlQueue,
        runtimeAccess as RuntimeInternalAccessService,
        runtimeProviderRegistry
      );

      const result = await controller.pollRuntimeControls("rr-unknown", "0");

      expect(controlQueue.pollByWorkspace).not.toHaveBeenCalled();
      expect(result.controls).toEqual([]);
    });
  });

  describe("heartbeat()", () => {
    it("dispatches heartbeat via resourceKey lookup", async () => {
      const heartbeatRuntimeResource = vi.fn();
      const controlQueue = {} as RuntimeControlQueue;
      const runtimeAccess: Partial<RuntimeInternalAccessService> = {
        getResourceKeyForRuntimeResource: vi.fn().mockReturnValue("ws-1"),
        getRuntimeTypeForRuntimeResource: vi.fn().mockReturnValue("sandbox"),
      };
      const runtimeProviderRegistry = {
        resolve: vi.fn().mockReturnValue({ heartbeatRuntimeResource }),
      } as unknown as RuntimeProviderRegistry;
      const controller = new RuntimeRuntimeController(
        controlQueue,
        runtimeAccess as RuntimeInternalAccessService,
        runtimeProviderRegistry
      );

      const result = await controller.heartbeat("rr-1");

      expect(runtimeAccess.getResourceKeyForRuntimeResource).toHaveBeenCalledWith("rr-1");
      expect(runtimeAccess.getRuntimeTypeForRuntimeResource).toHaveBeenCalledWith("rr-1");
      expect(runtimeProviderRegistry.resolve).toHaveBeenCalledWith("sandbox");
      expect(heartbeatRuntimeResource).toHaveBeenCalledWith("ws-1");
      expect(result).toEqual({ ok: true });
    });

    it("returns ok even when resourceKey is not found", async () => {
      const controlQueue = {} as RuntimeControlQueue;
      const runtimeAccess: Partial<RuntimeInternalAccessService> = {
        getResourceKeyForRuntimeResource: vi.fn().mockReturnValue(undefined),
        getRuntimeTypeForRuntimeResource: vi.fn().mockReturnValue(undefined),
      };
      const runtimeProviderRegistry = {
        resolve: vi.fn().mockReturnValue({ heartbeatRuntimeResource: vi.fn() }),
      } as unknown as RuntimeProviderRegistry;
      const controller = new RuntimeRuntimeController(
        controlQueue,
        runtimeAccess as RuntimeInternalAccessService,
        runtimeProviderRegistry
      );

      const result = await controller.heartbeat("rr-unknown");

      expect(runtimeAccess.getResourceKeyForRuntimeResource).toHaveBeenCalledWith("rr-unknown");
      expect(runtimeProviderRegistry.resolve).not.toHaveBeenCalled();
      expect(result).toEqual({ ok: true });
    });
  });
});
