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
    it("sends SIGTERM to the pid encoded in a 'pid:token' runtimeInstanceId", async () => {
      const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
      const provider = new LocalRuntimeProvider();

      await provider.recoverOrphan("12345:some-token");

      expect(killSpy).toHaveBeenCalledWith(12345, "SIGTERM");
    });

    it("does nothing for a malformed runtimeInstanceId", async () => {
      const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
      const provider = new LocalRuntimeProvider();

      await provider.recoverOrphan("not-a-valid-runtime-id");

      expect(killSpy).not.toHaveBeenCalled();
    });

    it("ignores ESRCH when the process is already gone", async () => {
      vi.spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      });
      const provider = new LocalRuntimeProvider();

      await expect(
        provider.recoverOrphan("12345:some-token")
      ).resolves.toBeUndefined();
    });
  });
});
