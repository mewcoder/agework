import { describe, expect, it, vi } from "vitest";
import type { RuntimeHostContract } from "@agework/shared/protocol";
import type { UserRepository } from "../user.repository";
import { UserDisabledEvent } from "../user.events";
import { RuntimeHostConnectedEvent } from "../../runtime-host/runtime-host.events";
import { UserOwnerReleaseListener } from "./user-owner-release.listener";

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
  } as unknown as UserRepository;
}

function makeListener(
  hostContract: RuntimeHostContract,
  repository = makeRepository()
) {
  return new UserOwnerReleaseListener(hostContract, hostContract, repository);
}

function worker(
  runtimeHostId: string,
  scope: string,
  ownerId: string
): Record<string, unknown> {
  return { runtimeHostId, scope, ownerId };
}

describe("UserOwnerReleaseListener", () => {
  describe("user 禁用/删除", () => {
    it("releases the user owner on every host that holds a user-scope worker", async () => {
      const hostContract = makeHostContract({
        listWorkers: vi.fn().mockResolvedValue([
          worker("rt-1", "user", "user-1"),
          worker("rt-2", "user", "user-1"),
          // 别人的 worker、该用户的 workspace-scope worker 都不动
          worker("rt-3", "user", "user-2"),
          worker("rt-1", "workspace", "ws-1"),
        ]),
      });
      const listener = makeListener(hostContract);

      await listener.onUserDeactivated(new UserDisabledEvent("user-1"));

      expect(hostContract.releaseOwner).toHaveBeenCalledTimes(2);
      expect(hostContract.releaseOwner).toHaveBeenCalledWith({
        runtimeHostId: "rt-1",
        owner: "user:user-1",
      });
      expect(hostContract.releaseOwner).toHaveBeenCalledWith({
        runtimeHostId: "rt-2",
        owner: "user:user-1",
      });
    });

    it("swallows failures (best-effort)", async () => {
      const hostContract = makeHostContract({
        listWorkers: vi.fn().mockRejectedValue(new Error("tunnel down")),
      });
      const listener = makeListener(hostContract);

      await expect(
        listener.onUserDeactivated(new UserDisabledEvent("user-1"))
      ).resolves.toBeUndefined();
    });
  });

  describe("重连对账", () => {
    it("releases user-scope workers of deactivated users", async () => {
      const hostContract = makeHostContract({
        listWorkers: vi
          .fn()
          .mockResolvedValue([
            worker("rt-1", "user", "user-disabled"),
            worker("rt-1", "user", "user-alive"),
          ]),
      });
      const repository = makeRepository(["user-alive"]);
      const listener = makeListener(hostContract, repository);

      await listener.onRuntimeHostConnected(
        new RuntimeHostConnectedEvent("rt-1")
      );

      expect(repository.listActiveIds).toHaveBeenCalledWith([
        "user-disabled",
        "user-alive",
      ]);
      expect(hostContract.releaseOwner).toHaveBeenCalledTimes(1);
      expect(hostContract.releaseOwner).toHaveBeenCalledWith({
        runtimeHostId: "rt-1",
        owner: "user:user-disabled",
      });
    });

    it("skips owner queries when the host has no user-scope workers", async () => {
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
