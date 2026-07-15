import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  RuntimeHostUpstream,
  SubmitRunInput,
  WorkerKey,
} from "@agework/shared/protocol";
import { RuntimeHost, type RuntimeHostConfig } from "./runtime-host.js";
import type { WorkerPool } from "./worker-pool.js";

const KEY = "workspace:ws-1#native" as WorkerKey;

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
      openSandbox: {
        domain: "",
        protocol: "https",
        apiKey: undefined,
        useServerProxy: false,
      },
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
      owner: `workspace:${workspaceId}`,
      runtimeType: "native",
      runtimeHostId: "builtin",
      workspaceId,
      userId: "user-1",
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
  const entry = poolOf(host).get(KEY)!;
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

  it("rejects an owner scope outside the Host capability", async () => {
    const start = vi.fn();
    injectProvider(host, start);
    const input = makeSubmitInput("run-1");
    input.placement.owner = "user:user-1";

    await expect(host.submitRun(input)).rejects.toThrow(
      "runtimeType native does not support user scope on this Host"
    );
    expect(start).not.toHaveBeenCalled();
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

  it("shares one in-flight worker launch between concurrent runs for the same WorkerKey", async () => {
    const start = vi
      .fn()
      .mockResolvedValue({ runtimeInstanceId: "inst-1" });
    injectProvider(host, start);

    await host.submitRun(makeSubmitInput("run-1"));
    await host.submitRun(makeSubmitInput("run-2"));
    await settle();

    expect(start).toHaveBeenCalledTimes(1);

    const entry = poolOf(host).get(KEY)!;
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
    const entry = poolOf(host).get(KEY)!;
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
          return { claude: null, codex: null, opencode: null };
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
    const entry = poolOf(host).get(KEY)!;
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
      vi.fn().mockImplementation(async (context: { ownerId: string }) => ({
        runtimeInstanceId: `inst-${context.ownerId}`,
      }))
    );
    const workerOne = await submitAndHandshake(host, "run-1");

    await host.submitRun(makeSubmitInput("run-2", "ws-2"));
    await settle();
    const secondKey = "workspace:ws-2#native" as WorkerKey;
    const second = poolOf(host).get(secondKey)!;
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
      const entry = poolOf(fencedHost).get(KEY)!;
      fencedHost.registerWorker(entry.workerId, entry.startToken, {});
      await vi.advanceTimersByTimeAsync(0);

      // 心跳静默超过判死窗口 → fence:通知 workerLost、移出池、best-effort 停运行实例
      await vi.advanceTimersByTimeAsync(4_000);

      expect(fencedUpstream.notifyWorkerLost).toHaveBeenCalledWith(
        "run-1",
        expect.stringContaining("fence")
      );
      expect(poolOf(fencedHost).get(KEY)).toBeUndefined();
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
      const entry = poolOf(fencedHost).get(KEY)!;
      fencedHost.registerWorker(entry.workerId, entry.startToken, {});
      await vi.advanceTimersByTimeAsync(0);

      // 每秒 poll 一次 = 心跳不断
      for (let i = 0; i < 5; i++) {
        await fencedHost.pollCommands(entry.workerId, { afterSeq: 100 });
        await vi.advanceTimersByTimeAsync(1_000);
      }

      expect(fencedUpstream.notifyWorkerLost).not.toHaveBeenCalled();
      expect(poolOf(fencedHost).get(KEY)).toBeDefined();
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
    await submitAndHandshake(host, "run-1");

    await host.stopWorker({ runtimeHostId: "", key: KEY });

    expect(destroy).toHaveBeenCalled();
    expect(upstream.notifyWorkerLost).toHaveBeenCalledWith(
      "run-1",
      "worker stopped"
    );
    expect(poolOf(host).get(KEY)).toBeUndefined();
  });

  it("releaseOwner stops every worker under the owner", async () => {
    injectProvider(
      host,
      vi.fn().mockResolvedValue({ runtimeInstanceId: "inst-1" })
    );
    await submitAndHandshake(host, "run-1");

    await host.releaseOwner({ runtimeHostId: "", owner: "workspace:ws-1" });

    expect(poolOf(host).get(KEY)).toBeUndefined();
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
});
