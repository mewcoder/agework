import { describe, it, expect, vi, afterEach } from "vitest";
import type { RuntimeHostContract } from "@agework/shared/protocol";
import { RunRecoveryService } from "./run-recovery.service";
import type { RunRepository } from "../run.repository";
import type { RunStatusService } from "../status/run-status.service";
import type { RuntimeHostService } from "../../runtime-host/runtime-host.service";
import type { ConfigService } from "../../config/config.service";

function makeRuntimeHost(
  overrides: Record<string, unknown> = {}
): Partial<RuntimeHostContract> {
  return {
    command: vi.fn().mockResolvedValue(undefined),
    releaseRun: vi.fn(),
    ...overrides,
  };
}

function makeActiveRun(input: { id?: string; runtimeHostId?: string }) {
  return {
    id: input.id ?? "run-1",
    conversationId: "conversation-1",
    conversation: {
      workspace: { runtimeHostId: input.runtimeHostId ?? "builtin" },
    },
  };
}

function makeDeps(activeRuns: unknown[]) {
  const runRepository: Partial<RunRepository> = {
    listActive: vi.fn().mockResolvedValue(activeRuns),
    findRuntimeReconciliationRows: vi.fn().mockResolvedValue([]),
    findRunningConversationsWithoutActiveRun: vi.fn().mockResolvedValue([]),
  };
  const runStatusService: Partial<RunStatusService> = {
    failRun: vi.fn().mockResolvedValue(undefined),
    reconcileConversationRunStatus: vi.fn().mockResolvedValue(undefined),
  };
  const runtimeHostService: Partial<RuntimeHostService> = {
    getRuntimeHostRow: vi.fn().mockResolvedValue(null),
    listRunIds: vi.fn().mockResolvedValue([]),
  };
  // check 间隔 60s;判死窗口 300s → 兜底 grace 600s(2×),
  // 保证「sweep 触发时刚断线的 run」还在 grace 内不被误杀。
  const configService: Partial<ConfigService> = {
    getHeartbeatCheckIntervalSeconds: vi.fn().mockReturnValue(60),
    getHeartbeatTimeoutSeconds: vi.fn().mockReturnValue(300),
  };
  return {
    runRepository,
    runStatusService,
    runtimeHostService,
    configService,
  };
}

function makeService(
  deps: ReturnType<typeof makeDeps>,
  runtimeHost: Partial<RuntimeHostContract>,
  runtimeHostServiceOverrides: Partial<RuntimeHostService> = {}
) {
  Object.assign(deps.runtimeHostService, runtimeHostServiceOverrides);
  return new RunRecoveryService(
    deps.runRepository as RunRepository,
    deps.runStatusService as RunStatusService,
    deps.runtimeHostService as RuntimeHostService,
    deps.configService as ConfigService,
    runtimeHost as RuntimeHostContract,
    { setRunReapPort: vi.fn() }
  );
}

