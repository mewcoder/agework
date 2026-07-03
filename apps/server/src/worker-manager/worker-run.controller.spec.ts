import { describe, it, expect, vi } from "vitest";
import type { RunConfig } from "@agework/shared/protocol";
import { IS_PUBLIC_KEY } from "../auth/decorators/public.decorator";
import { WorkerRunController } from "./worker-run.controller";
import { WorkerManagerService } from "./worker-manager.service";

describe("WorkerRunController", () => {
  it("is marked @Public() so worker callbacks bypass the global JwtAuthGuard (auth is handled by WorkerAuthGuard)", () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, WorkerRunController)).toBe(true);
  });

  it("delegates getRunConfig to WorkerManagerService with runId", () => {
    const config = { runId: "run-1" } as unknown as RunConfig;
    const workerManager = {
      getRunConfig: vi.fn().mockReturnValue({ config }),
    };
    const controller = new WorkerRunController(
      workerManager as unknown as WorkerManagerService
    );

    expect(controller.getRunConfig({ runId: "run-1" })).toEqual({ config });
    expect(workerManager.getRunConfig).toHaveBeenCalledWith("run-1");
  });

  it("delegates postEvent to WorkerManagerService with runId and body", async () => {
    const workerManager = {
      postEvent: vi.fn().mockResolvedValue({ ok: true }),
    };
    const controller = new WorkerRunController(
      workerManager as unknown as WorkerManagerService
    );
    const body = { jsonrpc: "2.0", method: "run.status" };

    await expect(
      controller.postEvent({ runId: "run-1" }, body)
    ).resolves.toEqual({ ok: true });
    expect(workerManager.postEvent).toHaveBeenCalledWith("run-1", body);
  });
});
