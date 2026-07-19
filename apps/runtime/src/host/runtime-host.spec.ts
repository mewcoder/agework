import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  RuntimeHostUpstream,
  SubmitRunInput,
} from "@agework/shared/protocol";
import { RuntimeHost, type RuntimeHostConfig } from "./runtime-host.js";
import type { WorkerPool, ReuseIdentity } from "./worker-pool.js";
import { deriveReuseIdentity } from "./worker-pool.js";
import type { CleanupLedger } from "./cleanup-ledger.js";

const IDENTITY_WS: ReuseIdentity = {
  scope: "workspace",
  subjectId: "ws-1",
  runtimeType: "native",
};

function makeUpstream() {
  return {
    emit: vi.fn().mockResolvedValue(undefined),
    notifyRunFailed: vi.fn().mockResolvedValue(undefined),
    notifyRunCancelled: vi.fn().mockResolvedValue(undefined),
    notifyWorkerLost: vi.fn().mockResolvedValue(undefined),
  } satisfies RuntimeHostUpstream;
}

function makeConfig(
  overrides: Partial<RuntimeHostConfig> = {}
): RuntimeHostConfig {
  return {
    runtimeLogDir: "/tmp/agework-host-test/logs",
    getUserWorkspace: (username) => `/tmp/agework-host-test/users/${username}`,
    launchTimeoutMs: 5_000,
    heartbeatTimeoutMs: 60_000,
    agentEventTrace: { enabled: false, maxFileMb: 5 },
    cliInstallDir: "/tmp/agework-host-test/cli",
    capabilities: {
      native: { available: true, scopes: ["workspace"] },
    },
    providerConfig: {
      workerImage: "",
      runtimeLogHostPath: "/tmp/agework-host-test/logs",
      workerApiBaseUrl: "http://127.0.0.1:7101/api/v1",
      native: { runtimeEntryPath: "/tmp/agework-host-test/main.mjs" },
    },
    ...overrides,
  };
}

function makeSubmitInput(
  runId: string,
  workspaceId: string = "ws-1"
): SubmitRunInput {
  return {
    runId,
    conversationId: `conversation-${workspaceId}`,
    placement: {
      scope: "workspace",
      runtimeType: "native",
      runtimeHostId: "builtin",
      workspaceId,
      userId: "user-1",
      userLifecycleVersion: 1,
      username: "admin-1",
      workspacePath: `/tmp/agework-host-test/${workspaceId}`,
    },
    agentProviderConfig: { agentType: "claude", source: "system" },
    input: { messages: [{ id: "msg-1" }] },
  };
}

/** 用可控的假 provider 替掉真实 provider 分发(私有字段,测试专用注入)。 */
function injectProvider(
  host: RuntimeHost,
  start: ReturnType<typeof vi.fn>,
  stop: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined),
  destroy: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined)
) {
  (host as unknown as { resolveProvider: unknown }).resolveProvider = () => ({
    type: "native",
    start,
    release: destroy,
    stop,
    destroy,
  });
  return { start, stop, destroy };
}

function poolOf(host: RuntimeHost): WorkerPool {
  return (host as unknown as { pool: WorkerPool }).pool;
}

function cleanupLedgerOf(host: RuntimeHost): CleanupLedger {
  return (host as unknown as { cleanupLedger: CleanupLedger }).cleanupLedger;
}

