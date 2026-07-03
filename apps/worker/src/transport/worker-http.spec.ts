import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { UpstreamMessage } from "@agework/shared/protocol";
import { WorkerHttpTransport } from "./worker-http";

describe("WorkerHttpTransport", () => {
  beforeEach(() => {
    vi.stubEnv("AGEWORK_WORKER_API_BASE", "http://api");
    vi.stubEnv("AGEWORK_WORKER_OWNER_ID", "ws-1");
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

    const commands = await client.pollCommands();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://api/worker/owners/ws-1/commands?afterSeq=0",
      {
        headers: {
          "x-agework-owner-id": "ws-1",
          "x-agework-worker-token": "token-1",
        },
      }
    );
    expect(commands[0].payload).toMatchObject({
      type: "user_message",
      commandId: "cmd-3",
      runId: "run-1",
    });
    // 下一次 poll 用更新后的 afterSeq
    await client.pollCommands();
    expect(fetchMock).toHaveBeenLastCalledWith(
      "http://api/worker/owners/ws-1/commands?afterSeq=3",
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

    const commands = await client.pollCommands();

    expect(commands).toEqual([
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
      "http://api/worker/owners/ws-1/commands?afterSeq=4",
      expect.anything()
    );
  });

  it("fetches run config by runId", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ config: { runId: "run-1", conversationId: "conversation-1", agentProviderConfig: { agentType: "claude", source: "custom" } } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new WorkerHttpTransport();

    const config = await client.fetchRunConfig("run-1");

    expect(fetchMock).toHaveBeenCalledWith("http://api/worker/runs/run-1", {
      headers: {
        "x-agework-owner-id": "ws-1",
        "x-agework-worker-token": "token-1",
      },
    });
    expect(config).toMatchObject({ runId: "run-1" });
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
      "http://api/worker/owners/ws-1/commands?afterSeq=0&waitMs=25000",
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
          "x-agework-owner-id": "ws-1",
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

  it("registers with the owner's register endpoint, sending startToken and pid", async () => {
    vi.stubEnv("AGEWORK_WORKER_START_TOKEN", "token-1");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const client = new WorkerHttpTransport();

    await client.register();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://api/worker/owners/ws-1/register",
      expect.objectContaining({ method: "POST" })
    );
    expect(
      JSON.parse(fetchMock.mock.lastCall?.[1]?.body as string)
    ).toMatchObject({
      startToken: "token-1",
      pid: process.pid,
    });
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
      runId: "run-1", seq: 0, type: "agui.event", payload: { type: "RAW" }, ts: "",
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

      const commands = await client.pollCommands();

      expect(commands).toEqual([]);
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
});
