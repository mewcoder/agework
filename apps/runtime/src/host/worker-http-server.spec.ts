import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { RUNTIME_WORKER_HTTP_PROTOCOL_VERSION } from "@agework/shared/protocol";
import { WorkerHttpServer } from "./worker-http-server.js";
import type { RuntimeHost } from "./runtime-host.js";
import { WorkerEventRequestError } from "./worker-event-request.error.js";

describe("WorkerHttpServer register protocol", () => {
  let host: {
    registerWorker: ReturnType<typeof vi.fn>;
    validateWorkerToken: ReturnType<typeof vi.fn>;
    postEvent: ReturnType<typeof vi.fn>;
  };
  let server: WorkerHttpServer;
  let baseUrl: string;

  beforeEach(async () => {
    host = {
      registerWorker: vi.fn().mockReturnValue(true),
      validateWorkerToken: vi.fn().mockReturnValue(true),
      postEvent: vi.fn().mockResolvedValue({ ok: true }),
    };
    server = new WorkerHttpServer(host as unknown as RuntimeHost, 0);
    await server.start();
    const address = (server as unknown as { server: Server }).server.address();
    if (typeof address !== "object" || address === null) {
      throw new Error("worker HTTP server has no address");
    }
    baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
  });

  afterEach(async () => {
    await server.stop();
    vi.restoreAllMocks();
  });

  async function register(body: Record<string, unknown>) {
    return fetch(`${baseUrl}/worker/worker-1/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("rejects an explicit protocol mismatch before consuming the handshake", async () => {
    const response = await register({
      startToken: "start-1",
      protocolVersion: RUNTIME_WORKER_HTTP_PROTOCOL_VERSION + 1,
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: `incompatible worker protocol: worker=${RUNTIME_WORKER_HTTP_PROTOCOL_VERSION + 1} host=${RUNTIME_WORKER_HTTP_PROTOCOL_VERSION}`,
    });
    expect(host.registerWorker).not.toHaveBeenCalled();
  });

  it("accepts the current protocol and echoes the negotiated version", async () => {
    const response = await register({
      startToken: "start-1",
      pid: 42,
      protocolVersion: RUNTIME_WORKER_HTTP_PROTOCOL_VERSION,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      protocolVersion: RUNTIME_WORKER_HTTP_PROTOCOL_VERSION,
    });
    expect(host.registerWorker).toHaveBeenCalledWith("worker-1", "start-1", {
      pid: 42,
    });
  });

  it("rejects a worker without a protocol version", async () => {
    const response = await register({ startToken: "start-1" });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: `incompatible worker protocol: worker=undefined host=${RUNTIME_WORKER_HTTP_PROTOCOL_VERSION}`,
    });
    expect(host.registerWorker).not.toHaveBeenCalled();
  });

  it("rejects malformed registration fields before consuming the handshake", async () => {
    const response = await register({
      startToken: 42,
      protocolVersion: RUNTIME_WORKER_HTTP_PROTOCOL_VERSION,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid worker register request",
    });
    expect(host.registerWorker).not.toHaveBeenCalled();
  });

  it("returns 500 when downstream event processing fails so the worker retries", async () => {
    host.postEvent.mockRejectedValueOnce(new Error("database unavailable"));

    const response = await fetch(`${baseUrl}/worker/runs/run-1/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-agework-worker-id": "worker-1",
        "x-agework-worker-token": "token-1",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "worker.event" }),
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "database unavailable",
    });
  });

  it("returns 400 for a permanently invalid worker event request", async () => {
    host.postEvent.mockRejectedValueOnce(
      new WorkerEventRequestError("Invalid worker event body")
    );

    const response = await fetch(`${baseUrl}/worker/runs/run-1/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-agework-worker-id": "worker-1",
        "x-agework-worker-token": "token-1",
      },
      body: "{}",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid worker event body",
    });
  });
});
