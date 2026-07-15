import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { once } from "node:events";
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import {
  RUNTIME_HOST_TUNNEL_PROTOCOL_VERSION,
  RUNTIME_TUNNEL_CLOSE_GONE,
} from "@agework/shared/protocol";
import { TunnelClient } from "./tunnel-client.js";
import type { RegisteredRuntimeHostConfig } from "./config.js";

// 真实的 detectEnvConfig() 会探测本机装的 claude/codex CLI,导致 register 消息里的
// envConfig 因开发机环境而异——固定为一个确定值,测试才不受本机 CLI 安装状态影响。
const stubEnvConfig = {
  claude: { executablePath: null, version: null },
  codex: { executablePath: null, version: null },
  detectedAt: "2026-01-01T00:00:00.000Z",
};
vi.mock("@agework/shared/cli", () => ({
  detectEnvConfig: () => stubEnvConfig,
}));

type ServerConnection = {
  ws: WebSocket;
  authorization?: string;
  /** 消息在连接建立时就开始缓冲,避免 attach 监听前丢消息的竞态。 */
  nextMessage: () => Promise<unknown>;
};

describe("TunnelClient", () => {
  let wss: WebSocketServer;
  let port: number;
  let connections: ServerConnection[];
  let client: TunnelClient | undefined;

  beforeEach(async () => {
    connections = [];
    wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await once(wss, "listening");
    const address = wss.address();
    if (typeof address !== "object" || address === null) {
      throw new Error("no wss address");
    }
    port = address.port;
    wss.on("connection", (ws, req) => {
      const buffered: unknown[] = [];
      const waiters: ((message: unknown) => void)[] = [];
      ws.on("message", (data: RawData) => {
        const message: unknown = JSON.parse(String(data));
        const waiter = waiters.shift();
        if (waiter) waiter(message);
        else buffered.push(message);
      });
      connections.push({
        ws,
        authorization: req.headers.authorization,
        nextMessage: () => {
          const queued = buffered.shift();
          if (queued !== undefined) return Promise.resolve(queued);
          return new Promise((resolve) => waiters.push(resolve));
        },
      });
    });
  });

  afterEach(() => {
    client?.stop();
    wss.close();
  });

  function makeClient(onGone = vi.fn(), onIncompatible = vi.fn()) {
    const config: RegisteredRuntimeHostConfig = {
      serverBaseUrl: `http://127.0.0.1:${port}/api/v1`,
      token: "pair-token",
      runtimeTypes: ["docker"],
      runtimeLogHostPath: "/logs",
      workerImage: "agework/runtime:latest",
    };
    const hostContract = {
      releaseRun: vi.fn(),
      listFiles: vi.fn().mockResolvedValue({
        path: "src",
        list: [{ name: "a.ts", type: "file", size: 10 }],
        truncated: false,
      }),
    };
    client = new TunnelClient({
      config,
      hostContract: hostContract as never,
      onGone,
      onIncompatible,
      reconnectBaseDelayMs: 20,
    });
    return { client, onGone, onIncompatible, hostContract };
  }

  it("connects with the pairing token, registers, then heartbeats at the given interval", async () => {
    makeClient();
    client!.start();

    await vi.waitFor(() => expect(connections).toHaveLength(1));
    expect(connections[0].authorization).toBe("Bearer pair-token");

    await expect(connections[0].nextMessage()).resolves.toEqual({
      type: "register",
      protocolVersion: RUNTIME_HOST_TUNNEL_PROTOCOL_VERSION,
      capabilities: {
        docker: {
          available: true,
          scopes: ["user", "workspace"],
        },
      },
      version: "0.0.1",
      envConfig: stubEnvConfig,
    });

    connections[0].ws.send(
      JSON.stringify({
        type: "registered",
        runtimeHostId: "rt-1",
        heartbeatIntervalSeconds: 0.05,
        protocolVersion: RUNTIME_HOST_TUNNEL_PROTOCOL_VERSION,
      })
    );
    await expect(connections[0].nextMessage()).resolves.toEqual({
      type: "heartbeat",
    });
  });

  it("stops reconnecting when the server declares an incompatible protocol", async () => {
    const { onIncompatible } = makeClient();
    client!.start();
    await vi.waitFor(() => expect(connections).toHaveLength(1));
    await connections[0].nextMessage();

    connections[0].ws.send(
      JSON.stringify({
        type: "registered",
        runtimeHostId: "rt-1",
        heartbeatIntervalSeconds: 1,
        protocolVersion: RUNTIME_HOST_TUNNEL_PROTOCOL_VERSION + 1,
      })
    );

    await vi.waitFor(() => expect(onIncompatible).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(connections).toHaveLength(1);
  });

  it("rejects a server response without a protocol version", async () => {
    const { onIncompatible } = makeClient();
    client!.start();
    await vi.waitFor(() => expect(connections).toHaveLength(1));
    await connections[0].nextMessage();

    connections[0].ws.send(
      JSON.stringify({
        type: "registered",
        runtimeHostId: "rt-1",
        heartbeatIntervalSeconds: 1,
      })
    );

    await vi.waitFor(() => expect(onIncompatible).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(connections).toHaveLength(1);
  });

  it("closes a registered handshake with invalid field types", async () => {
    makeClient();
    client!.start();
    await vi.waitFor(() => expect(connections).toHaveLength(1));
    await connections[0].nextMessage();

    connections[0].ws.send(
      JSON.stringify({
        type: "registered",
        runtimeHostId: "rt-1",
        heartbeatIntervalSeconds: "1",
        protocolVersion: RUNTIME_HOST_TUNNEL_PROTOCOL_VERSION,
      })
    );

    const [code] = (await once(connections[0].ws, "close")) as [number];
    expect(code).toBe(1008);
  });

  it("exits via onGone on 4410 and does not reconnect", async () => {
    const { onGone } = makeClient();
    client!.start();
    await vi.waitFor(() => expect(connections).toHaveLength(1));

    connections[0].ws.close(RUNTIME_TUNNEL_CLOSE_GONE, "runtime host deleted");

    await vi.waitFor(() => expect(onGone).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(connections).toHaveLength(1);
  });

  it("reconnects with backoff after an abnormal close", async () => {
    makeClient();
    client!.start();
    await vi.waitFor(() => expect(connections).toHaveLength(1));

    connections[0].ws.terminate();

    await vi.waitFor(() => expect(connections).toHaveLength(2), {
      timeout: 2000,
    });
  });

  it("stop closes the connection without reconnecting", async () => {
    makeClient();
    client!.start();
    await vi.waitFor(() => expect(connections).toHaveLength(1));

    client!.stop();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(connections).toHaveLength(1);
  });

  describe("host RPC", () => {
    async function connectAndDrainRegister() {
      client!.start();
      await vi.waitFor(() => expect(connections).toHaveLength(1));
      await connections[0].nextMessage(); // drain the register message
      return connections[0];
    }

    it("dispatches host.listFiles through RuntimeHostContract", async () => {
      const { hostContract } = makeClient();
      const conn = await connectAndDrainRegister();

      conn.ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "req-1",
          method: "host.listFiles",
          params: {
            runtimeHostId: "rt-1",
            rootPath: "/workspace",
            path: "src",
          },
        })
      );

      await expect(conn.nextMessage()).resolves.toEqual({
        jsonrpc: "2.0",
        id: "req-1",
        result: {
          path: "src",
          list: [{ name: "a.ts", type: "file", size: 10 }],
          truncated: false,
        },
      });
      expect(hostContract.listFiles).toHaveBeenCalledWith({
        runtimeHostId: "rt-1",
        rootPath: "/workspace",
        path: "src",
      });
    });

    it("forwards a run-scoped release notification without local routing state", async () => {
      const { hostContract } = makeClient();
      const conn = await connectAndDrainRegister();

      conn.ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "host.releaseRun",
          params: { runtimeHostId: "rt-1", runId: "run-1" },
        })
      );

      await vi.waitFor(() => {
        expect(hostContract.releaseRun).toHaveBeenCalledWith({
          runtimeHostId: "rt-1",
          runId: "run-1",
        });
      });
    });
  });
});
