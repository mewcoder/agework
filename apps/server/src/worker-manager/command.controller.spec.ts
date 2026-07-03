import { describe, it, expect, vi } from "vitest";
import { IS_PUBLIC_KEY } from "../auth/decorators/public.decorator";
import { WorkerCommandController } from "./command.controller";
import { WorkerManagerService } from "./worker-manager.service";

describe("WorkerCommandController", () => {
  it("is marked @Public() so worker callbacks bypass the global JwtAuthGuard (auth is handled by WorkerAuthGuard)", () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, WorkerCommandController)).toBe(
      true
    );
  });

  it("delegates pollCommands to WorkerManagerService with ownerId and query", async () => {
    const workerManager = {
      pollCommands: vi.fn().mockResolvedValue({ messages: [] }),
    };
    const controller = new WorkerCommandController(
      workerManager as unknown as WorkerManagerService
    );

    await controller.pollCommands(
      { ownerId: "owner-1" },
      { afterSeq: 3, waitMs: 25000 }
    );

    expect(workerManager.pollCommands).toHaveBeenCalledWith("owner-1", {
      afterSeq: 3,
      waitMs: 25000,
    });
  });

  it("delegates registerWorker to WorkerManagerService with ownerId and body", async () => {
    const workerManager = {
      registerWorker: vi.fn().mockResolvedValue({ ok: true }),
    };
    const controller = new WorkerCommandController(
      workerManager as unknown as WorkerManagerService
    );

    const body = { startToken: "token-1", pid: 4242 };
    await controller.registerWorker({ ownerId: "owner-1" }, body);

    expect(workerManager.registerWorker).toHaveBeenCalledWith("owner-1", body);
  });
});
