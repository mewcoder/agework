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
            {
              seq: 1,
              runId: "run-1",
              type: "command",
              payload: {
                type: "cancel",
                commandId: "cmd-1",
                runId: "run-1",
                conversationId: "conv-1",
              },
              ts: "2026-06-27T00:00:00.000Z",
            },
          ]),
      };

      const controller = new WorkerCommandController(
        commandQueue as WorkerCommandQueue
      );

      const result = await controller.pollCommands(
        { ownerId: "owner-1" },
        { afterSeq: 3 }
      );

      expect(commandQueue.pollByOwnerId).toHaveBeenCalledWith("owner-1", 3);
      expect(result).toEqual({
        messages: [
          {
            jsonrpc: "2.0",
            id: "cmd-1",
            method: "run.cancel",
            params: {
              runId: "run-1",
              conversationId: "conv-1",
            },
            meta: {
              runId: "run-1",
              seq: 1,
              ts: "2026-06-27T00:00:00.000Z",
            },
          },
        ],
      });
    });

    it("defaults afterSeq to 0 when not provided", async () => {
      const commandQueue: Partial<WorkerCommandQueue> = {
        pollByOwnerId: vi.fn().mockReturnValue([]),
      };

      const controller = new WorkerCommandController(
        commandQueue as WorkerCommandQueue
      );

      await controller.pollCommands({ ownerId: "owner-1" }, {});

      expect(commandQueue.pollByOwnerId).toHaveBeenCalledWith("owner-1", 0);
    });

    it("defaults afterSeq to 0 when omitted", async () => {
      const commandQueue: Partial<WorkerCommandQueue> = {
        pollByOwnerId: vi.fn().mockReturnValue([]),
      };

      const controller = new WorkerCommandController(
        commandQueue as WorkerCommandQueue
      );

      await controller.pollCommands({ ownerId: "owner-1" }, { waitMs: 0 });

      expect(commandQueue.pollByOwnerId).toHaveBeenCalledWith("owner-1", 0);
    });

    it("long-polls when waitMs is provided", async () => {
      const commandQueue: Partial<WorkerCommandQueue> = {
        waitForOwnerId: vi
          .fn()
          .mockResolvedValue([
            {
              seq: 2,
              runId: "run-2",
              type: "command",
              payload: {
                type: "user_message",
                commandId: "cmd-2",
                runId: "run-2",
              },
              ts: "2026-06-27T00:00:00.000Z",
            },
          ]),
      };

      const controller = new WorkerCommandController(
        commandQueue as WorkerCommandQueue
      );

      const result = await controller.pollCommands(
        { ownerId: "owner-1" },
        { afterSeq: 1, waitMs: 25000 }
      );

      expect(commandQueue.waitForOwnerId).toHaveBeenCalledWith(
        "owner-1",
        1,
        25000
      );
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toMatchObject({
        id: "cmd-2",
        method: "run.start",
      });
    });
  });

});
