import { describe, expect, it, vi, beforeEach } from "vitest";
import { LocalRuntimeProvider } from "./local-runtime.provider";

const forkMock = vi.hoisted(() => {
  const children: Array<{
    pid: number;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
  }> = [];
  const fork = vi.fn(() => {
    const child = { pid: 12345, killed: false, kill: vi.fn(), on: vi.fn() };
    children.push(child);
    return child;
  });
  return { fork, children };
});

vi.mock("node:child_process", () => ({ fork: forkMock.fork }));

const makeCtx = (over: Record<string, unknown> = {}) => ({
  runtimeType: "local" as const,
  ownerId: "owner-1",
  workspaceId: "ws-1",
  runId: "run-1",
  placement: {
    runtimeType: "local" as const,
    userId: "u1",
    workspaceId: "ws-1",
    hostPath: "/w",
    runtimePath: "/w",
    runtimeLogDir: "/logs",
  },
  workerEnv: {},
  ...over,
});

const makeRef = (over: Record<string, unknown> = {}) => ({
  runtimeType: "local",
  ownerId: "owner-1",
  runtimeInstanceId: "12345:some-token",
  isolationScope: "workspace",
  ...over,
});

const exitHandlerOf = (child: { on: ReturnType<typeof vi.fn> }) =>
  child.on.mock.calls.find((call) => call[0] === "exit")?.[1] as () => void;

describe("LocalRuntimeProvider", () => {
  beforeEach(() => {
    forkMock.fork.mockClear();
    forkMock.children.length = 0;
  });

  describe("start", () => {
    it("forks a worker process and returns a pid:token instanceId", async () => {
      const provider = new LocalRuntimeProvider();

      const { runtimeInstanceId } = await provider.start(
        makeCtx({
          workerEnv: { AGEWORK_WORKER_START_TOKEN: "provisioner-tok" },
        })
      );

      expect(forkMock.fork).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({
          env: expect.objectContaining({
            AGEWORK_WORKER_START_TOKEN: "provisioner-tok",
            AGEWORK_WORKER_RUN_START_TOKEN: expect.any(String),
          }),
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        })
      );
      expect(runtimeInstanceId).toMatch(/^12345:.+/);
    });

    it("generates a distinct startToken per start", async () => {
      const provider = new LocalRuntimeProvider();

      const first = await provider.start(makeCtx());
      const second = await provider.start(makeCtx({ runId: "run-2" }));

      expect(first.runtimeInstanceId).not.toBe(second.runtimeInstanceId);
    });
  });

  describe("stop", () => {
    it("SIGTERMs the stored channel and is idempotent", async () => {
      const provider = new LocalRuntimeProvider();
      await provider.start(makeCtx());
      const child = forkMock.children[0];

      provider.stop(makeRef());
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(child.kill).toHaveBeenCalledTimes(1);

      expect(() => provider.stop(makeRef())).not.toThrow();
      expect(child.kill).toHaveBeenCalledTimes(1);
    });

    it("does nothing for an unknown owner", () => {
      const provider = new LocalRuntimeProvider();
      expect(() =>
        provider.stop(makeRef({ ownerId: "unknown", runtimeInstanceId: "9:x" }))
      ).not.toThrow();
    });
  });

  describe("destroy", () => {
    it("kills the tracked channel when one is present", async () => {
      const provider = new LocalRuntimeProvider();
      await provider.start(makeCtx());
      const child = forkMock.children[0];

      provider.destroy(makeRef());
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    });

    it("SIGTERMs the pid encoded in runtimeInstanceId when no channel is tracked", () => {
      const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
      const provider = new LocalRuntimeProvider();

      provider.destroy(makeRef({ runtimeInstanceId: "12345:some-token" }));

      expect(killSpy).toHaveBeenCalledWith(12345, "SIGTERM");
      killSpy.mockRestore();
    });

    it("does nothing for a malformed runtimeInstanceId", () => {
      const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
      const provider = new LocalRuntimeProvider();

      provider.destroy(
        makeRef({ runtimeInstanceId: "not-a-valid-runtime-id" })
      );

      expect(killSpy).not.toHaveBeenCalled();
      killSpy.mockRestore();
    });

    it("ignores ESRCH when the process is already gone", () => {
      vi.spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      });
      const provider = new LocalRuntimeProvider();

      expect(() =>
        provider.destroy(makeRef({ runtimeInstanceId: "12345:some-token" }))
      ).not.toThrow();
    });
  });

  describe("exit handling", () => {
    it("calls ctx.onWorkerExit and removes the channel when the process exits", async () => {
      const provider = new LocalRuntimeProvider();
      const onWorkerExit = vi.fn();
      await provider.start(makeCtx({ onWorkerExit }));
      const child = forkMock.children[0];

      exitHandlerOf(child)();

      expect(onWorkerExit).toHaveBeenCalledOnce();
      // channel removed → later stop is a no-op
      provider.stop(makeRef());
      expect(child.kill).not.toHaveBeenCalled();
    });

    it("ignores a stale/superseded channel's late exit", async () => {
      const provider = new LocalRuntimeProvider();
      const onWorkerExit = vi.fn();

      await provider.start(makeCtx({ onWorkerExit }));
      const stale = forkMock.children[0];
      const staleExit = exitHandlerOf(stale);

      // A newer start for the same owner supersedes the stale channel.
      await provider.start(makeCtx({ onWorkerExit }));
      const current = forkMock.children[1];

      staleExit();

      expect(onWorkerExit).not.toHaveBeenCalled();
      provider.stop(makeRef());
      expect(current.kill).toHaveBeenCalledWith("SIGTERM");
    });
  });

  it("self-declares its type as local", () => {
    expect(new LocalRuntimeProvider().type).toBe("local");
  });
});
