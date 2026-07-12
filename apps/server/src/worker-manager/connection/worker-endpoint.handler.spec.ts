import { describe, it, expect, vi } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { RunConfig } from "@agework/shared/protocol";
import { WorkerCommandQueue } from "./command-queue";
import { WorkerConfigStore } from "./worker-config.store";
import type { WorkerUpstreamPort } from "../worker-manager.types";
import { WorkerEndpointHandler } from "./worker-endpoint.handler";

function makeHandler(opts: {
  commandQueue?: Partial<WorkerCommandQueue>;
  configStore?: Partial<WorkerConfigStore>;
  upstream?: Partial<WorkerUpstreamPort>;
}) {
  const commandQueue = {
    epochFor: vi.fn().mockReturnValue(0),
    pollByWorkerId: vi.fn().mockReturnValue([]),
    waitForWorkerId: vi.fn().mockResolvedValue([]),
    ...opts.commandQueue,
  } as unknown as WorkerCommandQueue;
  const configStore = (opts.configStore ?? {}) as WorkerConfigStore;
  const handler = new WorkerEndpointHandler(commandQueue, configStore);
  if (opts.upstream) {
    handler.setUpstreamPort(opts.upstream as WorkerUpstreamPort);
  }
  return handler;
}

const commandMessage = {
  seq: 1,
  runId: "run-1",
  type: "command",
  payload: {
    type: "cancel",
    commandId: "cmd-1",
    runId: "run-1",
    conversationId: "conv-1",
  },
  ts: "2026-06-27T00:00:00.000Z",
} as never;