describe("RunRecoveryService.failInterruptedRuns", () => {
  let service: RunRecoveryService | undefined;

  afterEach(() => {
    service?.onApplicationShutdown();
    service = undefined;
    vi.useRealTimers();
  });

  it("fails builtin runs without retaining execution-instance recovery state", async () => {
    const deps = makeDeps([makeActiveRun({ runtimeHostId: "builtin" })]);
    const runtimeHost = makeRuntimeHost();
    service = makeService(deps, runtimeHost);

    await service.failInterruptedRuns();

    expect(deps.runStatusService.failRun).toHaveBeenCalledWith({
      runId: "run-1",
      conversationId: "conversation-1",
      error: "服务重启导致运行中断",
    });
  });

  it("fails registered-host runs and cancels their stale remote sessions", async () => {
    const deps = makeDeps([
      makeActiveRun({
        runtimeHostId: "rt-registered-1",
      }),
    ]);
    const runtimeHost = makeRuntimeHost();
    service = makeService(deps, runtimeHost);

    await service.failInterruptedRuns();

    expect(deps.runStatusService.failRun).toHaveBeenCalledWith({
      runId: "run-1",
      conversationId: "conversation-1",
      error: "服务重启导致运行中断",
    });
    expect(runtimeHost.command).toHaveBeenCalledWith({
      runtimeHostId: "rt-registered-1",
      payload: expect.objectContaining({
        type: "cancel",
        runId: "run-1",
        conversationId: "conversation-1",
      }),
    });
    expect(runtimeHost.releaseRun).toHaveBeenCalledWith({
      runtimeHostId: "rt-registered-1",
      runId: "run-1",
    });
  });

  it("repairs stale Conversation projections before recovering active runs", async () => {
    const deps = makeDeps([]);
    deps.runRepository.findRunningConversationsWithoutActiveRun = vi
      .fn()
      .mockResolvedValue([
        { id: "conversation-finished", runs: [{ status: "finished" }] },
        { id: "conversation-cancelled", runs: [{ status: "cancelled" }] },
        { id: "conversation-error", runs: [{ status: "error" }] },
        { id: "conversation-no-run", runs: [] },
      ]);
    service = makeService(deps, makeRuntimeHost());

    await service.failInterruptedRuns();

    expect(
      deps.runStatusService.reconcileConversationRunStatus
    ).toHaveBeenCalledWith({
      conversationId: "conversation-finished",
      runStatus: "idle",
    });
    expect(
      deps.runStatusService.reconcileConversationRunStatus
    ).toHaveBeenCalledWith({
      conversationId: "conversation-cancelled",
      runStatus: "idle",
    });
    expect(
      deps.runStatusService.reconcileConversationRunStatus
    ).toHaveBeenCalledWith({
      conversationId: "conversation-error",
      runStatus: "error",
    });
    expect(
      deps.runStatusService.reconcileConversationRunStatus
    ).toHaveBeenCalledWith({
      conversationId: "conversation-no-run",
      runStatus: "error",
    });
  });

  it("retries remote cleanup when the coordinator runs reconciliation", async () => {
    const deps = makeDeps([
      makeActiveRun({ runtimeHostId: "rt-registered-1" }),
    ]);
    const command = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    const runtimeHost = makeRuntimeHost({ command });
    deps.runRepository.findRuntimeReconciliationRows = vi
      .fn()
      .mockResolvedValue([
        {
          id: "run-1",
          conversationId: "conversation-1",
          status: "error",
        },
      ]);
    service = makeService(deps, runtimeHost, {
      listRunIds: vi.fn().mockResolvedValue(["run-1"]),
    });

    await service.failInterruptedRuns();
    expect(runtimeHost.releaseRun).not.toHaveBeenCalled();

    await service.reconcileRuntimeHost("rt-registered-1");

    expect(command).toHaveBeenCalledTimes(2);
    expect(runtimeHost.releaseRun).toHaveBeenCalledWith({
      runtimeHostId: "rt-registered-1",
      runId: "run-1",
    });
  });

  it("reconciles a terminal Host run after another Server restart lost cleanup memory", async () => {
    const deps = makeDeps([]);
    deps.runRepository.findRuntimeReconciliationRows = vi
      .fn()
      .mockResolvedValue([
        {
          id: "run-stale",
          conversationId: "conversation-stale",
          status: "error",
        },
      ]);
    const runtimeHost = makeRuntimeHost();
    service = makeService(deps, runtimeHost, {
      listRunIds: vi.fn().mockResolvedValue(["run-stale"]),
    });

    await service.reconcileRuntimeHost("rt-registered-1");

    expect(runtimeHost.command).toHaveBeenCalledWith({
      runtimeHostId: "rt-registered-1",
      payload: expect.objectContaining({
        type: "cancel",
        runId: "run-stale",
        conversationId: "conversation-stale",
      }),
    });
    expect(runtimeHost.releaseRun).toHaveBeenCalledWith({
      runtimeHostId: "rt-registered-1",
      runId: "run-stale",
    });
  });

  it("leaves a Host run alone while its database row is still active", async () => {
    const deps = makeDeps([]);
    deps.runRepository.findRuntimeReconciliationRows = vi
      .fn()
      .mockResolvedValue([
        {
          id: "run-active",
          conversationId: "conversation-active",
          status: "running",
        },
      ]);
    const runtimeHost = makeRuntimeHost();
    service = makeService(deps, runtimeHost, {
      listRunIds: vi.fn().mockResolvedValue(["run-active"]),
    });

    await service.reconcileRuntimeHost("rt-registered-1");

    expect(runtimeHost.command).not.toHaveBeenCalled();
    expect(runtimeHost.releaseRun).not.toHaveBeenCalled();
  });

  it("rejects bootstrap recovery when the core run status write fails", async () => {
    const deps = makeDeps([makeActiveRun({ runtimeHostId: "builtin" })]);
    deps.runStatusService.failRun = vi
      .fn()
      .mockRejectedValue(new Error("database unavailable"));
    service = makeService(deps, makeRuntimeHost());

    await expect(service.failInterruptedRuns()).rejects.toThrow(
      "database unavailable"
    );
  });
});

