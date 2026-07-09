import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { WebSocket } from "ws";
import type { ConfigService } from "../../config/config.service";
import type { HttpAdapterHost } from "@nestjs/core";
import { RuntimeTunnelHandler } from "./runtime-tunnel.handler";

const GOOD_TOKEN = "good-token";
const GOOD_HASH = createHash("sha256").update(GOOD_TOKEN).digest("hex");
const MANAGED_TOKEN = "managed-token";
const MANAGED_HASH = createHash("sha256").update(MANAGED_TOKEN).digest("hex");
const MANAGED_RUNTIME_ID = "managed-docker";

function makeRepository() {
  return {
    findByTokenHash: vi
      .fn()
      .mockImplementation((hash: string) =>
        Promise.resolve(
          hash === GOOD_HASH
            ? { id: "rt-1" }
            : hash === MANAGED_HASH
              ? { id: MANAGED_RUNTIME_ID }
              : null
        )
      ),
    markRegistered: vi.fn().mockResolvedValue(true),
    touchHeartbeat: vi.fn().mockResolvedValue(true),
    markOffline: vi.fn().mockResolvedValue(undefined),
  };
}

describe("RuntimeTunnelHandler", () => {
  let server: Server;
  let baseUrl: string;
  let repository: ReturnType<typeof makeRepository>;
  let handler: RuntimeTunnelHandler;
  let sockets: WebSocket[];

  beforeEach(async () => {
    server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (typeof address !== "object" || address === null) {
      throw new Error("no server address");
    }
    baseUrl = `ws://127.0.0.1:${address.port}`;
    repository = makeRepository();
    const configService = {
      getHeartbeatTimeoutSeconds: vi.fn().mockReturnValue(30),
    } as unknown as ConfigService;
    const adapterHost = {
      httpAdapter: { getHttpServer: () => server },
    } as unknown as HttpAdapterHost;
    handler = new RuntimeTunnelHandler(
      repository as never,
      configService,
      adapterHost
    );
    handler.onApplicationBootstrap();
    sockets = [];
  });

  afterEach(async () => {
    handler.onApplicationShutdown();
    for (const ws of sockets) ws.terminate();
    server.close();
    await once(server, "close");
  });

  function connect(token = GOOD_TOKEN): WebSocket {
    const ws = new WebSocket(`${baseUrl}/api/v1/runtimes/tunnel`, {
      headers: { authorization: `Bearer ${token}` },
    });
    sockets.push(ws);
    return ws;
  }

  async function nextMessage(ws: WebSocket): Promise<unknown> {
    const [data] = (await once(ws, "message")) as [unknown];
    return JSON.parse(String(data));
  }

  it("accepts a valid token, handles register and replies registered", async () => {
    const ws = connect();
    await once(ws, "open");
    ws.send(
      JSON.stringify({
        type: "register",
        runtimeType: "docker",
        capabilities: { isolationScopes: ["user", "workspace"] },
      })
    );
    await expect(nextMessage(ws)).resolves.toEqual({
      type: "registered",
      runtimeId: "rt-1",
      heartbeatIntervalSeconds: 10,
    });
    expect(repository.markRegistered).toHaveBeenCalledWith(
      "rt-1",
      "docker",
      { isolationScopes: ["user", "workspace"] },
      undefined
    );
  });

  it("rejects a bad token during upgrade", async () => {
    const ws = connect("bad-token");
    const [err] = (await once(ws, "error")) as [Error];
    expect(err.message).toContain("401");
  });

  it("closes with 4410 when heartbeat hits a deleted row", async () => {
    repository.touchHeartbeat.mockResolvedValueOnce(false);
    const ws = connect();
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "heartbeat" }));
    const [code] = (await once(ws, "close")) as [number];
    expect(code).toBe(4410);
  });

  it("marks the runtime offline when the connection drops (registered)", async () => {
    const ws = connect();
    await once(ws, "open");
    ws.close();
    await once(ws, "close");
    await vi.waitFor(() => {
      expect(repository.markOffline).toHaveBeenCalledWith("rt-1");
    });
  });

  it("does NOT mark managed runtime offline on disconnect (supervisor restarts)", async () => {
    const ws = connect(MANAGED_TOKEN);
    await once(ws, "open");
    ws.close();
    await once(ws, "close");
    // Give the close handler time to run
    await new Promise((r) => setTimeout(r, 50));
    expect(repository.markOffline).not.toHaveBeenCalledWith(MANAGED_RUNTIME_ID);
  });

  it("closeConnection kicks the live socket with 4410", async () => {
    const ws = connect();
    await once(ws, "open");
    handler.closeConnection("rt-1");
    const [code] = (await once(ws, "close")) as [number];
    expect(code).toBe(4410);
  });

  it("destroys upgrade requests for non-tunnel paths", async () => {
    const ws = new WebSocket(`${baseUrl}/api/v1/other`, {
      headers: { authorization: `Bearer ${GOOD_TOKEN}` },
    });
    sockets.push(ws);
    const [err] = (await once(ws, "error")) as [Error];
    expect(err).toBeInstanceOf(Error);
  });

  describe("sendRequest", () => {
    it("rejects immediately when the target runtime is not connected", async () => {
      await expect(
        handler.sendRequest(
          "rt-1",
          {
            jsonrpc: "2.0",
            id: "req-1",
            method: "runtime.launch",
            params: {} as never,
          },
          1000
        )
      ).rejects.toThrow("runtime rt-1 is not connected");
    });

    it("sends the request over the wire and resolves with the manager's result", async () => {
      const ws = connect();
      await once(ws, "open");
      ws.on("message", (data: unknown) => {
        const message = JSON.parse(String(data)) as {
          id: string;
          method: string;
        };
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { runtimeInstanceId: "container-1" },
          })
        );
      });

      const result = await handler.sendRequest(
        "rt-1",
        {
          jsonrpc: "2.0",
          id: "req-1",
          method: "runtime.launch",
          params: {} as never,
        },
        1000
      );
      expect(result).toEqual({ runtimeInstanceId: "container-1" });
    });

    it("rejects with the manager's error message on an RPC error response", async () => {
      const ws = connect();
      await once(ws, "open");
      ws.on("message", (data: unknown) => {
        const message = JSON.parse(String(data)) as { id: string };
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32000, message: "docker not available" },
          })
        );
      });

      await expect(
        handler.sendRequest(
          "rt-1",
          {
            jsonrpc: "2.0",
            id: "req-1",
            method: "runtime.launch",
            params: {} as never,
          },
          1000
        )
      ).rejects.toThrow("docker not available");
    });

    it("rejects on timeout when the manager never replies", async () => {
      const ws = connect();
      await once(ws, "open");

      await expect(
        handler.sendRequest(
          "rt-1",
          {
            jsonrpc: "2.0",
            id: "req-1",
            method: "runtime.stop",
            params: {} as never,
          },
          20
        )
      ).rejects.toThrow(/did not respond/);
    });

    it("rejects a still-pending request when the connection drops", async () => {
      const ws = connect();
      await once(ws, "open");

      const pending = handler.sendRequest(
        "rt-1",
        {
          jsonrpc: "2.0",
          id: "req-1",
          method: "runtime.destroy",
          params: {} as never,
        },
        5000
      );
      ws.terminate();

      await expect(pending).rejects.toThrow(/connection closed/);
    });
  });
});
