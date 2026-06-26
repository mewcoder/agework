import { describe, it, expect, vi } from "vitest";
import { WorkerCommandController } from "./command.controller";
import { WorkerCommandQueue } from "./command-queue";

describe("WorkerCommandController", () => {
  describe("pollCommands()", () => {
    it("polls the command queue by ownerId and afterSeq", async () => {
      const commandQueue: Partial<WorkerCommandQueue> = {
        pollByOwnerId: vi
          .fn()
          .mockReturnValue([
            { seq: 1, runId: "run-1", payload: { type: "cancel" } },
          ]),
      };

      const controller = new WorkerCommandController(
        commandQueue as WorkerCommandQueue
      );

      const result = await controller.pollCommands("owner-1", "3");

      expect(commandQueue.pollByOwnerId).toHaveBeenCalledWith("owner-1", 3);
      expect(result).toEqual({
        commands: [{ seq: 1, runId: "run-1", payload: { type: "cancel" } }],
      });
    });

    it("defaults afterSeq to 0 when not provided", async () => {
      const commandQueue: Partial<WorkerCommandQueue> = {
        pollByOwnerId: vi.fn().mockReturnValue([]),
      };

      const controller = new WorkerCommandController(
        commandQueue as WorkerCommandQueue
      );

      await controller.pollCommands("owner-1");

      expect(commandQueue.pollByOwnerId).toHaveBeenCalledWith("owner-1", 0);
    });

    it("defaults afterSeq to 0 when invalid", async () => {
      const commandQueue: Partial<WorkerCommandQueue> = {
        pollByOwnerId: vi.fn().mockReturnValue([]),
      };

      const controller = new WorkerCommandController(
        commandQueue as WorkerCommandQueue
      );

      await controller.pollCommands("owner-1", "not-a-number");

      expect(commandQueue.pollByOwnerId).toHaveBeenCalledWith("owner-1", 0);
    });

    it("long-polls when waitMs is provided", async () => {
      const commandQueue: Partial<WorkerCommandQueue> = {
        waitForOwnerId: vi
          .fn()
          .mockResolvedValue([
            { seq: 2, runId: "run-2", payload: { type: "user_message" } },
          ]),
      };

      const controller = new WorkerCommandController(
        commandQueue as WorkerCommandQueue
      );

      const result = await controller.pollCommands("owner-1", "1", "25000");

      expect(commandQueue.waitForOwnerId).toHaveBeenCalledWith(
        "owner-1",
        1,
        25000
      );
      expect(result.commands).toHaveLength(1);
    });
  });

});
