import { describe, expect, it, vi } from "vitest";
import type { RuntimeHostContract } from "@agework/shared/protocol";
import type { WorkspaceService } from "../../workspace/workspace.service";
import { WorkspaceDeletedEvent } from "../../workspace/workspace.events";
import { RuntimeHostConnectedEvent } from "../../runtime/runtime.events";
import { WorkspaceHostListener } from "./workspace-host.listener";

function makeHostContract(overrides: Record<string, unknown> = {}) {
  return {
    releaseOwner: vi.fn().mockResolvedValue(undefined),
    listWorkers: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as RuntimeHostContract;
}

function makeWorkspaceService(activeIds: string[] = []) {
  return {
    listActiveIds: vi.fn().mockResolvedValue(activeIds),
  } as unknown as WorkspaceService;
}

describe("WorkspaceHostListener", () => {
  it("releases only the deleted workspace owner on its configured host", async () => {
    const hostContract = makeHostContract();
    const listener = new WorkspaceHostListener(
      hostContract,
      makeWorkspaceService()
    );

    await listener.onWorkspaceDeleted(
      new WorkspaceDeletedEvent("ws-1", "user-1", "rt-1")
    );

    expect(hostContract.releaseOwner).toHaveBeenCalledTimes(1);
    expect(hostContract.releaseOwner).toHaveBeenCalledWith({
      runtimeHostId: "rt-1",
      owner: "workspace:ws-1",
    });
  });

  describe("重连对账", () => {
    function worker(
      runtimeHostId: string,
      scope: string,
      ownerId: string
    ): Record<string, unknown> {
      return { runtimeHostId, scope, ownerId };
    }

    it("releases workers of deleted workspaces on the reconnected host only", async () => {
      const hostContract = makeHostContract({
        listWorkers: vi.fn().mockResolvedValue([
          worker("rt-1", "workspace", "ws-deleted"),
          worker("rt-1", "workspace", "ws-alive"),
          // 其它 Host / user-scope 的 worker 不参与对账
          worker("rt-2", "workspace", "ws-deleted"),
          worker("rt-1", "user", "user-1"),
        ]),
      });
      const workspaceService = makeWorkspaceService(["ws-alive"]);
      const listener = new WorkspaceHostListener(
        hostContract,
        workspaceService
      );

      await listener.onRuntimeHostConnected(
        new RuntimeHostConnectedEvent("rt-1")
      );

      expect(workspaceService.listActiveIds).toHaveBeenCalledWith([
        "ws-deleted",
        "ws-alive",
      ]);
      expect(hostContract.releaseOwner).toHaveBeenCalledTimes(1);
      expect(hostContract.releaseOwner).toHaveBeenCalledWith({
        runtimeHostId: "rt-1",
        owner: "workspace:ws-deleted",
      });
    });

    it("skips the workspace query when the host has no workspace-scope workers", async () => {
      const hostContract = makeHostContract({
        listWorkers: vi
          .fn()
          .mockResolvedValue([worker("rt-1", "user", "user-1")]),
      });
      const workspaceService = makeWorkspaceService();
      const listener = new WorkspaceHostListener(
        hostContract,
        workspaceService
      );

      await listener.onRuntimeHostConnected(
        new RuntimeHostConnectedEvent("rt-1")
      );

      expect(workspaceService.listActiveIds).not.toHaveBeenCalled();
      expect(hostContract.releaseOwner).not.toHaveBeenCalled();
    });

    it("swallows reconcile failures (best-effort,下次重连再对账)", async () => {
      const hostContract = makeHostContract({
        listWorkers: vi.fn().mockRejectedValue(new Error("tunnel timeout")),
      });
      const listener = new WorkspaceHostListener(
        hostContract,
        makeWorkspaceService()
      );

      await expect(
        listener.onRuntimeHostConnected(new RuntimeHostConnectedEvent("rt-1"))
      ).resolves.toBeUndefined();
    });
  });
});
