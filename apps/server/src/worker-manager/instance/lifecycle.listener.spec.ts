import { describe, expect, it, vi } from "vitest";
import { WorkerLifecycleListener } from "./lifecycle.listener";
import { WorkspaceDeletedEvent } from "../../workspace/workspace.events";
import { UserDeletedEvent, UserDisabledEvent } from "../../user/user.events";

describe("WorkerLifecycleListener", () => {
  it("releases the workspace-scope owner on WorkspaceDeletedEvent", async () => {
    const releaseOwner = vi.fn().mockResolvedValue(undefined);
    const listener = new WorkerLifecycleListener({ releaseOwner } as never);

    await listener.onWorkspaceDeleted(new WorkspaceDeletedEvent("ws-1"));

    expect(releaseOwner).toHaveBeenCalledWith("workspace:ws-1");
  });

  it("swallows release failures so the source operation is unaffected", async () => {
    const releaseOwner = vi.fn().mockRejectedValue(new Error("boom"));
    const listener = new WorkerLifecycleListener({ releaseOwner } as never);

    await expect(
      listener.onWorkspaceDeleted(new WorkspaceDeletedEvent("ws-1"))
    ).resolves.toBeUndefined();
  });

  it("releases the user-scope owner on UserDeletedEvent and UserDisabledEvent", async () => {
    const releaseOwner = vi.fn().mockResolvedValue(undefined);
    const listener = new WorkerLifecycleListener({ releaseOwner } as never);

    await listener.onUserResourcesReleased(new UserDeletedEvent("user-1"));
    await listener.onUserResourcesReleased(new UserDisabledEvent("user-2"));

    expect(releaseOwner).toHaveBeenCalledWith("user:user-1");
    expect(releaseOwner).toHaveBeenCalledWith("user:user-2");
  });

  it("swallows user release failures", async () => {
    const releaseOwner = vi.fn().mockRejectedValue(new Error("boom"));
    const listener = new WorkerLifecycleListener({ releaseOwner } as never);

    await expect(
      listener.onUserResourcesReleased(new UserDeletedEvent("user-1"))
    ).resolves.toBeUndefined();
  });
});
