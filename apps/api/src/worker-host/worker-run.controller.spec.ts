import { describe, it, expect, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import type { RunConfig } from "@agework/shared/protocol";
import { IS_PUBLIC_KEY } from "../auth/public.decorator";
import { WorkerRunController } from "./worker-run.controller";
import { WorkerConfigStore } from "./config-store";
import { WorkerUpstreamRegistry } from "./worker-upstream.registry";

function makeController(opts: {
  configStore: Partial<WorkerConfigStore>;
  upstream: Partial<WorkerUpstreamRegistry>;
}) {
  return new WorkerRunController(
    opts.configStore as WorkerConfigStore,
    opts.upstream as WorkerUpstreamRegistry
  );
}

describe("WorkerRunController", () => {
  it("is marked @Public() so the global JwtAuthGuard does not block worker callbacks (auth is handled by WorkerAuthGuard)", () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, WorkerRunController)).toBe(true);
  });

  describe("getRunConfig()", () => {
    it("returns the stored RunConfig", async () => {
      const config = {
        conversationId: "conversation-1",
        workspaceId: "ws-1",
        agentProviderConfig: { agentType: "claude", source: "system" },
      } as unknown as RunConfig;
      const controller = makeController({
        configStore: { get: vi.fn().mockReturnValue(config) },
        upstream: {},
      });

      await expect(controller.getRunConfig("run-1")).resolves.toEqual({
        config,
      });
    });

    it("throws NotFoundException when config is missing", async () => {
      const controller = makeController({
        configStore: { get: vi.fn().mockReturnValue(undefined) },
        upstream: {},
      });

      await expect(controller.getRunConfig("run-1")).rejects.toBeInstanceOf(
        NotFoundException
      );
    });
  });

  describe("postEvent()", () => {
    it("delegates the envelope to the upstream sink", async () => {
      const ingestEvent = vi.fn().mockResolvedValue(undefined);
      const controller = makeController({
        configStore: {},
        upstream: { ingestEvent },
      });

      const envelope = {
        runId: "run-1",
        seq: 1,
        type: "heartbeat",
        payload: {},
        ts: new Date().toISOString(),
      };
      await expect(controller.postEvent("run-1", envelope)).resolves.toEqual({
        ok: true,
      });
      expect(ingestEvent).toHaveBeenCalledWith("run-1", envelope);
    });
  });
});