describe("WorkerEndpointHandler", () => {
  describe("pollCommands()", () => {
    it("polls the command queue by workerId and afterSeq", async () => {
      const pollByWorkerId = vi.fn().mockReturnValue([commandMessage]);
      const epochFor = vi.fn().mockReturnValue(1000);
      const handler = makeHandler({
        commandQueue: { pollByWorkerId, epochFor },
      });

      const result = await handler.pollCommands("worker-1", { afterSeq: 3 });

      expect(pollByWorkerId).toHaveBeenCalledWith("worker-1", 3);
      expect(result).toEqual({
        messages: [
          {
            jsonrpc: "2.0",
            id: "cmd-1",
            method: "run.cancel",
            params: { runId: "run-1", conversationId: "conv-1" },
            meta: { runId: "run-1", seq: 1, ts: "2026-06-27T00:00:00.000Z" },
          },
        ],
        queueEpoch: 1000,
      });
    });

    it("returns the current queueEpoch regardless of whether commands were found", async () => {
      const pollByWorkerId = vi.fn().mockReturnValue([]);
      const epochFor = vi.fn().mockReturnValue(4242);
      const handler = makeHandler({
        commandQueue: { pollByWorkerId, epochFor },
      });

      const result = await handler.pollCommands("worker-1", { afterSeq: 0 });

      expect(epochFor).toHaveBeenCalledWith("worker-1");
      expect(result.queueEpoch).toBe(4242);
    });

    it("defaults afterSeq to 0 when not provided", async () => {
      const pollByWorkerId = vi.fn().mockReturnValue([]);
      const handler = makeHandler({ commandQueue: { pollByWorkerId } });

      await handler.pollCommands("worker-1", {});

      expect(pollByWorkerId).toHaveBeenCalledWith("worker-1", 0);
    });

    it("defaults afterSeq to 0 when only waitMs is provided", async () => {
      const pollByWorkerId = vi.fn().mockReturnValue([]);
      const handler = makeHandler({ commandQueue: { pollByWorkerId } });

      await handler.pollCommands("worker-1", { waitMs: 0 });

      expect(pollByWorkerId).toHaveBeenCalledWith("worker-1", 0);
    });

    it("long-polls when waitMs is provided", async () => {
      const waitForWorkerId = vi.fn().mockResolvedValue([
        {
          seq: 2,
          runId: "run-2",
          type: "command",
          payload: {
            type: "user_message",
            commandId: "cmd-2",
            runId: "run-2",
          },
          ts: "2026-06-27T00:00:00.000Z",
        },
      ]);
      const handler = makeHandler({ commandQueue: { waitForWorkerId } });

      const result = await handler.pollCommands("worker-1", {
        afterSeq: 1,
        waitMs: 25000,
      });

      expect(waitForWorkerId).toHaveBeenCalledWith("worker-1", 1, 25000);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]).toMatchObject({
        id: "cmd-2",
        method: "run.start",
      });
    });
  });

  describe("getRunConfig()", () => {
    it("returns the stored RunConfig", () => {
      const config = {
        conversationId: "conversation-1",
        workspaceId: "ws-1",
        agentProviderConfig: { agentType: "claude", source: "system" },
      } as unknown as RunConfig;
      const handler = makeHandler({
        configStore: { get: vi.fn().mockReturnValue(config) },
      });

      expect(handler.getRunConfig("run-1")).toEqual({ config });
    });

    it("throws NotFoundException when config is missing", () => {
      const handler = makeHandler({
        configStore: { get: vi.fn().mockReturnValue(undefined) },
      });

      expect(() => handler.getRunConfig("run-1")).toThrow(NotFoundException);
    });
  });

  describe("postEvent()", () => {
    it("rejects legacy message event bodies", async () => {
      const sendEvent = vi.fn().mockResolvedValue(undefined);
      const handler = makeHandler({ upstream: { sendEvent } });

      await expect(
        handler.postEvent("run-1", {
          runId: "run-1",
          seq: 1,
          type: "agui.event",
          payload: {},
          ts: new Date().toISOString(),
        })
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(sendEvent).not.toHaveBeenCalled();
    });

    it("accepts a JSON-RPC notification and forwards the normalized event", async () => {
      const sendEvent = vi.fn().mockResolvedValue(undefined);
      const handler = makeHandler({ upstream: { sendEvent } });

      await expect(
        handler.postEvent("run-1", {
          jsonrpc: "2.0",
          method: "run.aguiEvent",
          params: { runId: "run-1", event: { type: "RUN_STARTED" } },
          meta: { runId: "run-1", seq: 2, ts: "2026-06-27T00:00:00.000Z" },
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

    it("accepts a JSON-RPC batch array, forwarding each in order", async () => {
      const sendEvent = vi.fn().mockResolvedValue(undefined);
      const handler = makeHandler({ upstream: { sendEvent } });

      await handler.postEvent("run-1", [
        {
          jsonrpc: "2.0",
          method: "run.status",
          params: { runId: "run-1", status: { status: "running" } },
          meta: { runId: "run-1", seq: 1, ts: "2026-06-27T00:00:00.000Z" },
        },
        {
          jsonrpc: "2.0",
          method: "run.aguiEvent",
          params: { runId: "run-1", event: { type: "RUN_STARTED" } },
          meta: { runId: "run-1", seq: 2, ts: "2026-06-27T00:01:00.000Z" },
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
      const handler = makeHandler({ upstream: { sendEvent } });

      await expect(
        handler.postEvent("run-1", {
          messages: [
            {
              jsonrpc: "2.0",
              method: "run.status",
              params: { runId: "run-1", status: { status: "running" } },
              meta: { runId: "run-1", seq: 1, ts: "2026-06-27T00:00:00.000Z" },
            },
          ],
        })
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(sendEvent).not.toHaveBeenCalled();
    });

    it("rejects the whole batch when any item is invalid", async () => {
      const sendEvent = vi.fn().mockResolvedValue(undefined);
      const handler = makeHandler({ upstream: { sendEvent } });

      await expect(
        handler.postEvent("run-1", [
          {
            jsonrpc: "2.0",
            method: "run.status",
            params: { runId: "run-1", status: { status: "running" } },
            meta: { runId: "run-1", seq: 1, ts: "2026-06-27T00:00:00.000Z" },
          },
          { jsonrpc: "2.0", method: "unknown", params: {} },
        ])
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(sendEvent).not.toHaveBeenCalled();
    });

    it("rejects the whole batch when any item targets another run", async () => {
      const sendEvent = vi.fn().mockResolvedValue(undefined);
      const handler = makeHandler({ upstream: { sendEvent } });

      await expect(
        handler.postEvent("run-1", [
          {
            jsonrpc: "2.0",
            method: "run.status",
            params: { runId: "run-1", status: { status: "running" } },
            meta: { runId: "run-1", seq: 1, ts: "2026-06-27T00:00:00.000Z" },
          },
          {
            jsonrpc: "2.0",
            method: "run.aguiEvent",
            params: { runId: "run-2", event: { type: "RUN_STARTED" } },
            meta: { runId: "run-2", seq: 2, ts: "2026-06-27T00:01:00.000Z" },
          },
        ])
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(sendEvent).not.toHaveBeenCalled();
    });

    it("rejects empty and nested batches", async () => {
      const sendEvent = vi.fn().mockResolvedValue(undefined);
      const handler = makeHandler({ upstream: { sendEvent } });
      const event = {
        jsonrpc: "2.0",
        method: "run.status",
        params: { runId: "run-1", status: { status: "running" } },
        meta: { runId: "run-1", seq: 1, ts: "2026-06-27T00:00:00.000Z" },
      };

      await expect(handler.postEvent("run-1", [])).rejects.toBeInstanceOf(
        BadRequestException
      );
      await expect(
        handler.postEvent("run-1", [[event]])
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(sendEvent).not.toHaveBeenCalled();
    });

    it("accepts a JSON-RPC command response and forwards command.result", async () => {
      const sendEvent = vi.fn().mockResolvedValue(undefined);
      const handler = makeHandler({ upstream: { sendEvent } });

      await handler.postEvent("run-1", {
        jsonrpc: "2.0",
        id: "cmd-1",
        result: { ok: true, commandType: "cancel" },
        meta: { seq: 3, ts: "2026-06-27T00:00:00.000Z" },
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
      const handler = makeHandler({ upstream: { sendEvent } });

      await expect(
        handler.postEvent("run-1", {
          jsonrpc: "2.0",
          id: "cmd-1",
          result: { ok: true },
        })
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(sendEvent).not.toHaveBeenCalled();
    });

    it("rejects invalid event bodies", async () => {
      const sendEvent = vi.fn().mockResolvedValue(undefined);
      const handler = makeHandler({ upstream: { sendEvent } });

      await expect(
        handler.postEvent("run-1", { jsonrpc: "2.0", method: "unknown" })
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(sendEvent).not.toHaveBeenCalled();
    });
  });
});
