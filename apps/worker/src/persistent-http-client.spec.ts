import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { UpstreamMessage } from "@agework/shared/protocol";
import { PersistentHttpClient } from "./persistent-http-client";

describe("PersistentHttpClient", () => {
  beforeEach(() => {
    vi.stubEnv("AGEWORK_INTERNAL_API_BASE", "http://api");
    vi.stubEnv("AGEWORK_INTERNAL_WORKSPACE_ID", "ws-1");
    vi.stubEnv("AGEWORK_INTERNAL_RUNTIME_ACCESS_KEY", "ws-key");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("polls the workspace controls endpoint with afterSeq", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ controls: [{ seq: 3, payload: { type: "user_message", runId: "run-1" } }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new PersistentHttpClient();

    const controls = await client.pollControls();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://api/internal/workspaces/ws-1/controls?afterSeq=0",
      expect.objectContaining({ headers: { Authorization: "Bearer ws-key" } })
    );
    expect(controls[0].payload).toMatchObject({ type: "user_message", runId: "run-1" });
    // 下一次 poll 用更新后的 afterSeq
    await client.pollControls();
    expect(fetchMock).toHaveBeenLastCalledWith(
      "http://api/internal/workspaces/ws-1/controls?afterSeq=3",
      expect.anything()
    );
  });

  it("fetches run config by runId", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ config: { runId: "run-1", conversationId: "conversation-1" } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new PersistentHttpClient();

    const config = await client.fetchRunConfig("run-1");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://api/internal/runs/run-1",
      expect.objectContaining({ headers: { Authorization: "Bearer ws-key" } })
    );
    expect(config).toMatchObject({ runId: "run-1" });
  });

  it("adds waitMs when long-polling controls", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ controls: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new PersistentHttpClient();

    await client.pollControls(25_000);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://api/internal/workspaces/ws-1/controls?afterSeq=0&waitMs=25000",
      expect.objectContaining({ headers: { Authorization: "Bearer ws-key" } })
    );
  });

  it("emits an event to the run's events endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const client = new PersistentHttpClient();

    await client.emit("run-1", {
      runId: "run-1",
      seq: 0,
      type: "agui.event",
      payload: { type: "RAW", event: {} },
      ts: "",
    } as unknown as UpstreamMessage);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://api/internal/runs/run-1/events",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("retries emit on transient network failure", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const client = new PersistentHttpClient();

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
    const client = new PersistentHttpClient();

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
    const client = new PersistentHttpClient();

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
    const client = new PersistentHttpClient();

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

  it("emits a workspace heartbeat", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const client = new PersistentHttpClient();

    await client.emitWorkspaceHeartbeat();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://api/internal/workspaces/ws-1/heartbeat",
      expect.objectContaining({ method: "POST", headers: { Authorization: "Bearer ws-key" } })
    );
  });

  it("cleanup resets the per-run seq counter", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const client = new PersistentHttpClient();
    const msg = {
      runId: "run-1", seq: 0, type: "agui.event", payload: { type: "RAW" }, ts: "",
    } as unknown as UpstreamMessage;
    const seqInLastCall = () =>
      (fetchMock.mock.lastCall?.[1]?.body as string | undefined)?.match(/"seq":(\d+)/)?.[1];

    await client.emit("run-1", msg); // seq 1
    await client.emit("run-1", msg); // seq 2
    expect(seqInLastCall()).toBe("2");

    client.cleanup("run-1");

    await client.emit("run-1", msg); // seq 重新从 1 开始
    expect(seqInLastCall()).toBe("1");
  });

  describe("with AGEWORK_INTERNAL_RUNTIME_INSTANCE_ID", () => {
    beforeEach(() => {
      vi.stubEnv("AGEWORK_INTERNAL_RUNTIME_INSTANCE_ID", "rr-42");
    });

    it("polls the runtime controls endpoint", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ controls: [{ seq: 5, payload: { type: "user_message", runId: "run-2" } }] }),
      });
      vi.stubGlobal("fetch", fetchMock);
      const client = new PersistentHttpClient();

      const controls = await client.pollControls();

      expect(fetchMock).toHaveBeenCalledWith(
        "http://api/internal/runtimes/rr-42/controls?afterSeq=0",
        expect.objectContaining({ headers: { Authorization: "Bearer ws-key" } })
      );
      expect(controls[0].payload).toMatchObject({ type: "user_message", runId: "run-2" });
      // Next poll uses updated afterSeq
      await client.pollControls();
      expect(fetchMock).toHaveBeenLastCalledWith(
        "http://api/internal/runtimes/rr-42/controls?afterSeq=5",
        expect.anything()
      );
    });

    it("POSTs heartbeat to the runtime endpoint", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);
      const client = new PersistentHttpClient();

      await client.emitWorkspaceHeartbeat();

      expect(fetchMock).toHaveBeenCalledWith(
        "http://api/internal/runtimes/rr-42/heartbeat",
        expect.objectContaining({ method: "POST", headers: { Authorization: "Bearer ws-key" } })
      );
    });
  });

  describe("without AGEWORK_INTERNAL_RUNTIME_INSTANCE_ID", () => {
    it("uses workspace endpoint for pollControls", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ controls: [] }),
      });
      vi.stubGlobal("fetch", fetchMock);
      const client = new PersistentHttpClient();

      await client.pollControls();

      expect(fetchMock).toHaveBeenCalledWith(
        "http://api/internal/workspaces/ws-1/controls?afterSeq=0",
        expect.anything()
      );
    });

    it("uses workspace endpoint for heartbeat", async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal("fetch", fetchMock);
      const client = new PersistentHttpClient();

      await client.emitWorkspaceHeartbeat();

      expect(fetchMock).toHaveBeenCalledWith(
        "http://api/internal/workspaces/ws-1/heartbeat",
        expect.objectContaining({ method: "POST" })
      );
    });
  });

});
