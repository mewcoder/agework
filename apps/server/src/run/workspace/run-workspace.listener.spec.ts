import { describe, expect, it, vi } from "vitest";
import type { RunService } from "../run.service";
import type { RuntimeHostService } from "../../runtime-host/runtime-host.service";
import { WorkspaceDeletedEvent } from "../../workspace/workspace.events";
import { RunWorkspaceListener } from "./run-workspace.listener";

function makeDeps(
  overrides: {
    stopForWorkspace?: ReturnType<typeof vi.fn>;
    releaseResources?: ReturnType<typeof vi.fn>;
  } = {}
) {
  const stopForWorkspace =
    overrides.stopForWorkspace ?? vi.fn().mockResolvedValue(undefined);
  const releaseResources =
    overrides.releaseResources ?? vi.fn().mockResolvedValue(undefined);
  const listener = new RunWorkspaceListener(
    { stopForWorkspace } as unknown as RunService,
    {
      releaseResources,
      listLifecycleClaims: vi.fn().mockResolvedValue([]),
    } as unknown as RuntimeHostService
  );
  return { listener, stopForWorkspace, releaseResources };
}

describe("RunWorkspaceListener", () => {
  it("stops active runs before releasing the workspace resources", async () => {
    const order: string[] = [];
    const { listener, releaseResources } = makeDeps({
      stopForWorkspace: vi.fn(async () => {
        order.push("stop");
      }),
      releaseResources: vi.fn(async () => {
        order.push("release");
      }),
    });

    await listener.onWorkspaceDeleted(
      new WorkspaceDeletedEvent("ws-1", "user-1", "rt-1")
    );

    expect(order).toEqual(["stop", "release"]);
    expect(releaseResources).toHaveBeenCalledWith({
      runtimeHostId: "rt-1",
      target: { type: "workspace", workspaceId: "ws-1" },
    });
  });

  it("still releases the resources when stopping runs fails", async () => {
    const { listener, releaseResources } = makeDeps({
      stopForWorkspace: vi.fn().mockRejectedValue(new Error("host offline")),
    });

    await expect(
      listener.onWorkspaceDeleted(
        new WorkspaceDeletedEvent("ws-1", "user-1", "rt-1")
      )
    ).resolves.toBeUndefined();

    expect(releaseResources).toHaveBeenCalledTimes(1);
  });

  it("swallows release failures (best-effort,重连对账兜底)", async () => {
    const { listener } = makeDeps({
      releaseResources: vi.fn().mockRejectedValue(new Error("tunnel timeout")),
    });

    await expect(
      listener.onWorkspaceDeleted(
        new WorkspaceDeletedEvent("ws-1", "user-1", "rt-1")
      )
    ).resolves.toBeUndefined();
  });
});
