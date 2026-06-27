import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { UpstreamMessage } from "@agework/shared/protocol";
import { HttpTransport } from "./http";

describe("HttpTransport", () => {
  beforeEach(() => {
    vi.stubEnv("AGEWORK_WORKER_API_BASE", "http://api");
    vi.stubEnv("AGEWORK_WORKER_OWNER_ID", "ws-1");
    vi.stubEnv("AGEWORK_WORKER_RUNTIME_ACCESS_KEY", "owner-key");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
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
              input: { text: "hi" },
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
    const client = new HttpTransport();

    const commands = await client.pollCommands();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://api/worker/owners/ws-1/commands?afterSeq=0",
      expect.objectContaining({ headers: { Authorization: "Bearer owner-key" } })
    );
    expect(commands[0].payload).toMatchObject({
      type: "user_message",
      commandId: "cmd-3",
      runId: "run-1",
      input: { text: "hi" },
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
    const client = new HttpTransport();

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
    const client = new HttpTransport();

    const config = await client.fetchRunConfig("run-1");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://api/worker/runs/run-1",
      expect.objectContaining({ headers: { Authorization: "Bearer owner-key" } })
    );
    expect(config).toMatchObject({ runId: "run-1" });
  });

  it("adds waitMs when long-polling commands", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpTransport();

    await client.pollCommands(25_000);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://api/worker/owners/ws-1/commands?afterSeq=0&waitMs=25000",
      expect.objectContaining({ headers: { Authorization: "Bearer owner-key" } })
    );
  });

  it("emits an event to the run's events endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpTransport();

    await client.emit("run-1", {
      runId: "run-1",
      seq: 0,
      type: "agui.event",
      payload: { type: "RAW", event: {} },
      ts: "",
    } as unknown as UpstreamMessage);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://api/worker/runs/run-1/events",
      expect.objectContaining({ method: "POST" })
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
    const client = new HttpTransport();

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
    const client = new HttpTransport();

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
    const client = new HttpTransport();

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
    const client = new HttpTransport();

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
    const client = new HttpTransport();

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

  it("cleanup resets the per-run seq counter", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpTransport();
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
});
