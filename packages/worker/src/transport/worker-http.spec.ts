import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { UpstreamMessage } from "@agework/shared/protocol";
import { WorkerHttpTransport } from "./worker-http";

describe("WorkerHttpTransport", () => {
  beforeEach(() => {
    vi.stubEnv("AGEWORK_WORKER_API_BASE", "http://api");
    vi.stubEnv("AGEWORK_WORKER_ID", "ws-1");
    vi.stubEnv("AGEWORK_WORKER_START_TOKEN", "token-1");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("polls the workspace commands endpoint with afterSeq", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        messages: [
          {
            jsonrpc: "2.0",
            id: "cmd-3",
            method: "run.start",
            params: {
              runId: "run-1",
            },
            meta: {
              runId: "run-1",
              seq: 3,
              ts: "2026-06-27T00:00:00.000Z",
            },
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new WorkerHttpTransport();

    const result = await client.pollCommands();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://api/worker/ws-1/commands?afterSeq=0",
      {
        headers: {
          "x-agework-worker-id": "ws-1",
          "x-agework-worker-token": "token-1",
        },
        signal: expect.any(AbortSignal),
      }
    );
    expect(result.commands[0].payload).toMatchObject({
      type: "user_message",
      commandId: "cmd-3",
      runId: "run-1",
    });
    // 下一次 poll 用更新后的 afterSeq
    await client.pollCommands();
    expect(fetchMock).toHaveBeenLastCalledWith(
      "http://api/worker/ws-1/commands?afterSeq=3",
      expect.anything()
    );
  });

  it("accepts JSON-RPC messages from the command poll endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        messages: [
          {
            jsonrpc: "2.0",
            id: "cmd-1",
            method: "run.cancel",
            params: {
              runId: "run-1",
              conversationId: "conv-1",
            },
            meta: {
              runId: "run-1",
              seq: 4,
              ts: "2026-06-27T00:00:00.000Z",
            },
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new WorkerHttpTransport();

    const result = await client.pollCommands();

    expect(result.commands).toEqual([
      {
        runId: "run-1",
        seq: 4,
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

    await client.pollCommands();
    expect(fetchMock).toHaveBeenLastCalledWith(
      "http://api/worker/ws-1/commands?afterSeq=4",
      expect.anything()
    );
  });

  it("fetches run config by runId", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        config: {
          runId: "run-1",
          conversationId: "conversation-1",
          workspaceId: "workspace-1",
          runtimePath: "/workspace",
          env: {},
          input: {},
          agentProviderConfig: {
            agentType: "claude",
            source: "custom",
            baseUrl: "https://example.test",
            apiKey: "key",
            model: "model-1",
          },
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new WorkerHttpTransport();

    const config = await client.fetchRunConfig("run-1");

    expect(fetchMock).toHaveBeenCalledWith("http://api/worker/runs/run-1", {
      headers: {
        "x-agework-worker-id": "ws-1",
        "x-agework-worker-token": "token-1",
      },
      signal: expect.any(AbortSignal),
    });
    expect(config).toMatchObject({ runId: "run-1" });
  });

  it("rejects malformed command poll and run config responses", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ messages: [{ method: "run.interrupt" }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ config: { runId: "run-1" } }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const client = new WorkerHttpTransport();

    await expect(client.pollCommands()).rejects.toThrow(
      "invalid command poll response from host"
    );
    await expect(client.fetchRunConfig("run-1")).rejects.toThrow(
      "invalid run config response from host"
    );
  });

  it("adds waitMs when long-polling commands", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new WorkerHttpTransport();

    await client.pollCommands(25_000);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://api/worker/ws-1/commands?afterSeq=0&waitMs=25000",
      expect.anything()
    );
  });

  it("emits an event to the run's events endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const client = new WorkerHttpTransport();

    await client.emit("run-1", {
      runId: "run-1",
      seq: 0,
      type: "agui.event",
      payload: { type: "RAW", event: {} },
      ts: "",
    } as unknown as UpstreamMessage);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://api/worker/runs/run-1/events",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-agework-worker-id": "ws-1",
          "x-agework-worker-token": "token-1",
        }),
      })
    );
    expect(
      JSON.parse(fetchMock.mock.lastCall?.[1]?.body as string)
    ).toMatchObject({
      jsonrpc: "2.0",
      method: "run.aguiEvent",
      params: {
        runId: "run-1",
        event: { type: "RAW", event: {} },
      },
      meta: {
        runId: "run-1",
        seq: 1,
      },
    });
  });

  it("emits command results as JSON-RPC responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const client = new WorkerHttpTransport();

    await client.emit("run-1", {
      runId: "run-1",
      seq: 0,
      type: "command.result",
      payload: {
        commandId: "cmd-1",
        commandType: "cancel",
        status: "ok",
      },
      ts: "",
    } as unknown as UpstreamMessage);

    expect(
      JSON.parse(fetchMock.mock.lastCall?.[1]?.body as string)
    ).toMatchObject({
      jsonrpc: "2.0",
      id: "cmd-1",
      result: {
        ok: true,
        runId: "run-1",
        commandType: "cancel",
      },
      meta: {
        runId: "run-1",
        seq: 1,
      },
    });
  });

  it("retries emit on transient network failure", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const client = new WorkerHttpTransport();

    await client.emit("run-1", {
      runId: "run-1",
      seq: 0,
      type: "agui.event",
      payload: { type: "RAW", event: {} },
      ts: "",
    } as unknown as UpstreamMessage);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries emit on server error (5xx)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 502 })
      .mockResolvedValueOnce({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const client = new WorkerHttpTransport();

    await client.emit("run-1", {
      runId: "run-1",
      seq: 0,
      type: "agui.event",
      payload: { type: "RAW", event: {} },
      ts: "",
    } as unknown as UpstreamMessage);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects without retrying emit on client error (4xx)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "bad request",
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new WorkerHttpTransport();

    await expect(
      client.emit("run-1", {
        runId: "run-1",
        seq: 0,
        type: "agui.event",
        payload: { type: "RAW", event: {} },
        ts: "",
      } as unknown as UpstreamMessage)
    ).rejects.toThrow("Event POST failed: 400 bad request");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects after exhausting emit retries on server error (5xx)", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => "bad gateway",
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new WorkerHttpTransport();

    const emitPromise = client.emit("run-1", {
      runId: "run-1",
      seq: 0,
      type: "agui.event",
      payload: { type: "RAW", event: {} },
      ts: "",
    } as unknown as UpstreamMessage);
    const assertion = expect(emitPromise).rejects.toThrow(
      "Event POST failed: 502 bad gateway"
    );
    await vi.runAllTimersAsync();

    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("registers with the worker's register endpoint, sending startToken and pid", async () => {
    vi.stubEnv("AGEWORK_WORKER_START_TOKEN", "token-1");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, protocolVersion: 1 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new WorkerHttpTransport();

    await client.register();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://api/worker/ws-1/register",
      expect.objectContaining({ method: "POST" })
    );
    expect(
      JSON.parse(fetchMock.mock.lastCall?.[1]?.body as string)
    ).toMatchObject({
      startToken: "token-1",
      pid: process.pid,
      protocolVersion: 1,
    });
  });

  it("rejects a host with an incompatible protocol version", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, protocolVersion: 2 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new WorkerHttpTransport();

    await expect(client.register()).rejects.toThrow(
      "incompatible host protocol: host=2 worker=1"
    );
  });

  it("rejects a malformed host handshake response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new WorkerHttpTransport();

    await expect(client.register()).rejects.toThrow(
      "register failed: malformed host handshake response"
    );
  });

  it("rejects when the register endpoint returns non-ok", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "no pending launch handshake",
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new WorkerHttpTransport();

    await expect(client.register()).rejects.toThrow(
      "register failed: 400 no pending launch handshake"
    );
  });

  it("cleanup resets the per-run seq counter", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const client = new WorkerHttpTransport();
    const msg = {
      runId: "run-1",
      seq: 0,
      type: "agui.event",
      payload: { type: "RAW" },
      ts: "",
    } as unknown as UpstreamMessage;
    const seqInLastCall = () =>
      JSON.parse(fetchMock.mock.lastCall?.[1]?.body as string).meta.seq;

    await client.emit("run-1", msg); // seq 1
    await client.emit("run-1", msg); // seq 2
    expect(seqInLastCall()).toBe(2);

    client.cleanup("run-1");

    await client.emit("run-1", msg); // seq 重新从 1 开始
    expect(seqInLastCall()).toBe(1);
  });

  describe("queueEpoch", () => {
    it("records the epoch on the first poll without re-polling", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ messages: [], queueEpoch: 1000 }),
      });
      vi.stubGlobal("fetch", fetchMock);
      const client = new WorkerHttpTransport();

      const result = await client.pollCommands();

      expect(result.commands).toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("does not re-poll when the epoch is unchanged across polls", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ messages: [], queueEpoch: 1000 }),
      });
      vi.stubGlobal("fetch", fetchMock);
      const client = new WorkerHttpTransport();

      await client.pollCommands(); // records epoch 1000
      fetchMock.mockClear();
      const result = await client.pollCommands();

      expect(result.commands).toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("resets afterSeq and immediately re-polls when the epoch changes, returning the re-polled result", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          messages: [
            {
              jsonrpc: "2.0",
              id: "cmd-9",
              method: "run.start",
              params: { runId: "run-9" },
              meta: { runId: "run-9", seq: 9, ts: "2026-06-27T00:00:00.000Z" },
            },
          ],
          queueEpoch: 1000,
        }),
      });
      vi.stubGlobal("fetch", fetchMock);
      const client = new WorkerHttpTransport();
      await client.pollCommands(); // records epoch 1000 baseline, commandSeq -> 9
      fetchMock.mockClear();

      // server restarted: new epoch, and the stale afterSeq=9 request comes back
      // empty because the new queue starts at seq 1
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ messages: [], queueEpoch: 2000 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            messages: [
              {
                jsonrpc: "2.0",
                id: "cmd-1",
                method: "run.start",
                params: { runId: "run-1" },
                meta: {
                  runId: "run-1",
                  seq: 1,
                  ts: "2026-06-27T00:00:00.000Z",
                },
              },
            ],
            queueEpoch: 2000,
          }),
        });

      const result = await client.pollCommands();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        "http://api/worker/ws-1/commands?afterSeq=9",
        expect.anything()
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        "http://api/worker/ws-1/commands?afterSeq=0",
        expect.anything()
      );
      // returns the re-polled (correct, non-empty) result, not the first (stale, empty) one
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0].payload).toMatchObject({
        commandId: "cmd-1",
        runId: "run-1",
      });
    });
  });

  describe("410 token eviction", () => {
    it("exits the process when pollCommands gets a 410", async () => {
      const exitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation(() => undefined as never);
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 410,
        text: async () => "worker token rejected",
      });
      vi.stubGlobal("fetch", fetchMock);
      const client = new WorkerHttpTransport();

      const result = await client.pollCommands();

      expect(result.commands).toEqual([]);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("exits the process when fetchRunConfig gets a 410", async () => {
      const exitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation(() => undefined as never);
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 410,
        text: async () => "worker token rejected",
      });
      vi.stubGlobal("fetch", fetchMock);
      const client = new WorkerHttpTransport();

      await expect(client.fetchRunConfig("run-1")).rejects.toThrow(
        "Failed to fetch run config: 410 worker token rejected"
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("exits the process when emit gets a 410, without retrying", async () => {
      const exitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation(() => undefined as never);
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 410,
        text: async () => "worker token rejected",
      });
      vi.stubGlobal("fetch", fetchMock);
      const client = new WorkerHttpTransport();

      await client.emit("run-1", {
        runId: "run-1",
        seq: 0,
        type: "agui.event",
        payload: { type: "RAW", event: {} },
        ts: "",
      } as unknown as UpstreamMessage);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe("401 token rejected", () => {
    it("exits the process when pollCommands gets a 401", async () => {
      const exitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation(() => undefined as never);
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => "unauthorized",
      });
      vi.stubGlobal("fetch", fetchMock);
      const client = new WorkerHttpTransport();

      const result = await client.pollCommands();

      expect(result.commands).toEqual([]);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("exits the process when fetchRunConfig gets a 401", async () => {
      const exitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation(() => undefined as never);
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => "unauthorized",
      });
      vi.stubGlobal("fetch", fetchMock);
      const client = new WorkerHttpTransport();

      await expect(client.fetchRunConfig("run-1")).rejects.toThrow(
        "Failed to fetch run config: 401 unauthorized"
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("exits the process when emit gets a 401, without retrying", async () => {
      const exitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation(() => undefined as never);
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => "unauthorized",
      });
      vi.stubGlobal("fetch", fetchMock);
      const client = new WorkerHttpTransport();

      await client.emit("run-1", {
        runId: "run-1",
        seq: 0,
        type: "agui.event",
        payload: { type: "RAW", event: {} },
        ts: "",
      } as unknown as UpstreamMessage);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe("adaptive batching", () => {
    const mk = (n: number) =>
      ({
        runId: "run-1",
        seq: 0,
        type: "agui.event",
        payload: { type: "RAW", event: { n } },
        ts: "",
      }) as unknown as UpstreamMessage;

    it("sends a single-object body when there is no in-flight backlog", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);
      const client = new WorkerHttpTransport();

      await client.emit("run-1", mk(1));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
      expect(Array.isArray(body)).toBe(false);
      expect(body.meta.seq).toBe(1);
    });

    it("coalesces events that arrive during an in-flight POST into one ordered batch", async () => {
      const releases: Array<() => void> = [];
      const fetchMock = vi.fn(
        (_url: string, _init: RequestInit) =>
          new Promise<Response>((resolve) => {
            releases.push(() => resolve({ ok: true } as Response));
          })
      );
      vi.stubGlobal("fetch", fetchMock);
      const client = new WorkerHttpTransport();

      const p1 = client.emit("run-1", mk(1)); // 起第一批 POST(单条 seq1)
      const p2 = client.emit("run-1", mk(2)); // 在飞期间入队
      const p3 = client.emit("run-1", mk(3)); // 在飞期间入队

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      const body1 = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
      expect(Array.isArray(body1)).toBe(false);
      expect(body1.meta.seq).toBe(1);

      releases[0]?.(); // 完成第一批 → 触发合并后的第二批
      await p1;

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      const body2 = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string);
      expect(Array.isArray(body2)).toBe(true);
      expect(body2.map((m: { meta: { seq: number } }) => m.meta.seq)).toEqual([
        2, 3,
      ]);

      releases[1]?.();
      await Promise.all([p2, p3]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("rejects every waiter in a batch when its POST fails", async () => {
      vi.useFakeTimers();
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => "bad request",
      });
      vi.stubGlobal("fetch", fetchMock);
      const client = new WorkerHttpTransport();

      // 第一条独占第一批;它失败(4xx 不重试)后,后续两条组第二批也失败
      const p1 = client.emit("run-1", mk(1));
      const p2 = client.emit("run-1", mk(2));
      const p3 = client.emit("run-1", mk(3));

      const a1 = expect(p1).rejects.toThrow(
        "Event POST failed: 400 bad request"
      );
      const a2 = expect(p2).rejects.toThrow(
        "Event POST failed: 400 bad request"
      );
      const a3 = expect(p3).rejects.toThrow(
        "Event POST failed: 400 bad request"
      );
      await vi.runAllTimersAsync();
      await Promise.all([a1, a2, a3]);
      vi.useRealTimers();
    });
  });
});