describe("RunRecoveryService abandoned-host sweep", () => {
  let service: RunRecoveryService | undefined;

  afterEach(() => {
    service?.onApplicationShutdown();
    service = undefined;
    vi.useRealTimers();
  });

  async function runOneSweep(
    deps: ReturnType<typeof makeDeps>,
    runtimeHost: Partial<RuntimeHostContract>
  ) {
    vi.useFakeTimers();
    service = makeService(deps, runtimeHost);
    await service.failInterruptedRuns(); // 启动 sweep 定时器
    (deps.runStatusService.failRun as ReturnType<typeof vi.fn>).mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
  }

  it("fails runs whose registered host stayed offline beyond the grace window", async () => {
    const deps = makeDeps([
      makeActiveRun({ runtimeHostId: "rt-registered-1" }),
    ]);
    deps.runtimeHostService.getRuntimeHostRow = vi.fn().mockResolvedValue({
      status: "offline",
      lastHeartbeatAt: new Date(Date.now() - 20 * 60_000),
    });
    const runtimeHost = makeRuntimeHost();

    await runOneSweep(deps, runtimeHost);

    expect(deps.runStatusService.failRun).toHaveBeenCalledWith({
      runId: "run-1",
      conversationId: "conversation-1",
      error: "Runtime Host 离线超时,运行中断",
    });
    expect(runtimeHost.releaseRun).toHaveBeenCalledWith({
      runtimeHostId: "rt-registered-1",
      runId: "run-1",
    });
  });

  it("leaves runs alone while their registered host is online", async () => {
    const deps = makeDeps([
      makeActiveRun({ runtimeHostId: "rt-registered-1" }),
    ]);
    deps.runtimeHostService.getRuntimeHostRow = vi.fn().mockResolvedValue({
      status: "online",
      lastHeartbeatAt: new Date(),
    });

    await runOneSweep(deps, makeRuntimeHost());

    expect(deps.runStatusService.failRun).not.toHaveBeenCalled();
  });

  it("leaves runs alone during the grace window right after a disconnect", async () => {
    const deps = makeDeps([
      makeActiveRun({ runtimeHostId: "rt-registered-1" }),
    ]);
    deps.runtimeHostService.getRuntimeHostRow = vi.fn().mockResolvedValue({
      status: "offline",
      lastHeartbeatAt: new Date(), // 刚断线,心跳还新鲜
    });

    await runOneSweep(deps, makeRuntimeHost());

    expect(deps.runStatusService.failRun).not.toHaveBeenCalled();
  });

  it("never sweeps builtin Host runs (they are handled at boot)", async () => {
    const deps = makeDeps([makeActiveRun({ runtimeHostId: "builtin" })]);

    await runOneSweep(deps, makeRuntimeHost());

    expect(deps.runtimeHostService.getRuntimeHostRow).not.toHaveBeenCalled();
    expect(deps.runStatusService.failRun).not.toHaveBeenCalled();
  });
});
