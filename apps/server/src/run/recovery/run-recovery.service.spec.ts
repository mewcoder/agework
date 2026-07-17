import { describe, it, expect, vi, afterEach } from "vitest";
import type { RuntimeHostContract } from "@agework/shared/protocol";
import { RunRecoveryService } from "./run-recovery.service";
import type { RunRepository } from "../run.repository";
import type { ConversationService } from "../../conversation/conversation.service";
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
    markError: vi.fn().mockResolvedValue(undefined),
  };
  const conversationService: Partial<ConversationService> = {
    setConversationRunState: vi.fn().mockResolvedValue(undefined),
  };
  const runtimeHostService: Partial<RuntimeHostService> = {
    getRuntimeHostRow: vi.fn().mockResolvedValue(null),
  };
  // check 间隔 60s;判死窗口 300s → 兜底 grace 600s(2×),
  // 保证「sweep 触发时刚断线的 run」还在 grace 内不被误杀。
  const configService: Partial<ConfigService> = {
    getHeartbeatCheckIntervalSeconds: vi.fn().mockReturnValue(60),
    getHeartbeatTimeoutSeconds: vi.fn().mockReturnValue(300),
  };
  return {
    runRepository,
    conversationService,
    runtimeHostService,
    configService,
  };
}

function makeService(
  deps: ReturnType<typeof makeDeps>,
  runtimeHost: Partial<RuntimeHostContract>
) {
  return new RunRecoveryService(
    deps.runRepository as RunRepository,
    deps.conversationService as unknown as ConversationService,
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

    expect(deps.runRepository.markError).toHaveBeenCalledWith(
      "run-1",
      "服务重启导致运行中断"
    );
    expect(
      deps.conversationService.setConversationRunState
    ).toHaveBeenCalledWith("conversation-1", { runStatus: "error" });
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

    expect(deps.runRepository.markError).toHaveBeenCalledWith(
      "run-1",
      "服务重启导致运行中断"
    );
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

  it("retries remote cleanup when the registered host reconnects", async () => {
    const deps = makeDeps([
      makeActiveRun({ runtimeHostId: "rt-registered-1" }),
    ]);
    const command = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    const runtimeHost = makeRuntimeHost({ command });
    service = makeService(deps, runtimeHost);

    await service.failInterruptedRuns();
    expect(runtimeHost.releaseRun).not.toHaveBeenCalled();

    await service.onRuntimeHostConnected({
      runtimeHostId: "rt-registered-1",
    });

    expect(command).toHaveBeenCalledTimes(2);
    expect(runtimeHost.releaseRun).toHaveBeenCalledWith({
      runtimeHostId: "rt-registered-1",
      runId: "run-1",
    });
  });

  it("rejects bootstrap recovery when the core run status write fails", async () => {
    const deps = makeDeps([makeActiveRun({ runtimeHostId: "builtin" })]);
    deps.runRepository.markError = vi
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
    (deps.runRepository.markError as ReturnType<typeof vi.fn>).mockClear();
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

    expect(deps.runRepository.markError).toHaveBeenCalledWith(
      "run-1",
      "Runtime Host 离线超时,运行中断"
    );
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

    expect(deps.runRepository.markError).not.toHaveBeenCalled();
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

    expect(deps.runRepository.markError).not.toHaveBeenCalled();
  });

  it("never sweeps builtin Host runs (they are handled at boot)", async () => {
    const deps = makeDeps([makeActiveRun({ runtimeHostId: "builtin" })]);

    await runOneSweep(deps, makeRuntimeHost());

    expect(deps.runtimeHostService.getRuntimeHostRow).not.toHaveBeenCalled();
    expect(deps.runRepository.markError).not.toHaveBeenCalled();
  });
});
