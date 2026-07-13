import { describe, it, expect } from "vitest";
import { HandshakeStore } from "./handshake-store.js";

describe("HandshakeStore", () => {
  it("resolves the pending launch wait when the worker registers with the right token", async () => {
    const store = new HandshakeStore();
    const pending = store.waitForRegister("worker-1", "token-1");

    expect(store.registerWorker("worker-1", "token-1", { pid: 4242 })).toBe(
      true
    );
    await expect(pending).resolves.toMatchObject({ pid: 4242 });
  });

  it("rejects a register with the wrong token or unknown worker", () => {
    const store = new HandshakeStore();
    void store.waitForRegister("worker-1", "token-1");

    expect(store.registerWorker("worker-1", "wrong", { pid: 1 })).toBe(false);
    expect(store.registerWorker("worker-x", "token-1", { pid: 1 })).toBe(false);
  });

  it("a handshake resolves only once (第二次 register 拒绝)", async () => {
    const store = new HandshakeStore();
    const pending = store.waitForRegister("worker-1", "token-1");

    expect(store.registerWorker("worker-1", "token-1", {})).toBe(true);
    expect(store.registerWorker("worker-1", "token-1", {})).toBe(false);
    await pending;
  });

  it("cancel rejects the pending wait so a late register cannot land", async () => {
    const store = new HandshakeStore();
    const pending = store.waitForRegister("worker-1", "token-1");

    store.cancel("worker-1", "launch timed out");

    await expect(pending).rejects.toThrow("launch timed out");
    expect(store.registerWorker("worker-1", "token-1", {})).toBe(false);
  });
});
