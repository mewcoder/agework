import { describe, it, expect, vi } from "vitest";
import type { RunConfig } from "@agework/shared/protocol";
import { IS_PUBLIC_KEY } from "../auth/decorators/public.decorator";
import { WorkerRunController } from "./worker-run.controller";
import { WorkerHostService } from "./worker-host.service";

describe("WorkerRunController", () => {
  it("is marked @Public() so worker callbacks bypass the global JwtAuthGuard (auth is handled by WorkerAuthGuard)", () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, WorkerRunController)).toBe(true);
  });

  it("delegates getRunConfig to WorkerHostService with runId", () => {
    const config = { runId: "run-1" } as unknown as RunConfig;
    const workerHost = {
      getRunConfig: vi.fn().mockReturnValue({ config }),
    };
    const controller = new WorkerRunController(
      workerHost as unknown as WorkerHostService
    );

    expect(controller.getRunConfig({ runId: "run-1" })).toEqual({ config });
    expect(workerHost.getRunConfig).toHaveBeenCalledWith("run-1");
  });

  it("delegates postEvent to WorkerHostService with runId and body", async () => {
    const workerHost = {
      postEvent: vi.fn().mockResolvedValue({ ok: true }),
    };
    const controller = new WorkerRunController(
      workerHost as unknown as WorkerHostService
    );
    const body = { jsonrpc: "2.0", method: "run.status" };

    await expect(
      controller.postEvent({ runId: "run-1" }, body)
    ).resolves.toEqual({ ok: true });
    expect(workerHost.postEvent).toHaveBeenCalledWith("run-1", body);
  });
});
