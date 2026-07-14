import { describe, it, expect, vi, afterEach } from "vitest";
import type { RuntimeHostContract } from "@agework/shared/protocol";
import { RunRecoveryService } from "./run-recovery.service";
import type { RunRepository } from "../run.repository";
import type { ConversationService } from "../../conversation/conversation.service";
import type { RuntimeService } from "../../runtime/runtime.service";
import type { ConfigService } from "../../config/config.service";

function makeRuntimeHost(
  overrides: Record<string, unknown> = {}
): Partial<RuntimeHostContract> {
  return {
    sendRecoveryCancel: vi.fn().mockResolvedValue(undefined),
    releaseRun: vi.fn(),
    ...overrides,
  };
}

function makeActiveRun(input: {
  id?: string;
  runtimeType?: string;
  runtimeInstanceId?: string | null;
  runtimeHostId?: string;
}) {
  return {
    id: input.id ?? "run-1",
    conversationId: "conversation-1",
    runtimeType: input.runtimeType ?? "native",
    runtimeInstanceId: input.runtimeInstanceId ?? null,
    conversation: {
      workspace: { runtimeHostId: input.runtimeHostId ?? "builtin" },
    },
  };
}

function makeDeps(activeRuns: unknown[]) {
  const runRepository: Partial<RunRepository> = {
    findAllActive: vi.fn().mockResolvedValue(activeRuns),
    markError: vi.fn().mockResolvedValue(undefined),
  };
  const conversationService: Partial<ConversationService> = {
    setConversationRunState: vi.fn().mockResolvedValue(undefined),
  };
  const runtimeService: Partial<RuntimeService> = {
    getRuntimeHostRow: vi.fn().mockResolvedValue(null),
  };
  // check 间隔 60s;判死窗口 300s → 兜底 grace 600s(2×),
  // 保证「sweep 触发时刚断线的 run」还在 grace 内不被误杀。
  const configService: Partial<ConfigService> = {
    getHeartbeatCheckIntervalSeconds: vi.fn().mockReturnValue(60),
    getHeartbeatTimeoutSeconds: vi.fn().mockReturnValue(300),
  };
  return { runRepository, conversationService, runtimeService, configService };
}

function makeService(
  deps: ReturnType<typeof makeDeps>,
  runtimeHost: Partial<RuntimeHostContract>
) {
  return new RunRecoveryService(
    deps.runRepository as RunRepository,
    deps.conversationService as unknown as ConversationService,
    deps.runtimeService as RuntimeService,
    deps.configService as ConfigService,
    runtimeHost as RuntimeHostContract
  );
}

describe("RunRecoveryService.failInterruptedRuns", () => {
  let service: RunRecoveryService | undefined;

  afterEach(() => {
    service?.onApplicationShutdown();
    service = undefined;
    vi.useRealTimers();
  });

  it("sends a recovery cancel through the contract instead of tearing the instance down", async () => {
    const deps = makeDeps([
      makeActiveRun({
        runtimeType: "sandbox",
        runtimeInstanceId: "container-abc",
        runtimeHostId: "builtin",
      }),
    ]);
    const runtimeHost = makeRuntimeHost();
    service = makeService(deps, runtimeHost);

    await service.failInterruptedRuns();

    expect(runtimeHost.sendRecoveryCancel).toHaveBeenCalledWith({
      runId: "run-1",
      conversationId: "conversation-1",
      ref: { runtimeType: "sandbox", runtimeInstanceId: "container-abc" },
    });
    expect(deps.runRepository.markError).toHaveBeenCalledWith(
      "run-1",
      "服务重启导致运行中断"
    );
    expect(
      deps.conversationService.setConversationRunState
    ).toHaveBeenCalledWith("conversation-1", { runStatus: "error" });
  });

  it("skips the recovery cancel when a run has no persisted runtimeInstanceId", async () => {
    const deps = makeDeps([makeActiveRun({ runtimeInstanceId: null })]);
    const runtimeHost = makeRuntimeHost();
    service = makeService(deps, runtimeHost);

    await service.failInterruptedRuns();

    expect(runtimeHost.sendRecoveryCancel).not.toHaveBeenCalled();
    expect(deps.runRepository.markError).toHaveBeenCalledWith(
      "run-1",
      "服务重启导致运行中断"
    );
  });

  it("still marks the run as error when the recovery cancel rejects", async () => {
    const deps = makeDeps([
      makeActiveRun({
        runtimeType: "sandbox",
        runtimeInstanceId: "container-xyz",
        runtimeHostId: "builtin",
      }),
    ]);
    const runtimeHost = makeRuntimeHost({
      sendRecoveryCancel: vi.fn().mockRejectedValue(new Error("boom")),
    });
    service = makeService(deps, runtimeHost);

    await service.failInterruptedRuns();

    expect(deps.runRepository.markError).toHaveBeenCalledWith(
      "run-1",
      "服务重启导致运行中断"
    );
  });

  it("does not fail runs bound to a registered host (they resume via ACK 续传)", async () => {
    const deps = makeDeps([
      makeActiveRun({
        runtimeType: "docker",
        runtimeInstanceId: "container-remote",
        runtimeHostId: "rt-registered-1",
      }),
    ]);
    const runtimeHost = makeRuntimeHost();
    service = makeService(deps, runtimeHost);

    await service.failInterruptedRuns();

    expect(deps.runRepository.markError).not.toHaveBeenCalled();
    expect(runtimeHost.sendRecoveryCancel).not.toHaveBeenCalled();
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
    deps.runtimeService.getRuntimeHostRow = vi.fn().mockResolvedValue({
      status: "offline",
      lastHeartbeatAt: new Date(Date.now() - 20 * 60_000),
    });
    const runtimeHost = makeRuntimeHost();

    await runOneSweep(deps, runtimeHost);

    expect(deps.runRepository.markError).toHaveBeenCalledWith(
      "run-1",
      "Runtime Host 离线超时,运行中断"
    );
    expect(runtimeHost.releaseRun).toHaveBeenCalledWith("run-1");
  });

  it("leaves runs alone while their registered host is online", async () => {
    const deps = makeDeps([
      makeActiveRun({ runtimeHostId: "rt-registered-1" }),
    ]);
    deps.runtimeService.getRuntimeHostRow = vi.fn().mockResolvedValue({
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
    deps.runtimeService.getRuntimeHostRow = vi.fn().mockResolvedValue({
      status: "offline",
      lastHeartbeatAt: new Date(), // 刚断线,心跳还新鲜
    });

    await runOneSweep(deps, makeRuntimeHost());

    expect(deps.runRepository.markError).not.toHaveBeenCalled();
  });

  it("never sweeps managed runs (they are handled at boot)", async () => {
    const deps = makeDeps([makeActiveRun({ runtimeHostId: "builtin" })]);

    await runOneSweep(deps, makeRuntimeHost());

    expect(deps.runtimeService.getRuntimeHostRow).not.toHaveBeenCalled();
    expect(deps.runRepository.markError).not.toHaveBeenCalled();
  });
});
