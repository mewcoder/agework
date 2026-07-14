import { describe, expect, it, vi } from "vitest";
import type { RuntimeHostContract } from "@agework/shared/protocol";
import type { WorkspaceService } from "../../workspace/workspace.service";
import type { UserService } from "../../user/user.service";
import { WorkspaceDeletedEvent } from "../../workspace/workspace.events";
import { UserDisabledEvent } from "../../user/user.events";
import { RuntimeHostConnectedEvent } from "../../runtime/runtime.events";
import { OwnerHostListener } from "./owner-host.listener";

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

function makeUserService(activeIds: string[] = []) {
  return {
    listActiveIds: vi.fn().mockResolvedValue(activeIds),
  } as unknown as UserService;
}

function makeListener(
  hostContract: RuntimeHostContract,
  workspaceService = makeWorkspaceService(),
  userService = makeUserService()
) {
  return new OwnerHostListener(
    hostContract,
    hostContract,
    workspaceService,
    userService
  );
}

function worker(
  runtimeHostId: string,
  scope: string,
  ownerId: string
): Record<string, unknown> {
  return { runtimeHostId, scope, ownerId };
}

describe("OwnerHostListener", () => {
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
    it("releases workers of deleted workspaces on the reconnected host only", async () => {
      const hostContract = makeHostContract({
        listWorkers: vi.fn().mockResolvedValue([
          worker("rt-1", "workspace", "ws-deleted"),
          worker("rt-1", "workspace", "ws-alive"),
          // 其它 Host 的 worker 不参与对账
          worker("rt-2", "workspace", "ws-deleted"),
        ]),
      });
      const workspaceService = makeWorkspaceService(["ws-alive"]);
      const listener = makeListener(hostContract, workspaceService);

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

    it("releases user-scope workers of deactivated users", async () => {
      const hostContract = makeHostContract({
        listWorkers: vi
          .fn()
          .mockResolvedValue([
            worker("rt-1", "user", "user-disabled"),
            worker("rt-1", "user", "user-alive"),
          ]),
      });
      const userService = makeUserService(["user-alive"]);
      const listener = makeListener(
        hostContract,
        makeWorkspaceService(),
        userService
      );

      await listener.onRuntimeHostConnected(
        new RuntimeHostConnectedEvent("rt-1")
      );

      expect(userService.listActiveIds).toHaveBeenCalledWith([
        "user-disabled",
        "user-alive",
      ]);
      expect(hostContract.releaseOwner).toHaveBeenCalledTimes(1);
      expect(hostContract.releaseOwner).toHaveBeenCalledWith({
        runtimeHostId: "rt-1",
        owner: "user:user-disabled",
      });
    });

    it("skips owner queries when the host has no workers", async () => {
      const hostContract = makeHostContract();
      const workspaceService = makeWorkspaceService();
      const userService = makeUserService();
      const listener = makeListener(
        hostContract,
        workspaceService,
        userService
      );

      await listener.onRuntimeHostConnected(
        new RuntimeHostConnectedEvent("rt-1")
      );

      expect(workspaceService.listActiveIds).not.toHaveBeenCalled();
      expect(userService.listActiveIds).not.toHaveBeenCalled();
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
