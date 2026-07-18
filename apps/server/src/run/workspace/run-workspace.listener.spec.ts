import { describe, expect, it, vi } from "vitest";
import type { RunService } from "../run.service";
import type { RuntimeHostOwnerReconciliation } from "../../runtime-host/runtime-host.types";
import { WorkspaceDeletedEvent } from "../../workspace/workspace.events";
import { RunWorkspaceListener } from "./run-workspace.listener";

function makeDeps(
  overrides: {
    stopForWorkspace?: ReturnType<typeof vi.fn>;
    releaseOwner?: ReturnType<typeof vi.fn>;
  } = {}
) {
  const stopForWorkspace =
    overrides.stopForWorkspace ?? vi.fn().mockResolvedValue(undefined);
  const releaseOwner =
    overrides.releaseOwner ?? vi.fn().mockResolvedValue(undefined);
  const listener = new RunWorkspaceListener(
    { stopForWorkspace } as unknown as RunService,
    { releaseOwner } as unknown as RuntimeHostOwnerReconciliation
  );
  return { listener, stopForWorkspace, releaseOwner };
}

describe("RunWorkspaceListener", () => {
  it("stops active runs before releasing the workspace owner", async () => {
    const order: string[] = [];
    const { listener, releaseOwner } = makeDeps({
      stopForWorkspace: vi.fn(async () => {
        order.push("stop");
      }),
      releaseOwner: vi.fn(async () => {
        order.push("release");
      }),
    });

    await listener.onWorkspaceDeleted(
      new WorkspaceDeletedEvent("ws-1", "user-1", "rt-1")
    );

    expect(order).toEqual(["stop", "release"]);
    expect(releaseOwner).toHaveBeenCalledWith({
      runtimeHostId: "rt-1",
      owner: "workspace:ws-1",
    });
  });

  it("still releases the owner when stopping runs fails", async () => {
    const { listener, releaseOwner } = makeDeps({
      stopForWorkspace: vi.fn().mockRejectedValue(new Error("host offline")),
    });

    await expect(
      listener.onWorkspaceDeleted(
        new WorkspaceDeletedEvent("ws-1", "user-1", "rt-1")
      )
    ).resolves.toBeUndefined();

    expect(releaseOwner).toHaveBeenCalledTimes(1);
  });

  it("swallows release failures (best-effort,重连对账兜底)", async () => {
    const { listener } = makeDeps({
      releaseOwner: vi.fn().mockRejectedValue(new Error("tunnel timeout")),
    });

    await expect(
      listener.onWorkspaceDeleted(
        new WorkspaceDeletedEvent("ws-1", "user-1", "rt-1")
      )
    ).resolves.toBeUndefined();
  });
});