function sweepOf(host: RuntimeHost): Promise<void> {
  return (
    host as unknown as { sweepFence: () => Promise<void> }
  ).sweepFence();
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** 提交 run 并完成握手,返回 workerId。 */
async function submitAndHandshake(
  host: RuntimeHost,
  runId: string
): Promise<string> {
  await host.submitRun(makeSubmitInput(runId));
  await settle();
  const entry = poolOf(host).getByIdentity(IDENTITY_WS, 1)!;
  expect(
    host.registerWorker(entry.workerId, entry.startToken, { pid: 1 })
  ).toBe(true);
  await settle();
  return entry.workerId;
}

describe("RuntimeHost", () => {
  let host: RuntimeHost;
  let upstream: ReturnType<typeof makeUpstream>;

  beforeEach(() => {
    host = new RuntimeHost(makeConfig());
    upstream = makeUpstream();
    host.setUpstream(upstream);
  });

  afterEach(() => {
    host.drain();
  });

  it("rejects a runtimeType not advertised as available by this Host", async () => {
    const start = vi.fn();
    injectProvider(host, start);
    const input = makeSubmitInput("run-1");
    input.placement.runtimeType = "docker";

    await expect(host.submitRun(input)).rejects.toThrow(
      "runtimeType docker is not available on this Host"
    );
    expect(start).not.toHaveBeenCalled();
  });

  it("rejects a scope outside the Host capability", async () => {
    const start = vi.fn();
    injectProvider(host, start);
    const input = makeSubmitInput("run-1");
    input.placement.scope = "user";

    await expect(host.submitRun(input)).rejects.toThrow(
      "runtimeType native does not support user scope on this Host"
    );
    expect(start).not.toHaveBeenCalled();
  });

  it("admits by the refreshed capability matrix, not the startup snapshot", async () => {
    vi.useFakeTimers();
    try {
      const refreshed = {
        native: {
          available: false,
          reason: "probe says down",
          scopes: ["workspace"],
        },
      };
      const refreshedHost = new RuntimeHost(
        makeConfig({
          refreshCapabilities: vi.fn().mockResolvedValue(refreshed),
          capabilityRefreshMs: 1_000,
        })
      );
      refreshedHost.setUpstream(makeUpstream());
      try {
        await vi.advanceTimersByTimeAsync(1_000);

        expect(refreshedHost.getCapabilities()).toEqual(refreshed);
        await expect(
          refreshedHost.submitRun(makeSubmitInput("run-refresh"))
        ).rejects.toThrow(
          "runtimeType native is not available on this Host: probe says down"
        );
      } finally {
        refreshedHost.drain();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the last capability matrix when a refresh probe fails", async () => {
    vi.useFakeTimers();
    try {
      const config = makeConfig({
        refreshCapabilities: vi.fn().mockRejectedValue(new Error("probe io")),
        capabilityRefreshMs: 1_000,
      });
      const refreshedHost = new RuntimeHost(config);
      try {
        await vi.advanceTimersByTimeAsync(2_000);

        expect(refreshedHost.getCapabilities()).toEqual(config.capabilities);
      } finally {
        refreshedHost.drain();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("launches a worker, handshakes, then dispatches the first user_message", async () => {
    injectProvider(
      host,
      vi.fn().mockResolvedValue({ runtimeInstanceId: "inst-1" })
    );

    const workerId = await submitAndHandshake(host, "run-1");

    const { commands } = await host.pollCommands(workerId, { afterSeq: 0 });
    expect(commands.map((c) => c.payload.type)).toEqual(["user_message"]);
    expect(host.getRunConfig(workerId, "run-1")).toMatchObject({
      runId: "run-1",
    });
    expect(await host.listWorkers()).toEqual([
      expect.objectContaining({ workerId, runIds: ["run-1"] }),
    ]);
  });

  it("builds a RunConfig for a run that reuses an existing worker(复用路径)", async () => {
    injectProvider(
      host,
      vi.fn().mockResolvedValue({ runtimeInstanceId: "inst-1" })
    );
    const workerId = await submitAndHandshake(host, "run-1");

    await host.submitRun(makeSubmitInput("run-2"));
    await settle();

    // 复用同一 worker,run-2 也必须能拉到自己的 RunConfig(曾经的缺口)
    expect(host.getRunConfig(workerId, "run-2")).toMatchObject({
      runId: "run-2",
    });
    const { commands } = await host.pollCommands(workerId, { afterSeq: 0 });
    expect(
      commands.filter((c) => c.payload.type === "user_message")
    ).toHaveLength(2);
  });

  it("shares one in-flight worker launch between concurrent runs for the same ReuseIdentity", async () => {
    const start = vi
      .fn()
      .mockResolvedValue({ runtimeInstanceId: "inst-1" });
    injectProvider(host, start);

    await host.submitRun(makeSubmitInput("run-1"));
    await host.submitRun(makeSubmitInput("run-2"));
    await settle();

    expect(start).toHaveBeenCalledTimes(1);

    const entry = poolOf(host).getByIdentity(IDENTITY_WS, 1)!;
    expect(host.registerWorker(entry.workerId, entry.startToken, {})).toBe(true);
    await settle();

    expect(await host.listWorkers()).toEqual([
      expect.objectContaining({ runIds: ["run-1", "run-2"] }),
    ]);
    const { commands } = await host.pollCommands(entry.workerId, {
      afterSeq: 0,
    });
    expect(
      commands.filter((command) => command.payload.type === "user_message")
    ).toHaveLength(2);
  });

  it("accepts concurrent submissions of the same runId exactly once", async () => {
    const start = vi
      .fn()
      .mockResolvedValue({ runtimeInstanceId: "inst-1" });
    injectProvider(host, start);

    await Promise.all([
      host.submitRun(makeSubmitInput("run-1")),
      host.submitRun(makeSubmitInput("run-1")),
    ]);
    await settle();

    expect(start).toHaveBeenCalledTimes(1);
    const entry = poolOf(host).getByIdentity(IDENTITY_WS, 1)!;
    expect(host.registerWorker(entry.workerId, entry.startToken, {})).toBe(true);
    await settle();

    const { commands } = await host.pollCommands(entry.workerId, {
      afterSeq: 0,
    });
    expect(
      commands.filter((command) => command.payload.type === "user_message")
    ).toHaveLength(1);
  });

  it("does not launch after releaseRun wins the RunConfig preparation race", async () => {
    let resolveCliPaths!: () => void;
    const configGate = new Promise<void>((resolve) => {
      resolveCliPaths = resolve;
    });
    const racingHost = new RuntimeHost(
      makeConfig({
        resolveCliPaths: async () => {
          await configGate;
          return { claude: null, codex: null, opencode: null, pi: null };
        },
      })
    );
    racingHost.setUpstream(upstream);
    const start = vi
      .fn()
      .mockResolvedValue({ runtimeInstanceId: "inst-too-late" });
    injectProvider(racingHost, start);

    const submission = racingHost.submitRun(makeSubmitInput("run-race"));
    await racingHost.command({
      runtimeHostId: "builtin",
      payload: {
        type: "cancel",
        commandId: "cmd-timeout",
        runId: "run-race",
        conversationId: "conversation-ws-1",
      },
    });
    racingHost.releaseRun({ runtimeHostId: "builtin", runId: "run-race" });

    resolveCliPaths();
    await submission;
    await settle();

    expect(start).not.toHaveBeenCalled();
    expect(await racingHost.listWorkers()).toEqual([]);
    racingHost.drain();
  });

  it("absorbs a cancel that arrives before the worker is ready", async () => {
    let resolveStart!: (value: { runtimeInstanceId: string }) => void;
    injectProvider(
      host,
      vi.fn().mockReturnValue(
        new Promise((resolve) => {
          resolveStart = resolve;
        })
      )
    );

    await host.submitRun(makeSubmitInput("run-1"));
    await host.command({
      runtimeHostId: "builtin",
      payload: {
        type: "cancel",
        commandId: "cmd-1",
        runId: "run-1",
        conversationId: "conversation-1",
      },
    });

    // worker 就绪:cancel 转 cancelled 终态,不开会话
    resolveStart({ runtimeInstanceId: "inst-1" });
    await settle();
    const entry = poolOf(host).getByIdentity(IDENTITY_WS, 1)!;
    host.registerWorker(entry.workerId, entry.startToken, {});
    await settle();

    expect(upstream.notifyRunCancelled).toHaveBeenCalledWith("run-1");
    const { commands } = await host.pollCommands(entry.workerId, {
      afterSeq: 0,
    });
    expect(commands).toEqual([]);
  });

  it("reports launch failures upstream and clears the run state", async () => {
    injectProvider(host, vi.fn().mockRejectedValue(new Error("docker down")));

    await host.submitRun(makeSubmitInput("run-1"));
    await settle();

    await vi.waitFor(() => {
      expect(upstream.notifyRunFailed).toHaveBeenCalledWith(
        "run-1",
        expect.stringContaining("docker down")
      );
    });
    expect(await host.listWorkers()).toEqual([]);
  });

  it("destroys a launched runtime when registration times out", async () => {
    vi.useFakeTimers();
    try {
      const timedHost = new RuntimeHost(makeConfig({ launchTimeoutMs: 1_000 }));
      const timedUpstream = makeUpstream();
      timedHost.setUpstream(timedUpstream);
      const { destroy } = injectProvider(
        timedHost,
        vi.fn().mockResolvedValue({ runtimeInstanceId: "inst-timeout" })
      );

      await timedHost.submitRun(makeSubmitInput("run-timeout"));
      await vi.advanceTimersByTimeAsync(1_000);

      await vi.waitFor(() => {
        expect(destroy).toHaveBeenCalledWith(
          expect.objectContaining({
            workerId: expect.any(String),
            runtimeInstanceId: "inst-timeout",
          })
        );
      });
      expect(await timedHost.listWorkers()).toEqual([]);
      expect(timedUpstream.notifyRunFailed).toHaveBeenCalledWith(
        "run-timeout",
        expect.stringContaining("timed out")
      );
      timedHost.drain();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rolls back a provisioned runtime even when provider.start never settles", async () => {
    vi.useFakeTimers();
    try {
      const timedHost = new RuntimeHost(makeConfig({ launchTimeoutMs: 1_000 }));
      timedHost.setUpstream(upstream);
      const start = vi.fn(
        (
          _context: unknown,
          _onExit: unknown,
          onProvisioned: (runtimeInstanceId: string) => void
        ) => {
          onProvisioned("inst-stuck");
          return new Promise<never>(() => {});
        }
      );
      const { destroy } = injectProvider(timedHost, start);

      await timedHost.submitRun(makeSubmitInput("run-stuck"));
      await vi.advanceTimersByTimeAsync(1_000);

      await vi.waitFor(() => {
        expect(destroy).toHaveBeenCalledWith(
          expect.objectContaining({ runtimeInstanceId: "inst-stuck" })
        );
      });
      expect(await timedHost.listWorkers()).toEqual([]);
      timedHost.drain();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not expose launch-timeout rollback failure as a business release claim", async () => {
    vi.useFakeTimers();
    try {
      const timedHost = new RuntimeHost(makeConfig({ launchTimeoutMs: 1_000 }));
      timedHost.setUpstream(makeUpstream());
      const start = vi.fn(
        (
          _ctx: unknown,
          _onExit: unknown,
          onProvisioned: (runtimeInstanceId: string) => void
        ) => {
          onProvisioned("inst-timeout-cleanup-only");
          return new Promise<never>(() => {});
        }
      );
      injectProvider(
        timedHost,
        start,
        vi.fn(),
        vi.fn().mockRejectedValue(new Error("orphan cleanup failed"))
      );

      await timedHost.submitRun(makeSubmitInput("run-timeout-cleanup-only"));
      await vi.advanceTimersByTimeAsync(1_000);
      await settle();

      expect(
        (await timedHost.listLifecycleClaims()).filter(
          (claim) => claim.kind === "release_pending"
        )
      ).toEqual([]);
      timedHost.drain();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries cleanup-only records on sweep without creating lifecycle claims", async () => {
    const destroy = vi
      .fn()
      .mockRejectedValueOnce(new Error("cleanup temporarily failed"))
      .mockResolvedValueOnce(undefined);
    injectProvider(
      host,
      vi.fn().mockResolvedValue({ runtimeInstanceId: "inst-cleanup-only" }),
      vi.fn(),
      destroy
    );
    const workerId = await submitAndHandshake(host, "run-cleanup-only");

    await expect(
      host.stopWorker({ runtimeHostId: "", workerId })
    ).rejects.toThrow("cleanup temporarily failed");
    expect(cleanupLedgerOf(host).list()).toHaveLength(1);
    expect(
      (await host.listLifecycleClaims()).filter(
        (claim) => claim.kind === "release_pending"
      )
    ).toEqual([]);

    await sweepOf(host);
    expect(cleanupLedgerOf(host).list()).toHaveLength(0);
    expect(
      (await host.listLifecycleClaims()).filter(
        (claim) => claim.kind === "release_pending"
      )
    ).toEqual([]);

    await host.releaseResources({
      runtimeHostId: "",
      target: { type: "workspace", workspaceId: "ws-1" },
    });
    expect(destroy).toHaveBeenCalledTimes(2);
  });

  it("cleanup-only sweep lets one record succeed while another still fails", async () => {
    const calls = new Map<string, number>();
    const destroy = vi.fn(
      (ref: { runtimeInstanceId: string }) => {
        const count = (calls.get(ref.runtimeInstanceId) ?? 0) + 1;
        calls.set(ref.runtimeInstanceId, count);
        if (count === 1 || ref.runtimeInstanceId === "inst-ws-1") {
          return Promise.reject(new Error(`cleanup failed ${ref.runtimeInstanceId}`));
        }
        return Promise.resolve();
      }
    );
    injectProvider(
      host,
      vi.fn().mockImplementation(
        (ctx: { workspaceId: string }) =>
          Promise.resolve({ runtimeInstanceId: `inst-${ctx.workspaceId}` })
      ),
      vi.fn(),
      destroy
    );
    const firstWorkerId = await submitAndHandshake(host, "run-cleanup-a");
    await host.submitRun(makeSubmitInput("run-cleanup-b", "ws-2"));
    await settle();
    const secondIdentity = deriveReuseIdentity({
      scope: "workspace",
      userId: "user-1",
      workspaceId: "ws-2",
      runtimeType: "native",
    });
    const second = poolOf(host).getByIdentity(secondIdentity, 1)!;
    host.registerWorker(second.workerId, second.startToken, {});
    await settle();

    await expect(
      host.stopWorker({ runtimeHostId: "", workerId: firstWorkerId })
    ).rejects.toThrow("cleanup failed inst-ws-1");
    await expect(
      host.stopWorker({ runtimeHostId: "", workerId: second.workerId })
    ).rejects.toThrow("cleanup failed inst-ws-2");
    expect(cleanupLedgerOf(host).list()).toHaveLength(2);

    await sweepOf(host);
    expect(calls.get("inst-ws-1")).toBe(2);
    expect(calls.get("inst-ws-2")).toBe(2);
    expect(cleanupLedgerOf(host).list()).toHaveLength(1);
    expect(cleanupLedgerOf(host).list()[0]?.ref.runtimeInstanceId).toBe(
      "inst-ws-1"
    );
    expect(
      (await host.listLifecycleClaims()).filter(
        (claim) => claim.kind === "release_pending"
      )
    ).toEqual([]);
  });

  it("reports an unexpected worker exit and clears every active run owned by it", async () => {
    let onExit!: () => void;
    injectProvider(
      host,
      vi.fn().mockImplementation(
        (_context: unknown, exit: () => void) => {
          onExit = exit;
          return Promise.resolve({ runtimeInstanceId: "inst-1" });
        }
      )
    );
    const workerId = await submitAndHandshake(host, "run-1");

    onExit();
    await settle();

    expect(upstream.notifyWorkerLost).toHaveBeenCalledWith(
      "run-1",
      expect.stringContaining("exited")
    );
    expect(await host.listWorkers()).toEqual([]);
    expect(host.getRunConfig(workerId, "run-1")).toBeUndefined();
  });

  it("authorizes run config reads by worker ownership", async () => {
    injectProvider(
      host,
      vi.fn().mockImplementation(async (context: { workerId: string }) => ({
        runtimeInstanceId: `inst-${context.workerId}`,
      }))
    );
    const workerOne = await submitAndHandshake(host, "run-1");

    await host.submitRun(makeSubmitInput("run-2", "ws-2"));
    await settle();
    const secondIdentity = deriveReuseIdentity({
      scope: "workspace",
      userId: "user-1",
      workspaceId: "ws-2",
      runtimeType: "native",
    });
    const second = poolOf(host).getByIdentity(secondIdentity, 1)!;
    expect(
      host.registerWorker(second.workerId, second.startToken, { pid: 2 })
    ).toBe(true);
    await settle();

    expect(host.getRunConfig(workerOne, "run-1")).toMatchObject({
      runId: "run-1",
    });
    expect(host.getRunConfig(second.workerId, "run-1")).toBeUndefined();
    await expect(
      host.postEvent(second.workerId, "run-1", {})
    ).rejects.toThrow(/does not own run/);
  });

  it("fences a worker whose heartbeat went stale(判死注入)", async () => {
    vi.useFakeTimers();
    try {
      const fencedHost = new RuntimeHost(
        makeConfig({ heartbeatTimeoutMs: 3_000 })
      );
      const fencedUpstream = makeUpstream();
      fencedHost.setUpstream(fencedUpstream);
      const { destroy } = injectProvider(
        fencedHost,
        vi.fn().mockResolvedValue({ runtimeInstanceId: "inst-1" })
      );

      await fencedHost.submitRun(makeSubmitInput("run-1"));
      await vi.advanceTimersByTimeAsync(0);
      const entry = poolOf(fencedHost).getByIdentity(IDENTITY_WS, 1)!;
      fencedHost.registerWorker(entry.workerId, entry.startToken, {});
      await vi.advanceTimersByTimeAsync(0);

      // 心跳静默超过判死窗口 → fence:通知 workerLost、移出池、best-effort 停运行实例
      await vi.advanceTimersByTimeAsync(4_000);

      expect(fencedUpstream.notifyWorkerLost).toHaveBeenCalledWith(
        "run-1",
        expect.stringContaining("fence")
      );
      expect(poolOf(fencedHost).getByIdentity(IDENTITY_WS, 1)).toBeUndefined();
      expect(destroy).toHaveBeenCalled();
      fencedHost.drain();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a lively worker out of the fence (poll touches the heartbeat)", async () => {
    vi.useFakeTimers();
    try {
      const fencedHost = new RuntimeHost(
        makeConfig({ heartbeatTimeoutMs: 3_000 })
      );
      const fencedUpstream = makeUpstream();
      fencedHost.setUpstream(fencedUpstream);
      injectProvider(
        fencedHost,
        vi.fn().mockResolvedValue({ runtimeInstanceId: "inst-1" })
      );

      await fencedHost.submitRun(makeSubmitInput("run-1"));
      await vi.advanceTimersByTimeAsync(0);
      const entry = poolOf(fencedHost).getByIdentity(IDENTITY_WS, 1)!;
      fencedHost.registerWorker(entry.workerId, entry.startToken, {});
      await vi.advanceTimersByTimeAsync(0);

      // 每秒 poll 一次 = 心跳不断
      for (let i = 0; i < 5; i++) {
        await fencedHost.pollCommands(entry.workerId, { afterSeq: 100 });
        await vi.advanceTimersByTimeAsync(1_000);
      }

      expect(fencedUpstream.notifyWorkerLost).not.toHaveBeenCalled();
      expect(poolOf(fencedHost).getByIdentity(IDENTITY_WS, 1)).toBeDefined();
      fencedHost.drain();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stopWorker stops the runtime instance and reports workerLost for its active runs", async () => {
    const { destroy } = injectProvider(
      host,
      vi.fn().mockResolvedValue({ runtimeInstanceId: "inst-1" })
    );
    const workerId = await submitAndHandshake(host, "run-1");

    await host.stopWorker({ runtimeHostId: "", workerId });

    expect(destroy).toHaveBeenCalled();
    expect(upstream.notifyWorkerLost).toHaveBeenCalledWith(
      "run-1",
      "worker stopped"
    );
    expect(poolOf(host).getById(workerId)).toBeUndefined();
  });

  it("stopWorker with unknown workerId is an idempotent no-op", async () => {
    injectProvider(
      host,
      vi.fn().mockResolvedValue({ runtimeInstanceId: "inst-1" })
    );

    await expect(
      host.stopWorker({ runtimeHostId: "", workerId: "nonexistent" })
    ).resolves.toBeUndefined();
  });

  it("releaseResources with workspace target stops workspace-scope workers", async () => {
    injectProvider(
      host,
      vi.fn().mockResolvedValue({ runtimeInstanceId: "inst-1" })
    );
    await submitAndHandshake(host, "run-1");

    await host.releaseResources({
      runtimeHostId: "",
      target: { type: "workspace", workspaceId: "ws-1" },
    });

    expect(poolOf(host).getByIdentity(IDENTITY_WS, 1)).toBeUndefined();
    expect(upstream.notifyRunCancelled).toHaveBeenCalledWith("run-1");
  });

  it("releaseRun clears run state and config", async () => {
    injectProvider(
      host,
      vi.fn().mockResolvedValue({ runtimeInstanceId: "inst-1" })
    );
    const workerId = await submitAndHandshake(host, "run-1");

    host.releaseRun({ runtimeHostId: "builtin", runId: "run-1" });

    expect(host.getRunConfig(workerId, "run-1")).toBeUndefined();
    // releaseRun 后同 runId 重新提交不再被幂等吸收
    await host.submitRun(makeSubmitInput("run-1"));
    await settle();
    expect(host.getRunConfig(workerId, "run-1")).toBeDefined();
  });

  // ── V3 新增:releaseResources user target / generation fencing / claims / shutdown ──

  it("releaseResources with user target fences old generation and releases both scope workers", async () => {
    // 用 user scope 能力的 Host
    const userHost = new RuntimeHost(
      makeConfig({
        capabilities: {
          native: { available: true, scopes: ["workspace", "user"] },
        },
      })
    );
    const userUpstream = makeUpstream();
    userHost.setUpstream(userUpstream);

    const { destroy } = injectProvider(
      userHost,
      vi.fn().mockResolvedValue({ runtimeInstanceId: "inst-1" })
    );

    // 提交一个 user-scope run
    const input = makeSubmitInput("run-user-1");
    input.placement.scope = "user";
    await userHost.submitRun(input);
    await settle();

    const userIdentity = deriveReuseIdentity({
      scope: "user",
      userId: "user-1",
      workspaceId: "ws-1",
      runtimeType: "native",
    });
    const entry = poolOf(userHost).getByIdentity(userIdentity, 1)!;
    userHost.registerWorker(entry.workerId, entry.startToken, {});
    await settle();

    // release user target with version 1
    await userHost.releaseResources({
      runtimeHostId: "",
      target: { type: "user", userId: "user-1", userLifecycleVersion: 1 },
    });

    expect(destroy).toHaveBeenCalled();
    expect(userUpstream.notifyRunCancelled).toHaveBeenCalledWith("run-user-1");
    expect(poolOf(userHost).getByIdentity(userIdentity, 1)).toBeUndefined();
    userHost.drain();
  });

  it("releaseResources user target keeps new generation workers (re-enable fencing)", async () => {
    const userHost = new RuntimeHost(
      makeConfig({
        capabilities: {
          native: { available: true, scopes: ["workspace", "user"] },
        },
      })
    );
    const userUpstream = makeUpstream();
    userHost.setUpstream(userUpstream);
    injectProvider(
      userHost,
      vi.fn().mockResolvedValue({ runtimeInstanceId: "inst-1" })
    );

    // release user at version 1
    await userHost.releaseResources({
      runtimeHostId: "",
      target: { type: "user", userId: "user-1", userLifecycleVersion: 1 },
    });

    // 新 generation submit (version 2) 应该被接受
    const input = makeSubmitInput("run-new-gen");
    input.placement.scope = "user";
    input.placement.userLifecycleVersion = 2;
    await userHost.submitRun(input);
    await settle();

    const userIdentity = deriveReuseIdentity({
      scope: "user",
      userId: "user-1",
      workspaceId: "ws-1",
      runtimeType: "native",
    });
    expect(poolOf(userHost).getByIdentity(userIdentity, 2)).toBeDefined();

    // 迟到的旧 disable (version 1) 不应命中新 generation worker
    await userHost.releaseResources({
      runtimeHostId: "",
      target: { type: "user", userId: "user-1", userLifecycleVersion: 1 },
    });
    expect(poolOf(userHost).getByIdentity(userIdentity, 2)).toBeDefined();
    userHost.drain();
  });

  it("rejects submit with stale userLifecycleVersion after release", async () => {
    await host.releaseResources({
      runtimeHostId: "",
      target: { type: "user", userId: "user-1", userLifecycleVersion: 2 },
    });

    // 旧 version submit 应被拒绝
    const input = makeSubmitInput("run-stale");
    input.placement.userLifecycleVersion = 1;
    await expect(host.submitRun(input)).rejects.toThrow(/fenced/);
  });

  it("listLifecycleClaims covers sessions and workers", async () => {
    injectProvider(
      host,
      vi.fn().mockResolvedValue({ runtimeInstanceId: "inst-1" })
    );
    await submitAndHandshake(host, "run-1");

    const claims = await host.listLifecycleClaims();
    expect(claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "worker",
          workerId: expect.any(String),
          scope: "workspace",
          subjectId: "ws-1",
          userId: "user-1",
        }),
      ])
    );
    // session claim for run-1 should be in ready phase
    expect(claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "session",
          runId: "run-1",
          phase: "ready",
          userId: "user-1",
          workspaceId: "ws-1",
        }),
      ])
    );
  });

  it("shutdown is idempotent and stops all workers", async () => {
    const { destroy } = injectProvider(
      host,
      vi.fn().mockResolvedValue({ runtimeInstanceId: "inst-1" })
    );
    await submitAndHandshake(host, "run-1");

    await host.shutdown();
    expect(destroy).toHaveBeenCalled();
    expect(await host.listWorkers()).toEqual([]);

    // 第二次 shutdown 不重复清理
    const destroyCallsBefore = destroy.mock.calls.length;
    await host.shutdown();
    expect(destroy.mock.calls.length).toBe(destroyCallsBefore);
  });

  // ── P0 回归:provider 清理失败重试 + generation 交错 ────────────────────

  it("provider cleanup failure saves ref to releasePending and retries on subsequent release", async () => {
    const destroy = vi
      .fn()
      .mockRejectedValueOnce(new Error("docker daemon down"))
      .mockResolvedValueOnce(undefined);
    injectProvider(
      host,
      vi.fn().mockResolvedValue({ runtimeInstanceId: "inst-1" }),
      vi.fn(),
      destroy
    );
    await submitAndHandshake(host, "run-1");

    // 第一次 release 失败:provider 清理报错
    await expect(
      host.releaseResources({
        runtimeHostId: "",
        target: { type: "workspace", workspaceId: "ws-1" },
      })
    ).rejects.toThrow("docker daemon down");

    // release_pending claim 应可见(重试账本保留了 RuntimeInstanceRef)
    const claims = await host.listLifecycleClaims();
    expect(
      claims.filter((c) => c.kind === "release_pending")
    ).toHaveLength(1);
    expect(claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "release_pending",
          target: { type: "workspace", workspaceId: "ws-1" },
        }),
      ])
    );

    // 第二次 release:重试 pending cleanup(此时 destroy 成功)
    await host.releaseResources({
      runtimeHostId: "",
      target: { type: "workspace", workspaceId: "ws-1" },
    });

    // release_pending claim 应已清除
    const claimsAfter = await host.listLifecycleClaims();
    expect(
      claimsAfter.filter((c) => c.kind === "release_pending")
    ).toHaveLength(0);
  });

  it("keeps returning an error while a pending cleanup continues to fail", async () => {
    const destroy = vi.fn().mockRejectedValue(new Error("cleanup still down"));
    injectProvider(
      host,
      vi.fn().mockResolvedValue({ runtimeInstanceId: "inst-repeat" }),
      vi.fn(),
      destroy
    );
    await submitAndHandshake(host, "run-repeat");

    const release = () =>
      host.releaseResources({
        runtimeHostId: "",
        target: { type: "workspace" as const, workspaceId: "ws-1" },
      });
    await expect(release()).rejects.toThrow("cleanup still down");
    await expect(release()).rejects.toThrow("cleanup still down");
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(
      (await host.listLifecycleClaims()).filter(
        (claim) => claim.kind === "release_pending"
      )
    ).toHaveLength(1);
  });

  it("singleflights concurrent release cleanup for the same runtime instance", async () => {
    let finishCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    const destroy = vi.fn().mockReturnValue(cleanupGate);
    injectProvider(
      host,
      vi.fn().mockResolvedValue({ runtimeInstanceId: "inst-concurrent" }),
      vi.fn(),
      destroy
    );
    await submitAndHandshake(host, "run-concurrent");

    const input = {
      runtimeHostId: "",
      target: { type: "workspace" as const, workspaceId: "ws-1" },
    };
    const first = host.releaseResources(input);
    await settle();
    const second = host.releaseResources(input);
    await settle();
    expect(destroy).toHaveBeenCalledTimes(1);

    finishCleanup();
    await Promise.all([first, second]);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("rejects release when acquisition rollback fails and exposes a claim", async () => {
    let provision!: (runtimeInstanceId: string) => void;
    let failStart!: (error: Error) => void;
    const start = vi.fn(
      (
        _ctx: unknown,
        _onExit: unknown,
        onProvisioned: (runtimeInstanceId: string) => void
      ) => {
        provision = onProvisioned;
        return new Promise<never>((_, reject) => {
          failStart = reject;
        });
      }
    );
    const destroy = vi.fn().mockRejectedValue(new Error("rollback denied"));
    injectProvider(host, start, vi.fn(), destroy);
    await host.submitRun(makeSubmitInput("run-rollback"));
    await settle();

    const release = host.releaseResources({
      runtimeHostId: "",
      target: { type: "workspace", workspaceId: "ws-1" },
    });
    provision("inst-rollback");
    failStart(new Error("start cancelled"));

    await expect(release).rejects.toThrow("rollback denied");
    expect(
      (await host.listLifecycleClaims()).some(
        (claim) => claim.kind === "release_pending"
      )
    ).toBe(true);
  });

  it("waits for late provision and rollback before release ACK", async () => {
    vi.useFakeTimers();
    try {
      const timedHost = new RuntimeHost(makeConfig({ launchTimeoutMs: 1_000 }));
      timedHost.setUpstream(makeUpstream());
      let provision!: (runtimeInstanceId: string) => void;
      let finishStart!: (value: { runtimeInstanceId: string }) => void;
      const start = vi.fn(
        (
          _ctx: unknown,
          _onExit: unknown,
          onProvisioned: (runtimeInstanceId: string) => void
        ) => {
          provision = onProvisioned;
          return new Promise<{ runtimeInstanceId: string }>((resolve) => {
            finishStart = resolve;
          });
        }
      );
      const { destroy } = injectProvider(timedHost, start);
      await timedHost.submitRun(makeSubmitInput("run-late"));
      await vi.advanceTimersByTimeAsync(1_000);

      let acknowledged = false;
      const release = timedHost
        .releaseResources({
          runtimeHostId: "",
          target: { type: "workspace", workspaceId: "ws-1" },
        })
        .then(() => {
          acknowledged = true;
        });
      await vi.advanceTimersByTimeAsync(0);
      expect(acknowledged).toBe(false);

      provision("inst-late");
      finishStart({ runtimeInstanceId: "inst-late" });
      await release;
      expect(destroy).toHaveBeenCalledWith(
        expect.objectContaining({ runtimeInstanceId: "inst-late" })
      );
      timedHost.drain();
    } finally {
      vi.useRealTimers();
    }
  });

  it("detaches one workspace without cancelling a shared user-scope acquisition", async () => {
    const userHost = new RuntimeHost(
      makeConfig({
        capabilities: { native: { available: true, scopes: ["user"] } },
      })
    );
    userHost.setUpstream(makeUpstream());
    let finishStart!: (value: { runtimeInstanceId: string }) => void;
    const start = vi.fn().mockReturnValue(
      new Promise<{ runtimeInstanceId: string }>((resolve) => {
        finishStart = resolve;
      })
    );
    const { destroy } = injectProvider(userHost, start);
    const first = makeSubmitInput("run-user-ws1", "ws-1");
    first.placement.scope = "user";
    const second = makeSubmitInput("run-user-ws2", "ws-2");
    second.placement.scope = "user";
    await userHost.submitRun(first);
    await userHost.submitRun(second);
    await settle();
    expect(start).toHaveBeenCalledTimes(1);

    await userHost.releaseResources({
      runtimeHostId: "",
      target: { type: "workspace", workspaceId: "ws-1" },
    });
    expect(destroy).not.toHaveBeenCalled();

    finishStart({ runtimeInstanceId: "inst-shared" });
    await settle();
    const identity = deriveReuseIdentity(second.placement);
    const entry = poolOf(userHost).getByIdentity(identity, 1)!;
    userHost.registerWorker(entry.workerId, entry.startToken, {});
    await settle();
    expect(entry.workspaceIds.has("ws-2")).toBe(true);
    expect(entry.workspaceIds.has("ws-1")).toBe(false);
    userHost.drain();
  });

  it("retries a failed user-scope rollback by its original workspace target", async () => {
    const userHost = new RuntimeHost(
      makeConfig({
        capabilities: { native: { available: true, scopes: ["user"] } },
      })
    );
    userHost.setUpstream(makeUpstream());
    let provision!: (runtimeInstanceId: string) => void;
    let failStart!: (error: Error) => void;
    const firstStart = new Promise<never>((_, reject) => {
      failStart = reject;
    });
    const start = vi
      .fn()
      .mockImplementationOnce(
        (
          _ctx: unknown,
          _onExit: unknown,
          onProvisioned: (runtimeInstanceId: string) => void
        ) => {
          provision = onProvisioned;
          return firstStart;
        }
      )
      .mockResolvedValue({ runtimeInstanceId: "inst-next-workspace" });
    const destroy = vi
      .fn()
      .mockRejectedValueOnce(new Error("rollback temporarily failed"))
      .mockResolvedValueOnce(undefined);
    injectProvider(userHost, start, vi.fn(), destroy);

    const first = makeSubmitInput("run-user-only-ws1", "ws-1");
    first.placement.scope = "user";
    await userHost.submitRun(first);
    await settle();

    const firstRelease = userHost.releaseResources({
      runtimeHostId: "",
      target: { type: "workspace", workspaceId: "ws-1" },
    });
    provision("inst-user-only-ws1");
    failStart(new Error("start cancelled"));
    await expect(firstRelease).rejects.toThrow("rollback temporarily failed");
    expect(await userHost.listLifecycleClaims()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "release_pending",
          target: { type: "workspace", workspaceId: "ws-1" },
        }),
      ])
    );

    await userHost.releaseResources({
      runtimeHostId: "",
      target: { type: "workspace", workspaceId: "ws-1" },
    });
    expect(
      (await userHost.listLifecycleClaims()).filter(
        (claim) => claim.kind === "release_pending"
      )
    ).toEqual([]);

    // workspace release 不能顺带安装 user fence；同一 user/version 的其它 workspace
    // 仍可进入新的 user-scope acquisition。
    const second = makeSubmitInput("run-user-only-ws2", "ws-2");
    second.placement.scope = "user";
    await expect(userHost.submitRun(second)).resolves.toBeUndefined();
    await settle();
    expect(start).toHaveBeenCalledTimes(2);
    userHost.drain();
  });

  it("new generation does not reuse old generation worker (generation interleaving)", async () => {
    injectProvider(
      host,
      vi.fn().mockResolvedValue({ runtimeInstanceId: "inst-1" })
    );

    // V1 submit + handshake
    await submitAndHandshake(host, "run-v1");
    const v1Entry = poolOf(host).getByIdentity(IDENTITY_WS, 1)!;
    expect(v1Entry.userLifecycleVersion).toBe(1);

    // V2 submit — 不复用 V1 worker,创建新 worker
    const input = makeSubmitInput("run-v2");
    input.placement.userLifecycleVersion = 2;
    await host.submitRun(input);
    await settle();

    // V2 worker 是不同 worker
    const v2Entry = poolOf(host).getByIdentity(IDENTITY_WS, 2)!;
    expect(v2Entry.workerId).not.toBe(v1Entry.workerId);
    expect(v2Entry.userLifecycleVersion).toBe(2);

    // V1 worker 仍存在(多代并存)
    expect(poolOf(host).getById(v1Entry.workerId)).toBeDefined();
    expect(poolOf(host).getByIdentity(IDENTITY_WS, 1)?.workerId).toBe(
      v1Entry.workerId
    );

    host.drain();
  });
});
