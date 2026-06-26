import { describe, it, expect, vi } from "vitest";
import { WorkerRuntimeController } from "./worker-runtime.controller";
import { RuntimeControlQueue } from "./control-queue";
import { WorkerAccessService } from "./access.service";
import { RuntimeHeartbeatRegistry } from "./runtime-heartbeat.registry";

function makeHeartbeatRegistry(): RuntimeHeartbeatRegistry {
  return {
    heartbeatRuntimeInstance: vi.fn(),
  } as unknown as RuntimeHeartbeatRegistry;
}

describe("WorkerRuntimeController", () => {
  describe("pollRuntimeControls()", () => {
    it("resolves scopeKey from runtimeInstanceId and polls the workspace queue", async () => {
      const controlQueue: Partial<RuntimeControlQueue> = {
        pollByWorkspace: vi
          .fn()
          .mockReturnValue([
            { seq: 1, runId: "run-1", payload: { type: "cancel" } },
          ]),
      };
      const runtimeAccess: Partial<WorkerAccessService> = {
        getScopeKeyForRuntimeInstance: vi.fn().mockReturnValue("ws-1"),
      };
      const controller = new WorkerRuntimeController(
        controlQueue as RuntimeControlQueue,
        runtimeAccess as WorkerAccessService,
        makeHeartbeatRegistry()
      );

      const result = await controller.pollRuntimeControls("rr-1", "3");

      expect(runtimeAccess.getScopeKeyForRuntimeInstance).toHaveBeenCalledWith(
        "rr-1"
      );
      expect(controlQueue.pollByWorkspace).toHaveBeenCalledWith("ws-1", 3);
      expect(result.controls).toHaveLength(1);
      expect(result.controls[0].seq).toBe(1);
    });

    it("defaults afterSeq to 0 when not provided", async () => {
      const controlQueue: Partial<RuntimeControlQueue> = {
        pollByWorkspace: vi.fn().mockReturnValue([]),
      };
      const runtimeAccess: Partial<WorkerAccessService> = {
        getScopeKeyForRuntimeInstance: vi.fn().mockReturnValue("ws-1"),
      };
      const controller = new WorkerRuntimeController(
        controlQueue as RuntimeControlQueue,
        runtimeAccess as WorkerAccessService,
        makeHeartbeatRegistry()
      );

      await controller.pollRuntimeControls("rr-1");

      expect(controlQueue.pollByWorkspace).toHaveBeenCalledWith("ws-1", 0);
    });

    it("handles invalid afterSeq as 0", async () => {
      const controlQueue: Partial<RuntimeControlQueue> = {
        pollByWorkspace: vi.fn().mockReturnValue([]),
      };
      const runtimeAccess: Partial<WorkerAccessService> = {
        getScopeKeyForRuntimeInstance: vi.fn().mockReturnValue("ws-1"),
      };
      const controller = new WorkerRuntimeController(
        controlQueue as RuntimeControlQueue,
        runtimeAccess as WorkerAccessService,
        makeHeartbeatRegistry()
      );

      await controller.pollRuntimeControls("rr-1", "not-a-number");

      expect(controlQueue.pollByWorkspace).toHaveBeenCalledWith("ws-1", 0);
    });

    it("long-polls the resolved resource key when waitMs is provided", async () => {
      const controlQueue: Partial<RuntimeControlQueue> = {
        waitForWorkspace: vi
          .fn()
          .mockResolvedValue([
            { seq: 2, runId: "run-2", payload: { type: "user_message" } },
          ]),
      };
      const runtimeAccess: Partial<WorkerAccessService> = {
        getScopeKeyForRuntimeInstance: vi.fn().mockReturnValue("ws-1"),
      };
      const controller = new WorkerRuntimeController(
        controlQueue as RuntimeControlQueue,
        runtimeAccess as WorkerAccessService,
        makeHeartbeatRegistry()
      );

      const result = await controller.pollRuntimeControls("rr-1", "1", "25000");

      expect(controlQueue.waitForWorkspace).toHaveBeenCalledWith(
        "ws-1",
        1,
        25000
      );
      expect(result.controls).toHaveLength(1);
    });

    it("returns no controls when scopeKey is not found", async () => {
      const controlQueue: Partial<RuntimeControlQueue> = {
        pollByWorkspace: vi
          .fn()
          .mockReturnValue([
            { seq: 1, runId: "run-1", payload: { type: "cancel" } },
          ]),
      };
      const runtimeAccess: Partial<WorkerAccessService> = {
        getScopeKeyForRuntimeInstance: vi.fn().mockReturnValue(undefined),
      };
      const controller = new WorkerRuntimeController(
        controlQueue as RuntimeControlQueue,
        runtimeAccess as WorkerAccessService,
        makeHeartbeatRegistry()
      );

      const result = await controller.pollRuntimeControls("rr-unknown", "0");

      expect(controlQueue.pollByWorkspace).not.toHaveBeenCalled();
      expect(result.controls).toEqual([]);
    });
  });

  describe("heartbeat()", () => {
    it("dispatches heartbeat via scopeKey lookup", async () => {
      const controlQueue = {} as RuntimeControlQueue;
      const runtimeAccess: Partial<WorkerAccessService> = {
        getScopeKeyForRuntimeInstance: vi.fn().mockReturnValue("ws-1"),
      };
      const runtimeService = makeHeartbeatRegistry();
      const controller = new WorkerRuntimeController(
        controlQueue,
        runtimeAccess as WorkerAccessService,
        runtimeService
      );

      const result = await controller.heartbeat("rr-1");

      expect(runtimeAccess.getScopeKeyForRuntimeInstance).toHaveBeenCalledWith(
        "rr-1"
      );
      expect(runtimeService.heartbeatRuntimeInstance).toHaveBeenCalledWith(
        "ws-1"
      );
      expect(result).toEqual({ ok: true });
    });

    it("returns ok even when scopeKey is not found", async () => {
      const controlQueue = {} as RuntimeControlQueue;
      const runtimeAccess: Partial<WorkerAccessService> = {
        getScopeKeyForRuntimeInstance: vi.fn().mockReturnValue(undefined),
      };
      const runtimeService = makeHeartbeatRegistry();
      const controller = new WorkerRuntimeController(
        controlQueue,
        runtimeAccess as WorkerAccessService,
        runtimeService
      );

      const result = await controller.heartbeat("rr-unknown");

      expect(runtimeAccess.getScopeKeyForRuntimeInstance).toHaveBeenCalledWith(
        "rr-unknown"
      );
      expect(runtimeService.heartbeatRuntimeInstance).not.toHaveBeenCalled();
      expect(result).toEqual({ ok: true });
    });
  });
});
