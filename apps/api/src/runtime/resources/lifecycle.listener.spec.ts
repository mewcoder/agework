import { describe, expect, it, vi } from "vitest";
import { RuntimeInstanceLifecycleListener } from "./lifecycle.listener";
import { WorkspaceDeletedEvent } from "../../workspaces/workspace.events";
import {
  UserDeletedEvent,
  UserDisabledEvent,
} from "../../users/user.events";

describe("RuntimeInstanceLifecycleListener", () => {
  it("shuts down the workspace runtime resource on WorkspaceDeletedEvent", async () => {
    const shutdownForWorkspace = vi.fn().mockResolvedValue(undefined);
    const listener = new RuntimeInstanceLifecycleListener({
      shutdownForWorkspace,
    } as never);

    await listener.onWorkspaceDeleted(new WorkspaceDeletedEvent("ws-1"));

    expect(shutdownForWorkspace).toHaveBeenCalledWith("ws-1");
  });

  it("swallows shutdown failures so the source operation is unaffected", async () => {
    const shutdownForWorkspace = vi
      .fn()
      .mockRejectedValue(new Error("boom"));
    const listener = new RuntimeInstanceLifecycleListener({
      shutdownForWorkspace,
    } as never);

    await expect(
      listener.onWorkspaceDeleted(new WorkspaceDeletedEvent("ws-1")),
    ).resolves.toBeUndefined();
  });

  it("shuts down user runtime resources on UserDeletedEvent and UserDisabledEvent", async () => {
    const shutdownForUser = vi.fn().mockResolvedValue(undefined);
    const listener = new RuntimeInstanceLifecycleListener({
      shutdownForUser,
    } as never);

    await listener.onUserResourcesReleased(new UserDeletedEvent("user-1"));
    await listener.onUserResourcesReleased(new UserDisabledEvent("user-2"));

    expect(shutdownForUser).toHaveBeenCalledWith("user-1");
    expect(shutdownForUser).toHaveBeenCalledWith("user-2");
  });

  it("swallows user shutdown failures", async () => {
    const shutdownForUser = vi.fn().mockRejectedValue(new Error("boom"));
    const listener = new RuntimeInstanceLifecycleListener({
      shutdownForUser,
    } as never);

    await expect(
      listener.onUserResourcesReleased(new UserDeletedEvent("user-1")),
    ).resolves.toBeUndefined();
  });
});
