import { describe, it, expect, vi } from "vitest";
import { IS_PUBLIC_KEY } from "../../auth/public.decorator";
import { RuntimeInternalController } from "./runtime-internal.controller";
import { RunEnvelopeProcessor } from "../../runs/execution/run-envelope.processor";
import { RunActiveStore } from "../../runs/execution/run-active.store";
import { RuntimeConfigStore } from "./runtime-config-store";
import { RuntimeService } from "../runtime.service";
import { RuntimeControlQueue } from "./runtime-control-queue";

const activeHandle = {
  runtimeHandle: {
    runId: "run-1",
    runtimeType: "docker",
    runtimeResourceId: "container-abc",
    conversationId: "conversation-1",
  },
};

function makeController(opts: {
  handle: unknown;
  runtimeService: Partial<RuntimeService>;
}) {
  const runEventProcessor: Partial<RunEnvelopeProcessor> = {
    publish: vi.fn().mockResolvedValue(undefined),
  };
  const runRegistry: Partial<RunActiveStore> = {
    get: vi.fn().mockReturnValue(opts.handle),
  };
  return new RuntimeInternalController(
    runEventProcessor as RunEnvelopeProcessor,
    {} as RuntimeConfigStore,
    runRegistry as RunActiveStore,
    opts.runtimeService as RuntimeService,
    {} as RuntimeControlQueue
  );
}

describe("RuntimeInternalController", () => {
  it("is marked @Public() so the global JwtAuthGuard does not block worker callbacks (auth is handled by RuntimeInternalAuthGuard)", () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, RuntimeInternalController)).toBe(true);
  });

  describe("postEvent()", () => {
    it("cleans up via RuntimeService on terminal status", async () => {
      const runtimeService: Partial<RuntimeService> = { cleanup: vi.fn() };
      const controller = makeController({ handle: activeHandle, runtimeService });

      await controller.postEvent("run-1", {
        runId: "run-1",
        seq: 1,
        type: "run.status",
        payload: { status: "finished" },
        ts: new Date().toISOString(),
      } as never);

      expect(runtimeService.cleanup).toHaveBeenCalledWith("run-1");
    });

    it("does not call cleanup for non-terminal run.status", async () => {
      const runtimeService: Partial<RuntimeService> = { cleanup: vi.fn() };
      const controller = makeController({ handle: activeHandle, runtimeService });

      await controller.postEvent("run-1", {
        runId: "run-1",
        seq: 1,
        type: "run.status",
        payload: { status: "running" },
        ts: new Date().toISOString(),
      } as never);

      expect(runtimeService.cleanup).not.toHaveBeenCalled();
    });

    it("feeds the heartbeat watchdog via RuntimeService on heartbeat events", async () => {
      const runtimeService: Partial<RuntimeService> = { heartbeat: vi.fn() };
      const controller = makeController({ handle: activeHandle, runtimeService });

      await controller.postEvent("run-1", {
        runId: "run-1",
        seq: 1,
        type: "heartbeat",
        payload: { at: new Date().toISOString() },
        ts: new Date().toISOString(),
      } as never);

      expect(runtimeService.heartbeat).toHaveBeenCalledWith("run-1");
    });

    it("does not feed heartbeat when no run handle is registered", async () => {
      const runtimeService: Partial<RuntimeService> = { heartbeat: vi.fn() };
      const controller = makeController({ handle: undefined, runtimeService });

      await controller.postEvent("run-1", {
        runId: "run-1",
        seq: 1,
        type: "heartbeat",
        payload: { at: new Date().toISOString() },
        ts: new Date().toISOString(),
      } as never);

      expect(runtimeService.heartbeat).not.toHaveBeenCalled();
    });
  });
});
