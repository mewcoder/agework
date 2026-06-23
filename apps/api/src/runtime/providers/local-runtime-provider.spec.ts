import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LocalRuntimeProvider } from "./local-runtime-provider";
import { RunEnvelopeProcessor } from "../../runs/execution/run-envelope.processor";

describe("LocalRuntimeProvider", () => {
  let provider: LocalRuntimeProvider;
  let mockEventProcessor: Partial<RunEnvelopeProcessor>;

  beforeEach(() => {
    mockEventProcessor = {
      publish: vi.fn().mockResolvedValue(undefined),
    };
    provider = new LocalRuntimeProvider(
      mockEventProcessor as RunEnvelopeProcessor,
      { append: vi.fn().mockResolvedValue({}) } as never
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a provider instance", () => {
    expect(provider).toBeDefined();
  });

  it("getHandle returns undefined for unknown runId", () => {
    expect(provider.getHandle("nonexistent")).toBeUndefined();
  });

  describe("recoverOrphan()", () => {
    it("sends SIGTERM to the pid encoded in a 'pid:token' runtimeResourceId", async () => {
      const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);

      await provider.recoverOrphan("12345:some-token");

      expect(killSpy).toHaveBeenCalledWith(12345, "SIGTERM");
    });

    it("does nothing for a malformed runtimeResourceId", async () => {
      const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);

      await provider.recoverOrphan("not-a-valid-runtime-id");

      expect(killSpy).not.toHaveBeenCalled();
    });

    it("ignores ESRCH when the process is already gone", async () => {
      vi.spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      });

      await expect(provider.recoverOrphan("12345:some-token")).resolves.toBeUndefined();
    });
  });
});
