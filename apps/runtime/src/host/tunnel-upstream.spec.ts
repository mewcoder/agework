import { describe, it, expect, vi } from "vitest";
import { WebSocket } from "ws";
import { TunnelUpstream } from "./tunnel-upstream.js";

type SentEnvelope = {
  method: string;
  params: {
    seq: number;
    epoch?: number;
    notification: { kind: string; runId: string; message?: { type: string } };
  };
};

function makeSocket() {
  const send = vi.fn();
  const ws = { readyState: WebSocket.OPEN, send } as unknown as WebSocket;
  return { ws, send };
}

function sent(send: ReturnType<typeof vi.fn>): SentEnvelope[] {
  return send.mock.calls.map((call) => JSON.parse(call[0] as string));
}

describe("TunnelUpstream (ACK 水位缓冲)", () => {
  it("stamps monotonic seq and the session epoch on every envelope", async () => {
    const upstream = new TunnelUpstream();
    const { ws, send } = makeSocket();
    upstream.setSession(ws, 3);

    await upstream.notifyRunCancelled("run-1");
    await upstream.notifyRunFailed("run-2", "boom");

    const envelopes = sent(send);
    expect(envelopes.map((e) => e.params.seq)).toEqual([1, 2]);
    expect(envelopes.every((e) => e.params.epoch === 3)).toBe(true);
    expect(envelopes[0].method).toBe("host.upstream");
  });

  it("buffers while disconnected and flushes with original seqs after reconnect", async () => {
    const upstream = new TunnelUpstream();
    await upstream.notifyRunCancelled("run-1"); // 无连接:只入缓冲
    await upstream.notifyRunFailed("run-2", "boom");
    expect(upstream.bufferedCount()).toBe(2);

    const { ws, send } = makeSocket();
    upstream.setSession(ws, 5);

    const envelopes = sent(send);
    expect(envelopes.map((e) => e.params.seq)).toEqual([1, 2]);
    expect(envelopes.every((e) => e.params.epoch === 5)).toBe(true);
  });

  it("drops acked entries and resends only the rest on the next session", async () => {
    const upstream = new TunnelUpstream();
    const first = makeSocket();
    upstream.setSession(first.ws, 1);
    await upstream.notifyRunCancelled("run-1"); // seq 1
    await upstream.notifyRunCancelled("run-2"); // seq 2
    await upstream.notifyRunCancelled("run-3"); // seq 3

    upstream.onAck(2); // 累计水位:1、2 已收
    expect(upstream.bufferedCount()).toBe(1);

    upstream.clearSocket();
    const second = makeSocket();
    upstream.setSession(second.ws, 2);

    const resent = sent(second.send);
    expect(resent.map((e) => e.params.seq)).toEqual([3]);
    expect(resent[0].params.epoch).toBe(2);
    expect(resent[0].params.notification.runId).toBe("run-3");
  });

  it("keeps counting seq across reconnects (Host 进程内单调)", async () => {
    const upstream = new TunnelUpstream();
    const first = makeSocket();
    upstream.setSession(first.ws, 1);
    await upstream.notifyRunCancelled("run-1"); // seq 1
    upstream.onAck(1);
    upstream.clearSocket();

    const second = makeSocket();
    upstream.setSession(second.ws, 2);
    await upstream.notifyRunCancelled("run-2");

    expect(sent(second.send).map((e) => e.params.seq)).toEqual([2]);
  });

  it("evicts oldest intermediate emits first on overflow, never terminal facts", async () => {
    const upstream = new TunnelUpstream(); // 无连接:全部入缓冲
    await upstream.notifyRunFailed("run-terminal", "boom"); // 终态,最旧但不可丢
    for (let i = 0; i < 5000; i++) {
      await upstream.emit("run-1", {
        runId: "run-1",
        seq: i,
        type: "agui.event",
        payload: {},
        ts: "t",
      });
    }
    expect(upstream.bufferedCount()).toBe(5000);

    const { ws, send } = makeSocket();
    upstream.setSession(ws, 1);
    const envelopes = sent(send);
    // 最旧的终态事实仍在,被丢掉的是最旧的中间 emit(seq 2)
    expect(envelopes[0].params.notification.kind).toBe("runFailed");
    expect(envelopes[1].params.seq).toBe(3);
  });

  it("never drops run.status emits on overflow", async () => {
    const upstream = new TunnelUpstream();
    await upstream.emit("run-1", {
      runId: "run-1",
      seq: 0,
      type: "run.status",
      payload: {},
      ts: "t",
    });
    for (let i = 0; i < 5000; i++) {
      await upstream.emit("run-1", {
        runId: "run-1",
        seq: i + 1,
        type: "agui.event",
        payload: {},
        ts: "t",
      });
    }
    const { ws, send } = makeSocket();
    upstream.setSession(ws, 1);
    const first = sent(send)[0];
    expect(first.params.notification.message?.type).toBe("run.status");
  });
});
