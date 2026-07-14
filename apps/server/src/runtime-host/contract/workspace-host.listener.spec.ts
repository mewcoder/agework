import { describe, expect, it, vi } from "vitest";
import type { RuntimeHostContract } from "@agework/shared/protocol";
import { WorkspaceDeletedEvent } from "../../workspace/workspace.events";
import { WorkspaceHostListener } from "./workspace-host.listener";

describe("WorkspaceHostListener", () => {
  it("releases only the deleted workspace owner on its configured host", async () => {
    const hostContract = {
      releaseOwner: vi.fn().mockResolvedValue(undefined),
    } as unknown as RuntimeHostContract;
    const listener = new WorkspaceHostListener(hostContract);

    await listener.onWorkspaceDeleted(
      new WorkspaceDeletedEvent("ws-1", "user-1", "rt-1")
    );

    expect(hostContract.releaseOwner).toHaveBeenCalledTimes(1);
    expect(hostContract.releaseOwner).toHaveBeenCalledWith({
      runtimeHostId: "rt-1",
      owner: "workspace:ws-1",
    });
  });
});
