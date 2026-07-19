import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpstreamMessage } from "@agework/shared/protocol";
import { RunnerIpcTransport } from "./runner-ipc";

const originalSend = process.send;

describe("RunnerIpcTransport", () => {
  let send: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    send = vi.fn((_message, callback?: (err: Error | null) => void) => {
      callback?.(null);
      return true;
    });
    Object.defineProperty(process, "send", {
      configurable: true,
      value: send,
    });
    vi.stubEnv("AGEWORK_WORKER_RUN_ID", "run-1");
  });

  afterEach(() => {
    if (originalSend) {
      Object.defineProperty(process, "send", {
        configurable: true,
        value: originalSend,
      });
    } else {
      delete (process as { send?: unknown }).send;
    }
    vi.unstubAllEnvs();
  });

  it("fetches run config from a JSON-RPC notification", async () => {
    const channel = new RunnerIpcTransport();
    const configPromise = channel.fetchRunConfig();

    (process.emit as (event: string, message: unknown) => boolean)("message", {
      jsonrpc: "2.0",
      method: "run.config",
      params: {
        runId: "run-1",
        config: {
          runId: "run-1",
          conversationId: "conv-1",
          workspaceId: "ws-1",
          runtimePath: "/workspace",
          env: {},
          input: {},
          agentProviderConfig: { agentType: "claude", source: "system" },
        },
      },
      meta: {
        runId: "run-1",
        seq: 0,
        ts: "2026-06-27T00:00:00.000Z",
      },
    });

    await expect(configPromise).resolves.toMatchObject({
      runId: "run-1",
      conversationId: "conv-1",
    });
  });

  it("emits upstream events as JSON-RPC notifications", async () => {
    const channel = new RunnerIpcTransport();

    await channel.emit({
      runId: "run-1",
      seq: 0,
      type: "run.status",
      payload: { status: "running" },
      ts: "",
    } as UpstreamMessage);

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        jsonrpc: "2.0",
        method: "run.status",
        params: {
          runId: "run-1",
          status: { status: "running" },
        },
        meta: expect.objectContaining({
          runId: "run-1",
          seq: 1,
        }),
      }),
      expect.any(Function)
    );
  });

  it("subscribes to JSON-RPC command requests", () => {
    const channel = new RunnerIpcTransport();
    const received: unknown[] = [];
    const unsubscribe = channel.subscribeCommands((command) => {
      received.push(command);
    });

    (process.emit as (event: string, message: unknown) => boolean)("message", {
      jsonrpc: "2.0",
      id: "cmd-1",
      method: "run.cancel",
      params: {
        runId: "run-1",
        conversationId: "conv-1",
      },
      meta: {
        runId: "run-1",
        seq: 1,
        ts: "2026-06-27T00:00:00.000Z",
      },
    });
    unsubscribe();

    expect(received).toEqual([
      {
        runId: "run-1",
        seq: 1,
        type: "command",
        payload: {
          type: "cancel",
          commandId: "cmd-1",
          runId: "run-1",
          conversationId: "conv-1",
        },
        ts: "2026-06-27T00:00:00.000Z",
      },
    ]);
  });
});
