import { describe, expect, it, vi } from "vitest";
import { UserService } from "./user.service";

describe("UserService runtime reconciliation", () => {
  it("releases inactive users and replays release_pending with its original version", async () => {
    const users = {
      findInactiveSessionVersions: vi
        .fn()
        .mockResolvedValue([{ id: "user-inactive", sessionVersion: 8 }]),
    };
    const releaseResources = vi.fn().mockResolvedValue(undefined);
    const service = new UserService(
      users as never,
      {} as never,
      {} as never,
      { releaseResources } as never
    );

    await service.reconcileRuntimeHostResources("host-1", [
      {
        kind: "session",
        runtimeHostId: "host-1",
        runId: "run-1",
        phase: "ready",
        userId: "user-inactive",
        userLifecycleVersion: 7,
        workspaceId: "ws-1",
      },
      {
        kind: "release_pending",
        runtimeHostId: "host-1",
        target: { type: "user", userId: "user-pending" },
        userLifecycleVersion: 4,
      },
    ]);

    expect(releaseResources).toHaveBeenCalledWith({
      runtimeHostId: "host-1",
      target: {
        type: "user",
        userId: "user-inactive",
        userLifecycleVersion: 8,
      },
    });
    expect(releaseResources).toHaveBeenCalledWith({
      runtimeHostId: "host-1",
      target: {
        type: "user",
        userId: "user-pending",
        userLifecycleVersion: 4,
      },
    });
  });

  it("rejects a malformed pending user release instead of skipping it", async () => {
    const service = new UserService(
      {} as never,
      {} as never,
      {} as never,
      { releaseResources: vi.fn() } as never
    );

    await expect(
      service.reconcileRuntimeHostResources("host-1", [
        {
          kind: "release_pending",
          runtimeHostId: "host-1",
          target: { type: "user", userId: "user-1" },
        },
      ])
    ).rejects.toThrow("missing userLifecycleVersion");
  });
});
