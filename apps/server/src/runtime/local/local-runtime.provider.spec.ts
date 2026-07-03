import { describe, expect, it, vi, beforeEach } from "vitest";
import { LocalRuntimeProvider } from "./local-runtime.provider";

const childProcessMock = vi.hoisted(() => {
  const child = { pid: 12345, connected: true };
  return { child, fork: vi.fn(() => child) };
});

vi.mock("node:child_process", () => ({
  fork: childProcessMock.fork,
}));

describe("LocalRuntimeProvider", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  describe("launch", () => {
    it("forks a worker process and returns the instanceId + channel", () => {
      const provider = new LocalRuntimeProvider();

      const handle = provider.launch({
        runId: "run-1",
        env: { AGEWORK_WORKER_RUN_ID: "run-1" },
      });

      expect(childProcessMock.fork).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({
          env: expect.objectContaining({ AGEWORK_WORKER_RUN_ID: "run-1" }),
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        })
      );
      expect(handle.channel).toBe(childProcessMock.child);
      expect(handle.runtimeInstanceId).toMatch(/^12345:.+/);
    });

    it("generates a distinct startToken per launch", () => {
      const provider = new LocalRuntimeProvider();

      const first = provider.launch({ runId: "run-1", env: {} });
      const second = provider.launch({ runId: "run-2", env: {} });

      expect(first.runtimeInstanceId).not.toBe(second.runtimeInstanceId);
    });
  });

  describe("recoverOrphan", () => {
    const makeRef = (runtimeInstanceId: string) => ({
      runtimeType: "local",
      ownerId: "owner-1",
      runtimeInstanceId,
      isolationScope: "workspace",
    });

    it("sends SIGTERM to the pid encoded in a 'pid:token' runtimeInstanceId", async () => {
      const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
      const provider = new LocalRuntimeProvider();

      await provider.recoverOrphan(makeRef("12345:some-token"));

      expect(killSpy).toHaveBeenCalledWith(12345, "SIGTERM");
    });

    it("does nothing for a malformed runtimeInstanceId", async () => {
      const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
      const provider = new LocalRuntimeProvider();

      await provider.recoverOrphan(makeRef("not-a-valid-runtime-id"));

      expect(killSpy).not.toHaveBeenCalled();
    });

    it("ignores ESRCH when the process is already gone", async () => {
      vi.spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      });
      const provider = new LocalRuntimeProvider();

      await expect(
        provider.recoverOrphan(makeRef("12345:some-token"))
      ).resolves.toBeUndefined();
    });
  });

  it("implements RuntimeProvider surface (type/placementKind)", () => {
    const provider = new LocalRuntimeProvider();
    expect(provider.type).toBe("local");
    expect(provider.placementKind).toBe("process");
  });

  it("prepareEnvironment is a no-op returning empty handle", async () => {
    const provider = new LocalRuntimeProvider();
    await expect(
      provider.prepareEnvironment({
        runtimeType: "local",
        ownerId: "ws-1",
        workspaceId: "ws-1",
        runId: "run-1",
        placement: {
          runtimeType: "local",
          userId: "u1",
          workspaceId: "ws-1",
          hostPath: "/w",
          runtimePath: "/w",
          runtimeLogDir: "/logs",
        },
        workerEnv: {},
      })
    ).resolves.toEqual({});
  });

  describe("launchWorker / teardown", () => {
    const makeCtx = () => ({
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
    });

    const makeFakeChannel = () => ({
      pid: 12345,
      killed: false,
      kill: vi.fn(),
      on: vi.fn(),
    });

    it("returns the launched runtimeInstanceId and stores the channel", async () => {
      const provider = new LocalRuntimeProvider();
      const fakeChannel = makeFakeChannel();
      vi.spyOn(provider as any, "launch").mockReturnValue({
        runtimeInstanceId: "12345:some-token",
        channel: fakeChannel,
      });

      const result = await provider.launchWorker(makeCtx(), {});

      expect(result).toEqual({ runtimeInstanceId: "12345:some-token" });

      provider.teardown({
        runtimeType: "local",
        ownerId: "owner-1",
        runtimeInstanceId: "12345:some-token",
        isolationScope: "workspace",
      });
      expect(fakeChannel.kill).toHaveBeenCalledWith("SIGTERM");
    });

    it("teardown kills the stored channel and is idempotent afterwards", async () => {
      const provider = new LocalRuntimeProvider();
      const fakeChannel = makeFakeChannel();
      vi.spyOn(provider as any, "launch").mockReturnValue({
        runtimeInstanceId: "12345:some-token",
        channel: fakeChannel,
      });

      await provider.launchWorker(makeCtx(), {});

      const ref = {
        runtimeType: "local" as const,
        ownerId: "owner-1",
        runtimeInstanceId: "12345:some-token",
        isolationScope: "workspace" as const,
      };

      provider.teardown(ref);
      expect(fakeChannel.kill).toHaveBeenCalledTimes(1);
      expect(fakeChannel.kill).toHaveBeenCalledWith("SIGTERM");

      expect(() => provider.teardown(ref)).not.toThrow();
      expect(fakeChannel.kill).toHaveBeenCalledTimes(1);
    });

    it("teardown for an unknown owner does nothing and does not throw", () => {
      const provider = new LocalRuntimeProvider();

      expect(() =>
        provider.teardown({
          runtimeType: "local",
          ownerId: "unknown-owner",
          runtimeInstanceId: "99999:no-token",
          isolationScope: "workspace",
        })
      ).not.toThrow();
    });

    it("removes the channel on exit so a later teardown is a no-op", async () => {
      const provider = new LocalRuntimeProvider();
      const fakeChannel = makeFakeChannel();
      vi.spyOn(provider as any, "launch").mockReturnValue({
        runtimeInstanceId: "12345:some-token",
        channel: fakeChannel,
      });

      await provider.launchWorker(makeCtx(), {});

      expect(fakeChannel.on).toHaveBeenCalledWith("exit", expect.any(Function));
      const exitHandler = fakeChannel.on.mock.calls.find(
        (call) => call[0] === "exit"
      )?.[1];
      expect(exitHandler).toBeInstanceOf(Function);

      exitHandler();

      provider.teardown({
        runtimeType: "local",
        ownerId: "owner-1",
        runtimeInstanceId: "12345:some-token",
        isolationScope: "workspace",
      });
      expect(fakeChannel.kill).not.toHaveBeenCalled();
    });

    it("calls ctx.onWorkerExit and removes the channel when the process exits", async () => {
      const provider = new LocalRuntimeProvider();
      const fakeChannel = makeFakeChannel();
      vi.spyOn(provider as any, "launch").mockReturnValue({
        runtimeInstanceId: "12345:some-token",
        channel: fakeChannel,
      });
      const onWorkerExit = vi.fn();

      await provider.launchWorker({ ...makeCtx(), onWorkerExit }, {});

      const exitHandler = fakeChannel.on.mock.calls.find(
        (call) => call[0] === "exit"
      )?.[1];
      exitHandler();

      expect(onWorkerExit).toHaveBeenCalledOnce();
      provider.teardown({
        runtimeType: "local",
        ownerId: "owner-1",
        runtimeInstanceId: "12345:some-token",
        isolationScope: "workspace",
      });
      expect(fakeChannel.kill).not.toHaveBeenCalled();
    });

    it("does not call onWorkerExit or delete the current channel when a stale/superseded channel exits", async () => {
      const provider = new LocalRuntimeProvider();
      const staleChannel = makeFakeChannel();
      const currentChannel = makeFakeChannel();
      const onWorkerExit = vi.fn();

      vi.spyOn(provider as any, "launch").mockReturnValueOnce({
        runtimeInstanceId: "stale:token",
        channel: staleChannel,
      });
      await provider.launchWorker({ ...makeCtx(), onWorkerExit }, {});
      const staleExitHandler = staleChannel.on.mock.calls.find(
        (call) => call[0] === "exit"
      )?.[1];

      // A newer launch for the same owner supersedes the stale channel.
      vi.spyOn(provider as any, "launch").mockReturnValueOnce({
        runtimeInstanceId: "current:token",
        channel: currentChannel,
      });
      await provider.launchWorker({ ...makeCtx(), onWorkerExit }, {});

      // The stale process's exit event fires late.
      staleExitHandler();

      expect(onWorkerExit).not.toHaveBeenCalled();
      provider.teardown({
        runtimeType: "local",
        ownerId: "owner-1",
        runtimeInstanceId: "current:token",
        isolationScope: "workspace",
      });
      expect(currentChannel.kill).toHaveBeenCalledWith("SIGTERM");
    });
  });
});
