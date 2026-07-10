import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { once } from "node:events";
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import { RUNTIME_TUNNEL_CLOSE_GONE } from "@agework/shared/protocol";
import { TunnelClient, type LaunchDispatcher } from "./tunnel.js";
import type { RegisteredRuntimeConfig } from "../config.js";

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

const { mockListFiles, mockReadFile, mockListChangedFiles, mockReadFileDiff } =
  vi.hoisted(() => ({
    mockListFiles: vi.fn(),
    mockReadFile: vi.fn(),
    mockListChangedFiles: vi.fn(),
    mockReadFileDiff: vi.fn(),
  }));

vi.mock("@agework/shared/filesystem", () => ({
  listFiles: mockListFiles,
  readFile: mockReadFile,
  createFsTimeoutSignal: () => AbortSignal.timeout(8_000),
  validateRelativePath: vi.fn(),
  resolveWithinRoot: vi.fn(),
  browse: vi.fn(),
}));

vi.mock("@agework/shared/git", () => ({
  listChangedFiles: mockListChangedFiles,
  readFileDiff: mockReadFileDiff,
  NotGitRepositoryError: class NotGitRepositoryError extends Error {},
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

  function makeDispatcher(): LaunchDispatcher {
    return {
      launch: vi.fn().mockResolvedValue({ runtimeInstanceId: "container-1" }),
      stop: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
    };
  }

  function makeClient(
    onGone = vi.fn(),
    dispatcher: LaunchDispatcher = makeDispatcher()
  ) {
    const config: RegisteredRuntimeConfig = {
      serverBaseUrl: `http://127.0.0.1:${port}/api/v1`,
      token: "pair-token",
      runtimeType: "docker",
      runtimeLogHostPath: "/logs",
      workerImage: "agework/runtime:latest",
    };
    client = new TunnelClient({
      config,
      dispatcher,
      onGone,
      reconnectBaseDelayMs: 20,
    });
    return { client, onGone, dispatcher };
  }

  it("connects with the pairing token, registers, then heartbeats at the given interval", async () => {
    makeClient();
    client!.start();

    await vi.waitFor(() => expect(connections).toHaveLength(1));
    expect(connections[0].authorization).toBe("Bearer pair-token");

    await expect(connections[0].nextMessage()).resolves.toEqual({
      type: "register",
      runtimeType: "docker",
      capabilities: { isolationScopes: ["user", "workspace"] },
      version: "0.0.1",
      envConfig: stubEnvConfig,
    });

    connections[0].ws.send(
      JSON.stringify({
        type: "registered",
        runtimeId: "rt-1",
        heartbeatIntervalSeconds: 0.05,
      })
    );
    await expect(connections[0].nextMessage()).resolves.toEqual({
      type: "heartbeat",
    });
  });

  it("exits via onGone on 4410 and does not reconnect", async () => {
    const { onGone } = makeClient();
    client!.start();
    await vi.waitFor(() => expect(connections).toHaveLength(1));

    connections[0].ws.close(RUNTIME_TUNNEL_CLOSE_GONE, "runtime deleted");

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

  describe("launch/stop/destroy RPC", () => {
    async function connectAndDrainRegister() {
      client!.start();
      await vi.waitFor(() => expect(connections).toHaveLength(1));
      await connections[0].nextMessage(); // drain the register message
      return connections[0];
    }

    it("dispatches a runtime.launch request to the dispatcher and replies with its result", async () => {
      const { dispatcher } = makeClient();
      const conn = await connectAndDrainRegister();

      conn.ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "req-1",
          method: "runtime.launch",
          params: { ownerId: "owner-1" },
        })
      );

      await expect(conn.nextMessage()).resolves.toEqual({
        jsonrpc: "2.0",
        id: "req-1",
        result: { runtimeInstanceId: "container-1" },
      });
      expect(dispatcher.launch).toHaveBeenCalledWith({ ownerId: "owner-1" });
    });

    it("dispatches runtime.stop/runtime.destroy and replies with a null result", async () => {
      const { dispatcher } = makeClient();
      const conn = await connectAndDrainRegister();

      conn.ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "req-2",
          method: "runtime.stop",
          params: { ownerId: "owner-1", runtimeInstanceId: "c1" },
        })
      );

      await expect(conn.nextMessage()).resolves.toEqual({
        jsonrpc: "2.0",
        id: "req-2",
        result: null,
      });
      expect(dispatcher.stop).toHaveBeenCalledWith({
        ownerId: "owner-1",
        runtimeInstanceId: "c1",
      });
    });

    it("replies with an RPC error when the dispatcher rejects", async () => {
      const dispatcher = makeDispatcher();
      (dispatcher.launch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("docker daemon unreachable")
      );
      makeClient(vi.fn(), dispatcher);
      const conn = await connectAndDrainRegister();

      conn.ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "req-3",
          method: "runtime.launch",
          params: {},
        })
      );

      const response = (await conn.nextMessage()) as {
        error: { message: string };
      };
      expect(response.error.message).toBe("docker daemon unreachable");
    });
  });

  describe("file preview / git diff RPC", () => {
    async function connectAndDrainRegister() {
      client!.start();
      await vi.waitFor(() => expect(connections).toHaveLength(1));
      await connections[0].nextMessage(); // drain the register message
      return connections[0];
    }

    beforeEach(() => {
      mockListFiles.mockResolvedValue({
        type: "list_files",
        commandId: "",
        path: "src",
        list: [{ name: "a.ts", type: "file", size: 10 }],
        truncated: false,
      });
      mockReadFile.mockResolvedValue({
        type: "read_file",
        commandId: "",
        path: "a.ts",
        encoding: "utf8",
        content: "hello",
        size: 5,
        truncated: false,
      });
      mockListChangedFiles.mockResolvedValue({
        list: [{ path: "a.ts", status: "modified", additions: 1, deletions: 0 }],
        truncated: false,
      });
      mockReadFileDiff.mockResolvedValue({
        path: "a.ts",
        status: "modified",
        before: "old",
        after: "new",
      });
    });

    it("dispatches runtime.list-files and replies with the file list", async () => {
      makeClient();
      const conn = await connectAndDrainRegister();

      conn.ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "req-lf",
          method: "runtime.list-files",
          params: { rootPath: "/ws", path: "src" },
        })
      );

      const response = (await conn.nextMessage()) as {
        jsonrpc: string;
        id: string;
        result: { path: string; list: unknown[]; truncated: boolean };
      };
      expect(response.id).toBe("req-lf");
      expect(response.result.path).toBe("src");
      expect(response.result.list).toHaveLength(1);
      expect(mockListFiles).toHaveBeenCalledWith(
        "/ws",
        "src",
        expect.any(AbortSignal)
      );
    });

    it("dispatches runtime.read-file and replies with the file content", async () => {
      makeClient();
      const conn = await connectAndDrainRegister();

      conn.ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "req-rf",
          method: "runtime.read-file",
          params: { rootPath: "/ws", path: "a.ts" },
        })
      );

      const response = (await conn.nextMessage()) as {
        jsonrpc: string;
        id: string;
        result: { path: string; content: string; encoding: string };
      };
      expect(response.id).toBe("req-rf");
      expect(response.result.content).toBe("hello");
      expect(mockReadFile).toHaveBeenCalledWith(
        "/ws",
        "a.ts",
        expect.any(AbortSignal)
      );
    });

    it("dispatches runtime.list-changed-files and replies with the changed files", async () => {
      makeClient();
      const conn = await connectAndDrainRegister();

      conn.ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "req-lcf",
          method: "runtime.list-changed-files",
          params: { rootPath: "/ws" },
        })
      );

      const response = (await conn.nextMessage()) as {
        jsonrpc: string;
        id: string;
        result: { list: unknown[]; truncated: boolean };
      };
      expect(response.id).toBe("req-lcf");
      expect(response.result.list).toHaveLength(1);
      expect(mockListChangedFiles).toHaveBeenCalledWith("/ws");
    });

    it("dispatches runtime.read-file-diff and replies with the diff", async () => {
      makeClient();
      const conn = await connectAndDrainRegister();

      conn.ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "req-rfd",
          method: "runtime.read-file-diff",
          params: { rootPath: "/ws", path: "a.ts" },
        })
      );

      const response = (await conn.nextMessage()) as {
        jsonrpc: string;
        id: string;
        result: { path: string; before: string; after: string };
      };
      expect(response.id).toBe("req-rfd");
      expect(response.result.after).toBe("new");
      expect(mockReadFileDiff).toHaveBeenCalledWith("/ws", "a.ts");
    });

    it("replies with an RPC error when the filesystem function rejects", async () => {
      mockReadFile.mockRejectedValueOnce(new Error("路径越界"));
      makeClient();
      const conn = await connectAndDrainRegister();

      conn.ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "req-err",
          method: "runtime.read-file",
          params: { rootPath: "/ws", path: "../escape" },
        })
      );

      const response = (await conn.nextMessage()) as {
        error: { message: string };
      };
      expect(response.error.message).toBe("路径越界");
    });
  });
});
