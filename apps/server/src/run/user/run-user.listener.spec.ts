import { describe, expect, it, vi } from "vitest";
import type { RuntimeHostResourceReconciliationPort } from "../../runtime-host/runtime-host.types";
import type { RunService } from "../run.service";
import { UserDisabledEvent, UserDeletedEvent } from "../../user/user.events";
import { RunUserListener } from "./run-user.listener";

function makeHostResources(overrides: Record<string, unknown> = {}) {
  return {
    listLifecycleClaims: vi.fn().mockResolvedValue([]),
    listConnectedHostIds: vi.fn().mockReturnValue(["builtin"]),
    releaseResources: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as RuntimeHostResourceReconciliationPort;
}

function makeDeps(
  overrides: {
    stopForUser?: ReturnType<typeof vi.fn>;
    releaseResources?: ReturnType<typeof vi.fn>;
    listConnectedHostIds?: ReturnType<typeof vi.fn>;
  } = {}
) {
  const stopForUser =
    overrides.stopForUser ?? vi.fn().mockResolvedValue(undefined);
  const hostResources = makeHostResources({
    ...(overrides.releaseResources && { releaseResources: overrides.releaseResources }),
    ...(overrides.listConnectedHostIds && { listConnectedHostIds: overrides.listConnectedHostIds }),
  });
  const listener = new RunUserListener(
    { stopForUser } as unknown as RunService,
    hostResources
  );
  return { listener, stopForUser, hostResources };
}

describe("RunUserListener", () => {
  it("stops active runs before releasing user resources", async () => {
    const order: string[] = [];
    const { listener, hostResources } = makeDeps({
      stopForUser: vi.fn(async () => {
        order.push("stop");
      }),
      releaseResources: vi.fn(async () => {
        order.push("release");
      }),
      listConnectedHostIds: vi
        .fn()
        .mockReturnValue(["rt-1", "rt-2"]),
    });

    await listener.onUserDeactivated(new UserDisabledEvent("user-1", 5));

    expect(order).toEqual(["stop", "release", "release"]);
    expect(hostResources.releaseResources).toHaveBeenCalledTimes(2);
    expect(hostResources.releaseResources).toHaveBeenCalledWith({
      runtimeHostId: "rt-1",
      target: { type: "user", userId: "user-1", userLifecycleVersion: 5 },
    });
    expect(hostResources.releaseResources).toHaveBeenCalledWith({
      runtimeHostId: "rt-2",
      target: { type: "user", userId: "user-1", userLifecycleVersion: 5 },
    });
  });

  it("handles UserDeletedEvent the same way", async () => {
    const { listener, hostResources } = makeDeps({
      listConnectedHostIds: vi.fn().mockReturnValue(["rt-1"]),
    });

    await listener.onUserDeactivated(new UserDeletedEvent("user-1", 3));

    expect(hostResources.releaseResources).toHaveBeenCalledWith({
      runtimeHostId: "rt-1",
      target: { type: "user", userId: "user-1", userLifecycleVersion: 3 },
    });
  });

  it("still releases resources when stopping runs fails", async () => {
    const { listener, hostResources } = makeDeps({
      stopForUser: vi.fn().mockRejectedValue(new Error("db down")),
      listConnectedHostIds: vi.fn().mockReturnValue(["rt-1"]),
    });

    await expect(
      listener.onUserDeactivated(new UserDisabledEvent("user-1", 1))
    ).resolves.toBeUndefined();

    expect(hostResources.releaseResources).toHaveBeenCalledTimes(1);
  });

  it("swallows release failures (best-effort,重连对账兜底)", async () => {
    const { listener } = makeDeps({
      listConnectedHostIds: vi.fn().mockReturnValue(["rt-1"]),
      releaseResources: vi.fn().mockRejectedValue(new Error("tunnel timeout")),
    });

    await expect(
      listener.onUserDeactivated(new UserDisabledEvent("user-1", 1))
    ).resolves.toBeUndefined();
  });

  it("sends release to ALL connected hosts (not just those with claims)", async () => {
    // P0 fix: in-flight submit may not have formed a claim yet.
    // Must send release to all connected hosts to install fence.
    const { listener, hostResources } = makeDeps({
      listConnectedHostIds: vi
        .fn()
        .mockReturnValue(["rt-1", "rt-2", "rt-3"]),
    });

    await listener.onUserDeactivated(new UserDisabledEvent("user-1", 2));

    expect(hostResources.releaseResources).toHaveBeenCalledTimes(3);
    expect(hostResources.releaseResources).toHaveBeenCalledWith({
      runtimeHostId: "rt-1",
      target: { type: "user", userId: "user-1", userLifecycleVersion: 2 },
    });
    expect(hostResources.releaseResources).toHaveBeenCalledWith({
      runtimeHostId: "rt-3",
      target: { type: "user", userId: "user-1", userLifecycleVersion: 2 },
    });
  });
});
