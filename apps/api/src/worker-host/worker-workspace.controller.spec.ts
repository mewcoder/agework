import { describe, it, expect, vi } from "vitest";
import { WorkerWorkspaceController } from "./worker-workspace.controller";
import { RuntimeControlQueue } from "./control-queue";
import { RuntimeHeartbeatRegistry } from "./runtime-heartbeat.registry";

function makeHeartbeatRegistry(): RuntimeHeartbeatRegistry {
  return {
    heartbeatRuntimeInstance: vi.fn(),
  } as unknown as RuntimeHeartbeatRegistry;
}

describe("WorkerWorkspaceController", () => {
  describe("pollWorkspaceControls()", () => {
    it("polls the control queue by workspaceId and afterSeq", async () => {
      const controlQueue: Partial<RuntimeControlQueue> = {
        pollByWorkspace: vi.fn().mockReturnValue([
          { seq: 1, runId: "run-1", payload: { type: "cancel" } },
        ]),
      };

      const controller = new WorkerWorkspaceController(
        controlQueue as RuntimeControlQueue,
        makeHeartbeatRegistry()
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

      const controller = new WorkerWorkspaceController(
        controlQueue as RuntimeControlQueue,
        makeHeartbeatRegistry()
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

      const controller = new WorkerWorkspaceController(
        controlQueue as RuntimeControlQueue,
        makeHeartbeatRegistry()
      );

      const result = await controller.pollWorkspaceControls("ws-1", "1", "25000");

      expect(controlQueue.waitForWorkspace).toHaveBeenCalledWith("ws-1", 1, 25000);
      expect(result.controls).toHaveLength(1);
    });
  });

  describe("heartbeat()", () => {
    it("broadcasts the heartbeat by resource key", () => {
      const controlQueue = {} as RuntimeControlQueue;
      const runtimeService = makeHeartbeatRegistry();

      const controller = new WorkerWorkspaceController(
        controlQueue,
        runtimeService
      );

      const result = controller.heartbeat("ws-1");

      expect(runtimeService.heartbeatRuntimeInstance).toHaveBeenCalledWith("ws-1");
      expect(result).toEqual({ ok: true });
    });
  });
});
