import { describe, expect, it, vi } from "vitest";
import type { RuntimeHostContract } from "@agework/shared/protocol";
import type { WorkspaceRepository } from "../workspace.repository";
import { WorkspaceDeletedEvent } from "../workspace.events";
import { RuntimeHostConnectedEvent } from "../../runtime-host/runtime-host.events";
import { WorkspaceOwnerReleaseListener } from "./workspace-owner-release.listener";

function makeHostContract(overrides: Record<string, unknown> = {}) {
  return {
    releaseOwner: vi.fn().mockResolvedValue(undefined),
    listWorkers: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as RuntimeHostContract;
}

function makeRepository(activeIds: string[] = []) {
  return {
    listActiveIds: vi.fn().mockResolvedValue(activeIds),
  } as unknown as WorkspaceRepository;
}

function makeListener(
  hostContract: RuntimeHostContract,
  repository = makeRepository()
) {
  return new WorkspaceOwnerReleaseListener(
    hostContract,
    hostContract,
    repository
  );
}

function worker(
  runtimeHostId: string,
  scope: string,
  ownerId: string
): Record<string, unknown> {
  return { runtimeHostId, scope, ownerId };
}

describe("WorkspaceOwnerReleaseListener", () => {
  it("releases only the deleted workspace owner on its configured host", async () => {
    const hostContract = makeHostContract();
    const listener = makeListener(hostContract);

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
    it("releases workers of deleted workspaces on the reconnected host only", async () => {
      const hostContract = makeHostContract({
        listWorkers: vi.fn().mockResolvedValue([
          worker("rt-1", "workspace", "ws-deleted"),
          worker("rt-1", "workspace", "ws-alive"),
          // 其它 Host 的 worker、user-scope worker 都不参与对账
          worker("rt-2", "workspace", "ws-deleted"),
          worker("rt-1", "user", "user-1"),
        ]),
      });
      const repository = makeRepository(["ws-alive"]);
      const listener = makeListener(hostContract, repository);

      await listener.onRuntimeHostConnected(
        new RuntimeHostConnectedEvent("rt-1")
      );

      expect(repository.listActiveIds).toHaveBeenCalledWith([
        "ws-deleted",
        "ws-alive",
      ]);
      expect(hostContract.releaseOwner).toHaveBeenCalledTimes(1);
      expect(hostContract.releaseOwner).toHaveBeenCalledWith({
        runtimeHostId: "rt-1",
        owner: "workspace:ws-deleted",
      });
    });

    it("skips owner queries when the host has no workspace workers", async () => {
      const hostContract = makeHostContract();
      const repository = makeRepository();
      const listener = makeListener(hostContract, repository);

      await listener.onRuntimeHostConnected(
        new RuntimeHostConnectedEvent("rt-1")
      );

      expect(repository.listActiveIds).not.toHaveBeenCalled();
      expect(hostContract.releaseOwner).not.toHaveBeenCalled();
    });

    it("swallows reconcile failures (best-effort,下次重连再对账)", async () => {
      const hostContract = makeHostContract({
        listWorkers: vi.fn().mockRejectedValue(new Error("tunnel timeout")),
      });
      const listener = makeListener(hostContract);

      await expect(
        listener.onRuntimeHostConnected(new RuntimeHostConnectedEvent("rt-1"))
      ).resolves.toBeUndefined();
    });
  });
});
