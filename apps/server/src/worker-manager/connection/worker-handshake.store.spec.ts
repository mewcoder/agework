import { describe, expect, it } from "vitest";
import { WorkerHandshakeStore } from "./worker-handshake.store";

describe("WorkerHandshakeStore", () => {
  it("resolves waitForRegister when registerWorker is called with the matching token", async () => {
    const store = new WorkerHandshakeStore();

    const pending = store.waitForRegister("owner-1", "token-1");
    const accepted = store.registerWorker("owner-1", "token-1", { pid: 4242 });

    expect(accepted).toBe(true);
    const result = await pending;
    expect(result.pid).toBe(4242);
    expect(typeof result.registeredAt).toBe("string");
    expect(new Date(result.registeredAt).toString()).not.toBe("Invalid Date");
  });

  it("returns false and does not resolve when the token does not match", async () => {
    const store = new WorkerHandshakeStore();
    let settled = false;
    const pending = store.waitForRegister("owner-1", "token-1").then((r) => {
      settled = true;
      return r;
    });

    const accepted = store.registerWorker("owner-1", "wrong-token", {});

    expect(accepted).toBe(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    // clean up the still-pending promise so the test doesn't leak a rejection
    store.cancel("owner-1", "test cleanup");
    await expect(pending).rejects.toThrow("test cleanup");
  });

  it("returns false when there is no pending handshake for the owner", () => {
    const store = new WorkerHandshakeStore();
    expect(store.registerWorker("unknown-owner", "token-1", {})).toBe(false);
  });

  it("registerWorker returns false after cancel already removed the pending entry", async () => {
    const store = new WorkerHandshakeStore();
    const pending = store.waitForRegister("owner-1", "token-1");

    store.cancel("owner-1", "launch failed");
    await expect(pending).rejects.toThrow("launch failed");

    expect(store.registerWorker("owner-1", "token-1", {})).toBe(false);
  });

  it("cancel is a no-op when there is no pending handshake for the owner", () => {
    const store = new WorkerHandshakeStore();
    expect(() => store.cancel("unknown-owner", "reason")).not.toThrow();
  });
});
