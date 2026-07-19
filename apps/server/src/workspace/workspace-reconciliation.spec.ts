import { describe, expect, it, vi } from "vitest";
import { WorkspaceService } from "./workspace.service";

describe("WorkspaceService runtime reconciliation", () => {
  it("releases inactive and release_pending workspaces and propagates failures", async () => {
    const repo = {
      listActiveIds: vi.fn().mockResolvedValue(["ws-active"]),
    };
    const releaseResources = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("cleanup failed"));
    const service = new WorkspaceService(
      repo as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { releaseResources } as never
    );

    await expect(
      service.reconcileRuntimeHostResources("host-1", [
        {
          kind: "session",
          runtimeHostId: "host-1",
          runId: "run-1",
          phase: "ready",
          userId: "user-1",
          userLifecycleVersion: 1,
          workspaceId: "ws-active",
        },
        {
          kind: "session",
          runtimeHostId: "host-1",
          runId: "run-2",
          phase: "ready",
          userId: "user-1",
          userLifecycleVersion: 1,
          workspaceId: "ws-inactive",
        },
        {
          kind: "release_pending",
          runtimeHostId: "host-1",
          target: { type: "workspace", workspaceId: "ws-pending" },
        },
      ])
    ).rejects.toThrow("cleanup failed");

    expect(repo.listActiveIds).toHaveBeenCalledWith([
      "ws-active",
      "ws-inactive",
    ]);
    expect(releaseResources).toHaveBeenCalledWith({
      runtimeHostId: "host-1",
      target: { type: "workspace", workspaceId: "ws-inactive" },
    });
    expect(releaseResources).toHaveBeenCalledWith({
      runtimeHostId: "host-1",
      target: { type: "workspace", workspaceId: "ws-pending" },
    });
  });
});
