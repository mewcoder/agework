import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeHostConnectedEvent } from "../../runtime-host/runtime-host.events";
import { RuntimeHostReconciliationCoordinator } from "./runtime-host-reconciliation.coordinator";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function makeCoordinator(
  overrides: {
    runs?: Record<string, unknown>;
    workspaces?: Record<string, unknown>;
    users?: Record<string, unknown>;
    runtimeHosts?: Record<string, unknown>;
    hostResources?: Record<string, unknown>;
  } = {}
) {
  const runs = {
    reconcileRuntimeHostRuns: vi.fn().mockResolvedValue(undefined),
    ...overrides.runs,
  };
  const workspaces = {
    reconcileRuntimeHostResources: vi.fn().mockResolvedValue(undefined),
    ...overrides.workspaces,
  };
  const users = {
    reconcileRuntimeHostResources: vi.fn().mockResolvedValue(undefined),
    ...overrides.users,
  };
  const runtimeHosts = {
    isCurrentReconciliationEpoch: vi.fn().mockReturnValue(true),
    markReconciled: vi.fn().mockReturnValue(true),
    markReconcileFailed: vi.fn().mockReturnValue(true),
    listLifecycleClaims: vi.fn().mockResolvedValue([]),
    ...overrides.hostResources,
    ...overrides.runtimeHosts,
  };
  const coordinator = new RuntimeHostReconciliationCoordinator(
    runs as never,
    workspaces as never,
    users as never,
    runtimeHosts as never
  );
  const hostResources = runtimeHosts;
  return { coordinator, runs, workspaces, users, runtimeHosts, hostResources };
}

describe("RuntimeHostReconciliationCoordinator", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("awaits run then one claims read then workspace and user before ready", async () => {
    const gate = deferred();
    const order: string[] = [];
    const deps = makeCoordinator({
      runs: {
        reconcileRuntimeHostRuns: vi.fn(async () => {
          order.push("run");
          await gate.promise;
        }),
      },
      hostResources: {
        listLifecycleClaims: vi.fn(async () => {
          order.push("claims");
          return [];
        }),
      },
      workspaces: {
        reconcileRuntimeHostResources: vi.fn(async () => {
          order.push("workspace");
        }),
      },
      users: {
        reconcileRuntimeHostResources: vi.fn(async () => {
          order.push("user");
        }),
      },
      runtimeHosts: {
        markReconciled: vi.fn(() => {
          order.push("ready");
          return true;
        }),
      },
    });

    const pending = deps.coordinator.onRuntimeHostConnected(
      new RuntimeHostConnectedEvent("host-1", 7)
    );
    await Promise.resolve();
    expect(order).toEqual(["run"]);

    gate.resolve();
    await pending;

    expect(order).toEqual(["run", "claims", "workspace", "user", "ready"]);
    expect(deps.hostResources.listLifecycleClaims).toHaveBeenCalledTimes(1);
    expect(deps.runtimeHosts.markReconciled).toHaveBeenCalledWith("host-1", 7);
  });

  it.each([
    [
      "run",
      {
        runs: {
          reconcileRuntimeHostRuns: vi.fn().mockRejectedValue(new Error("run")),
        },
      },
    ],
    [
      "workspace",
      {
        workspaces: {
          reconcileRuntimeHostResources: vi
            .fn()
            .mockRejectedValue(new Error("workspace")),
        },
      },
    ],
    [
      "user",
      {
        users: {
          reconcileRuntimeHostResources: vi
            .fn()
            .mockRejectedValue(new Error("user")),
        },
      },
    ],
  ])(
    "keeps the host fail-closed when %s reconciliation fails",
    async (_name, overrides) => {
      const deps = makeCoordinator(overrides);
      await deps.coordinator.onRuntimeHostConnected(
        new RuntimeHostConnectedEvent("host-1", 3)
      );

      expect(deps.runtimeHosts.markReconcileFailed).toHaveBeenCalledWith(
        "host-1",
        3
      );
      expect(deps.runtimeHosts.markReconciled).not.toHaveBeenCalled();
      deps.coordinator.onApplicationShutdown();
    }
  );

  it("reruns the complete attempt on the same connection after failure", async () => {
    vi.useFakeTimers();
    const reconcileWorkspace = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient release_pending failure"))
      .mockResolvedValue(undefined);
    const deps = makeCoordinator({
      workspaces: { reconcileRuntimeHostResources: reconcileWorkspace },
    });

    await deps.coordinator.onRuntimeHostConnected(
      new RuntimeHostConnectedEvent("host-1", 4)
    );
    await vi.advanceTimersByTimeAsync(2_000);

    expect(deps.runs.reconcileRuntimeHostRuns).toHaveBeenCalledTimes(2);
    expect(deps.hostResources.listLifecycleClaims).toHaveBeenCalledTimes(2);
    expect(reconcileWorkspace).toHaveBeenCalledTimes(2);
    expect(deps.runtimeHosts.markReconciled).toHaveBeenCalledWith("host-1", 4);
    deps.coordinator.onApplicationShutdown();
  });

  it("does not let an old epoch finishing late affect a quick reconnect", async () => {
    let currentEpoch = 1;
    const first = deferred();
    const reconcileRuns = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(undefined);
    const deps = makeCoordinator({
      runs: { reconcileRuntimeHostRuns: reconcileRuns },
      runtimeHosts: {
        isCurrentReconciliationEpoch: vi.fn(
          (_hostId: string, epoch: number) => epoch === currentEpoch
        ),
      },
    });

    const oldAttempt = deps.coordinator.onRuntimeHostConnected(
      new RuntimeHostConnectedEvent("host-1", 1)
    );
    currentEpoch = 2;
    await deps.coordinator.onRuntimeHostConnected(
      new RuntimeHostConnectedEvent("host-1", 2)
    );
    first.resolve();
    await oldAttempt;

    expect(deps.runtimeHosts.markReconciled).toHaveBeenCalledTimes(1);
    expect(deps.runtimeHosts.markReconciled).toHaveBeenCalledWith("host-1", 2);
    expect(deps.hostResources.listLifecycleClaims).toHaveBeenCalledTimes(1);
  });
});
