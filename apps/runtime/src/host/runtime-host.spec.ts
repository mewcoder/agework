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
    capabilities: {
      native: { available: true, scopes: ["workspace"] },
    },
    providerConfig: {
      workerImage: "",
      runtimeLogHostPath: "/tmp/agework-host-test/logs",
      serverBaseUrl: "http://127.0.0.1:7101/api/v1",
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

function makeSubmitInput(runId: string): SubmitRunInput {
  return {
    runId,
    conversationId: "conversation-1",
    placement: {
      owner: "workspace:ws-1",
      runtimeType: "native",
      runtimeHostId: "builtin",
      workspaceId: "ws-1",
      userId: "user-1",
      username: "admin-1",
      workspacePath: "/tmp/agework-host-test/ws-1",
    },
    agentProviderConfig: { agentType: "claude", source: "system" },
    input: { messages: [{ id: "msg-1" }] },
  };
}

/** 用可控的假 provider 替掉真实 provider 分发(私有字段,测试专用注入)。 */
function injectProvider(
  host: RuntimeHost,
  start: ReturnType<typeof vi.fn>,
  stop: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined)
) {
  (host as unknown as { resolveProvider: unknown }).resolveProvider = () => ({
    start,
    stop,
    destroy: vi.fn(),
  });
  return { start, stop };
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

  it("launches a worker, handshakes, then dispatches the first user_message", async () => {
    injectProvider(
      host,
      vi.fn().mockResolvedValue({ runtimeInstanceId: "inst-1" })
    );

    const workerId = await submitAndHandshake(host, "run-1");

    const { commands } = await host.pollCommands(workerId, { afterSeq: 0 });
    expect(commands.map((c) => c.payload.type)).toEqual(["user_message"]);
    expect(host.getRunConfig("run-1")).toMatchObject({ runId: "run-1" });
    expect(await host.listWorkers()).toEqual([
      expect.objectContaining({ id: workerId, runIds: ["run-1"] }),
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
    expect(host.getRunConfig("run-2")).toMatchObject({ runId: "run-2" });
    const { commands } = await host.pollCommands(workerId, { afterSeq: 0 });
    expect(
      commands.filter((c) => c.payload.type === "user_message")
    ).toHaveLength(2);
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

    expect(upstream.notifyRunFailed).toHaveBeenCalledWith(
      "run-1",
      expect.stringContaining("docker down")
    );
  });

  it("fences a worker whose heartbeat went stale(判死注入)", async () => {
    vi.useFakeTimers();
    try {
      const fencedHost = new RuntimeHost(
        makeConfig({ heartbeatTimeoutMs: 3_000 })
      );
      const fencedUpstream = makeUpstream();
      fencedHost.setUpstream(fencedUpstream);
      const { stop } = injectProvider(
        fencedHost,
        vi.fn().mockResolvedValue({ runtimeInstanceId: "inst-1" })
      );

      await fencedHost.submitRun(makeSubmitInput("run-1"));
      await vi.advanceTimersByTimeAsync(0);
      const entry = poolOf(fencedHost).get(KEY)!;
      fencedHost.registerWorker(entry.workerId, entry.startToken, {});
      await vi.advanceTimersByTimeAsync(0);

      // 心跳静默超过判死窗口 → fence:通知 workerLost、移出池、best-effort 停载体
      await vi.advanceTimersByTimeAsync(4_000);

      expect(fencedUpstream.notifyWorkerLost).toHaveBeenCalledWith(
        "run-1",
        expect.stringContaining("fence")
      );
      expect(poolOf(fencedHost).get(KEY)).toBeUndefined();
      expect(stop).toHaveBeenCalled();
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

  it("stopWorker stops the carrier and reports workerLost for its active runs", async () => {
    const { stop } = injectProvider(
      host,
      vi.fn().mockResolvedValue({ runtimeInstanceId: "inst-1" })
    );
    await submitAndHandshake(host, "run-1");

    await host.stopWorker(KEY);

    expect(stop).toHaveBeenCalled();
    expect(upstream.notifyWorkerLost).toHaveBeenCalledWith(
      "run-1",
      "worker stopped"
    );
    expect(poolOf(host).get(KEY)).toBeUndefined();
  });

  it("releaseOwner stops every worker under the owner prefix", async () => {
    injectProvider(
      host,
      vi.fn().mockResolvedValue({ runtimeInstanceId: "inst-1" })
    );
    await submitAndHandshake(host, "run-1");

    await host.releaseOwner("workspace:ws-1");

    expect(poolOf(host).get(KEY)).toBeUndefined();
  });

  it("releaseRun clears run state and config", async () => {
    injectProvider(
      host,
      vi.fn().mockResolvedValue({ runtimeInstanceId: "inst-1" })
    );
    await submitAndHandshake(host, "run-1");

    host.releaseRun({ runtimeHostId: "builtin", runId: "run-1" });

    expect(host.getRunConfig("run-1")).toBeUndefined();
    // releaseRun 后同 runId 重新提交不再被幂等吸收
    await host.submitRun(makeSubmitInput("run-1"));
    await settle();
    expect(host.getRunConfig("run-1")).toBeDefined();
  });
});
