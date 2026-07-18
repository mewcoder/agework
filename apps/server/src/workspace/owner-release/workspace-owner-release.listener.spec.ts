import { describe, expect, it, vi } from "vitest";
import type { WorkspaceRepository } from "../workspace.repository";
import { RuntimeHostConnectedEvent } from "../../runtime-host/runtime-host.events";
import type { RuntimeHostOwnerReconciliation } from "../../runtime-host/runtime-host.types";
import { WorkspaceOwnerReleaseListener } from "./workspace-owner-release.listener";

function makeOwnerReconciliation(overrides: Record<string, unknown> = {}) {
  return {
    releaseOwner: vi.fn().mockResolvedValue(undefined),
    listOwners: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as RuntimeHostOwnerReconciliation;
}

function makeRepository(activeIds: string[] = []) {
  return {
    listActiveIds: vi.fn().mockResolvedValue(activeIds),
  } as unknown as WorkspaceRepository;
}

function makeListener(
  hostOwners: RuntimeHostOwnerReconciliation,
  repository = makeRepository()
) {
  return new WorkspaceOwnerReleaseListener(hostOwners, repository);
}

function worker(
  runtimeHostId: string,
  scope: string,
  ownerId: string
): Record<string, unknown> {
  return { runtimeHostId, owner: `${scope}:${ownerId}` };
}

describe("WorkspaceOwnerReleaseListener", () => {
  describe("重连对账", () => {
    it("releases workers of deleted workspaces on the reconnected host only", async () => {
      const hostOwners = makeOwnerReconciliation({
        listOwners: vi.fn().mockResolvedValue([
          worker("rt-1", "workspace", "ws-deleted"),
          worker("rt-1", "workspace", "ws-alive"),
          // 其它 Host 的 worker、user-scope worker 都不参与对账
          worker("rt-2", "workspace", "ws-deleted"),
          worker("rt-1", "user", "user-1"),
        ]),
      });
      const repository = makeRepository(["ws-alive"]);
      const listener = makeListener(hostOwners, repository);

      await listener.onRuntimeHostConnected(
        new RuntimeHostConnectedEvent("rt-1")
      );

      expect(repository.listActiveIds).toHaveBeenCalledWith([
        "ws-deleted",
        "ws-alive",
      ]);
      expect(hostOwners.listOwners).toHaveBeenCalledWith("rt-1");
      expect(hostOwners.releaseOwner).toHaveBeenCalledTimes(1);
      expect(hostOwners.releaseOwner).toHaveBeenCalledWith({
        runtimeHostId: "rt-1",
        owner: "workspace:ws-deleted",
      });
    });

    it("skips owner queries when the host has no workspace workers", async () => {
      const hostOwners = makeOwnerReconciliation();
      const repository = makeRepository();
      const listener = makeListener(hostOwners, repository);

      await listener.onRuntimeHostConnected(
        new RuntimeHostConnectedEvent("rt-1")
      );

      expect(repository.listActiveIds).not.toHaveBeenCalled();
      expect(hostOwners.releaseOwner).not.toHaveBeenCalled();
    });

    it("swallows reconcile failures (best-effort,下次重连再对账)", async () => {
      const hostOwners = makeOwnerReconciliation({
        listOwners: vi.fn().mockRejectedValue(new Error("tunnel timeout")),
      });
      const listener = makeListener(hostOwners);

      await expect(
        listener.onRuntimeHostConnected(new RuntimeHostConnectedEvent("rt-1"))
      ).resolves.toBeUndefined();
    });
  });
});
