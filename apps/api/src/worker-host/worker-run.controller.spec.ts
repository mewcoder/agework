import { describe, it, expect, vi } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { RunConfig } from "@agework/shared/protocol";
import { IS_PUBLIC_KEY } from "../auth/decorators/public.decorator";
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
    it("rejects legacy message event bodies", async () => {
      const sendEvent = vi.fn().mockResolvedValue(undefined);
      const controller = makeController({
        configStore: {},
        upstream: { sendEvent },
      });

      const message = {
        runId: "run-1",
        seq: 1,
        type: "agui.event",
        payload: {},
        ts: new Date().toISOString(),
      };
      await expect(
        controller.postEvent("run-1", message)
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(sendEvent).not.toHaveBeenCalled();
    });

    it("accepts a JSON-RPC notification and forwards the normalized event", async () => {
      const sendEvent = vi.fn().mockResolvedValue(undefined);
      const controller = makeController({
        configStore: {},
        upstream: { sendEvent },
      });

      await expect(
        controller.postEvent("run-1", {
          jsonrpc: "2.0",
          method: "run.aguiEvent",
          params: {
            runId: "run-1",
            event: { type: "RUN_STARTED" },
          },
          meta: {
            runId: "run-1",
            seq: 2,
            ts: "2026-06-27T00:00:00.000Z",
          },
        })
      ).resolves.toEqual({ ok: true });

      expect(sendEvent).toHaveBeenCalledWith("run-1", {
        runId: "run-1",
        seq: 2,
        type: "agui.event",
        payload: { type: "RUN_STARTED" },
        ts: "2026-06-27T00:00:00.000Z",
      });
    });

    it("accepts a JSON-RPC batch array", async () => {
      const sendEvent = vi.fn().mockResolvedValue(undefined);
      const controller = makeController({
        configStore: {},
        upstream: { sendEvent },
      });

      await controller.postEvent("run-1", [
        {
          jsonrpc: "2.0",
          method: "run.status",
          params: {
            runId: "run-1",
            status: { status: "running" },
          },
          meta: {
            runId: "run-1",
            seq: 1,
            ts: "2026-06-27T00:00:00.000Z",
          },
        },
        {
          jsonrpc: "2.0",
          method: "run.aguiEvent",
          params: {
            runId: "run-1",
            event: { type: "RUN_STARTED" },
          },
          meta: {
            runId: "run-1",
            seq: 2,
            ts: "2026-06-27T00:00:01.000Z",
          },
        },
      ]);

      expect(sendEvent).toHaveBeenCalledTimes(2);
      expect(sendEvent).toHaveBeenNthCalledWith(
        1,
        "run-1",
        expect.objectContaining({ type: "run.status", seq: 1 })
      );
      expect(sendEvent).toHaveBeenNthCalledWith(
        2,
        "run-1",
        expect.objectContaining({ type: "agui.event", seq: 2 })
      );
    });

    it("rejects wrapper-style batch bodies", async () => {
      const sendEvent = vi.fn().mockResolvedValue(undefined);
      const controller = makeController({
        configStore: {},
        upstream: { sendEvent },
      });

      await expect(
        controller.postEvent("run-1", {
          messages: [
            {
              jsonrpc: "2.0",
              method: "run.status",
              params: {
                runId: "run-1",
                status: { status: "running" },
              },
              meta: {
                runId: "run-1",
                seq: 1,
                ts: "2026-06-27T00:00:00.000Z",
              },
            },
            {
              jsonrpc: "2.0",
              method: "run.aguiEvent",
              params: {
                runId: "run-1",
                event: { type: "RUN_STARTED" },
              },
              meta: {
                runId: "run-1",
                seq: 2,
                ts: "2026-06-27T00:00:01.000Z",
              },
            },
          ],
        })
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(sendEvent).not.toHaveBeenCalled();
    });

    it("rejects the whole JSON-RPC batch when any item is invalid", async () => {
      const sendEvent = vi.fn().mockResolvedValue(undefined);
      const controller = makeController({
        configStore: {},
        upstream: { sendEvent },
      });

      await expect(
        controller.postEvent("run-1", [
          {
            jsonrpc: "2.0",
            method: "run.status",
            params: {
              runId: "run-1",
              status: { status: "running" },
            },
            meta: {
              runId: "run-1",
              seq: 1,
              ts: "2026-06-27T00:00:00.000Z",
            },
          },
          {
            jsonrpc: "2.0",
            method: "unknown",
            params: {},
          },
        ])
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(sendEvent).not.toHaveBeenCalled();
    });

    it("rejects the whole JSON-RPC batch when any item targets another run", async () => {
      const sendEvent = vi.fn().mockResolvedValue(undefined);
      const controller = makeController({
        configStore: {},
        upstream: { sendEvent },
      });

      await expect(
        controller.postEvent("run-1", [
          {
            jsonrpc: "2.0",
            method: "run.status",
            params: {
              runId: "run-1",
              status: { status: "running" },
            },
            meta: {
              runId: "run-1",
              seq: 1,
              ts: "2026-06-27T00:00:00.000Z",
            },
          },
          {
            jsonrpc: "2.0",
            method: "run.aguiEvent",
            params: {
              runId: "run-2",
              event: { type: "RUN_STARTED" },
            },
            meta: {
              runId: "run-2",
              seq: 2,
              ts: "2026-06-27T00:00:01.000Z",
            },
          },
        ])
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(sendEvent).not.toHaveBeenCalled();
    });

    it("rejects empty and nested JSON-RPC batches", async () => {
      const sendEvent = vi.fn().mockResolvedValue(undefined);
      const controller = makeController({
        configStore: {},
        upstream: { sendEvent },
      });
      const event = {
        jsonrpc: "2.0",
        method: "run.status",
        params: {
          runId: "run-1",
          status: { status: "running" },
        },
        meta: {
          runId: "run-1",
          seq: 1,
          ts: "2026-06-27T00:00:00.000Z",
        },
      };

      await expect(controller.postEvent("run-1", [])).rejects.toBeInstanceOf(
        BadRequestException
      );
      await expect(
        controller.postEvent("run-1", [[event]])
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(sendEvent).not.toHaveBeenCalled();
    });

    it("accepts a JSON-RPC command response and forwards command.result", async () => {
      const sendEvent = vi.fn().mockResolvedValue(undefined);
      const controller = makeController({
        configStore: {},
        upstream: { sendEvent },
      });

      await controller.postEvent("run-1", {
        jsonrpc: "2.0",
        id: "cmd-1",
        result: {
          ok: true,
          commandType: "cancel",
        },
        meta: {
          seq: 3,
          ts: "2026-06-27T00:00:00.000Z",
        },
      });

      expect(sendEvent).toHaveBeenCalledWith("run-1", {
        runId: "run-1",
        seq: 3,
        type: "command.result",
        payload: {
          commandId: "cmd-1",
          commandType: "cancel",
          status: "ok",
        },
        ts: "2026-06-27T00:00:00.000Z",
      });
    });

    it("rejects JSON-RPC responses that are not command results", async () => {
      const sendEvent = vi.fn().mockResolvedValue(undefined);
      const controller = makeController({
        configStore: {},
        upstream: { sendEvent },
      });

      await expect(
        controller.postEvent("run-1", {
          jsonrpc: "2.0",
          id: "cmd-1",
          result: {
            ok: true,
          },
        })
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(sendEvent).not.toHaveBeenCalled();
    });

    it("rejects invalid event bodies", async () => {
      const sendEvent = vi.fn().mockResolvedValue(undefined);
      const controller = makeController({
        configStore: {},
        upstream: { sendEvent },
      });

      await expect(
        controller.postEvent("run-1", { jsonrpc: "2.0", method: "unknown" })
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(sendEvent).not.toHaveBeenCalled();
    });
  });
});
