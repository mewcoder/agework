import { describe, it, expect, vi } from "vitest";
import { IS_PUBLIC_KEY } from "../../auth/public.decorator";
import { RuntimeInternalController } from "./runtime-internal.controller";
import { RuntimeEventProcessor } from "../core/runtime-event-processor";
import { RuntimeActiveStore } from "../core/runtime-active-store";
import { RuntimeConfigStore } from "./runtime-config-store";
import { RuntimeProviderRegistry } from "../providers/runtime-provider-registry";
import { RuntimeControlQueue } from "./runtime-control-queue";

describe("RuntimeInternalController", () => {
  it("is marked @Public() so the global JwtAuthGuard does not block worker callbacks (auth is handled by RuntimeInternalAuthGuard)", () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, RuntimeInternalController)).toBe(true);
  });

  describe("postEvent()", () => {
    it("cleans up via the provider matching the run's runtimeType on terminal status, without depending on a concrete provider", async () => {
      const cleanup = vi.fn();
      const runEventProcessor: Partial<RuntimeEventProcessor> = {
        publish: vi.fn().mockResolvedValue(undefined),
      };
      const runRegistry: Partial<RuntimeActiveStore> = {
        get: vi.fn().mockReturnValue({
          runtimeHandle: { runId: "run-1", runtimeType: "docker", runtimeResourceId: "container-abc", conversationId: "conversation-1" },
        }),
      };
      const runtimeProviderRegistry: Partial<RuntimeProviderRegistry> = {
        resolve: vi.fn().mockReturnValue({ cleanup }),
      };

      const controller = new RuntimeInternalController(
        runEventProcessor as RuntimeEventProcessor,
        {} as RuntimeConfigStore,
        runRegistry as RuntimeActiveStore,
        runtimeProviderRegistry as RuntimeProviderRegistry,
        {} as RuntimeControlQueue
      );

      await controller.postEvent("run-1", {
        runId: "run-1",
        seq: 1,
        type: "run.status",
        payload: { status: "finished" },
        ts: new Date().toISOString(),
      } as never);

      expect(runtimeProviderRegistry.resolve).toHaveBeenCalledWith("docker");
      expect(cleanup).toHaveBeenCalledWith("run-1");
    });

    it("does not call cleanup for non-terminal run.status", async () => {
      const cleanup = vi.fn();
      const runEventProcessor: Partial<RuntimeEventProcessor> = {
        publish: vi.fn().mockResolvedValue(undefined),
      };
      const runRegistry: Partial<RuntimeActiveStore> = {
        get: vi.fn().mockReturnValue({
          runtimeHandle: { runId: "run-1", runtimeType: "docker", runtimeResourceId: "container-abc", conversationId: "conversation-1" },
        }),
      };
      const runtimeProviderRegistry: Partial<RuntimeProviderRegistry> = {
        resolve: vi.fn().mockReturnValue({ cleanup }),
      };

      const controller = new RuntimeInternalController(
        runEventProcessor as RuntimeEventProcessor,
        {} as RuntimeConfigStore,
        runRegistry as RuntimeActiveStore,
        runtimeProviderRegistry as RuntimeProviderRegistry,
        {} as RuntimeControlQueue
      );

      await controller.postEvent("run-1", {
        runId: "run-1",
        seq: 1,
        type: "run.status",
        payload: { status: "running" },
        ts: new Date().toISOString(),
      } as never);

      expect(cleanup).not.toHaveBeenCalled();
    });

    it("feeds the heartbeat watchdog of the run's provider on heartbeat events", async () => {
      const heartbeat = vi.fn();
      const runEventProcessor: Partial<RuntimeEventProcessor> = {
        publish: vi.fn().mockResolvedValue(undefined),
      };
      const runRegistry: Partial<RuntimeActiveStore> = {
        get: vi.fn().mockReturnValue({
          runtimeHandle: { runId: "run-1", runtimeType: "docker", runtimeResourceId: "container-abc", conversationId: "conversation-1" },
        }),
      };
      const runtimeProviderRegistry: Partial<RuntimeProviderRegistry> = {
        resolve: vi.fn().mockReturnValue({ heartbeat }),
      };

      const controller = new RuntimeInternalController(
        runEventProcessor as RuntimeEventProcessor,
        {} as RuntimeConfigStore,
        runRegistry as RuntimeActiveStore,
        runtimeProviderRegistry as RuntimeProviderRegistry,
        {} as RuntimeControlQueue
      );

      await controller.postEvent("run-1", {
        runId: "run-1",
        seq: 1,
        type: "heartbeat",
        payload: { at: new Date().toISOString() },
        ts: new Date().toISOString(),
      } as never);

      expect(runtimeProviderRegistry.resolve).toHaveBeenCalledWith("docker");
      expect(heartbeat).toHaveBeenCalledWith("run-1");
    });

    it("does not throw on heartbeat when no run handle is registered", async () => {
      const runEventProcessor: Partial<RuntimeEventProcessor> = {
        publish: vi.fn().mockResolvedValue(undefined),
      };
      const runRegistry: Partial<RuntimeActiveStore> = {
        get: vi.fn().mockReturnValue(undefined),
      };
      const runtimeProviderRegistry: Partial<RuntimeProviderRegistry> = {
        resolve: vi.fn(),
      };

      const controller = new RuntimeInternalController(
        runEventProcessor as RuntimeEventProcessor,
        {} as RuntimeConfigStore,
        runRegistry as RuntimeActiveStore,
        runtimeProviderRegistry as RuntimeProviderRegistry,
        {} as RuntimeControlQueue
      );

      await controller.postEvent("run-1", {
        runId: "run-1",
        seq: 1,
        type: "heartbeat",
        payload: { at: new Date().toISOString() },
        ts: new Date().toISOString(),
      } as never);

      expect(runtimeProviderRegistry.resolve).not.toHaveBeenCalled();
    });
  });
});
