import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { RUNTIME_WORKER_HTTP_PROTOCOL_VERSION } from "@agework/shared/protocol";
import { WorkerHttpServer } from "./worker-http-server.js";
import type { RuntimeHost } from "./runtime-host.js";

describe("WorkerHttpServer register protocol", () => {
  let host: { registerWorker: ReturnType<typeof vi.fn> };
  let server: WorkerHttpServer;
  let baseUrl: string;

  beforeEach(async () => {
    host = { registerWorker: vi.fn().mockReturnValue(true) };
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
});
