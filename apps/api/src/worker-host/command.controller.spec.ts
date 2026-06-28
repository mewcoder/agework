import { describe, it, expect, vi } from "vitest";
import { IS_PUBLIC_KEY } from "../auth/decorators/public.decorator";
import { WorkerCommandController } from "./command.controller";
import { WorkerHostService } from "./worker-host.service";

describe("WorkerCommandController", () => {
  it("is marked @Public() so worker callbacks bypass the global JwtAuthGuard (auth is handled by WorkerAuthGuard)", () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, WorkerCommandController)).toBe(
      true
    );
  });

  it("delegates pollCommands to WorkerHostService with ownerId and query", async () => {
    const workerHost = {
      pollCommands: vi.fn().mockResolvedValue({ messages: [] }),
    };
    const controller = new WorkerCommandController(
      workerHost as unknown as WorkerHostService
    );

    await controller.pollCommands(
      { ownerId: "owner-1" },
      { afterSeq: 3, waitMs: 25000 }
    );

    expect(workerHost.pollCommands).toHaveBeenCalledWith("owner-1", {
      afterSeq: 3,
      waitMs: 25000,
    });
  });
});
