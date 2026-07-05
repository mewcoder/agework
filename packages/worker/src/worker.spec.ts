import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerWithRetry } from "./worker.js";
import type { WorkerHttpTransport } from "./transport/worker-http.js";

function makeClient(register: ReturnType<typeof vi.fn>) {
  return { register } as unknown as WorkerHttpTransport;
}

describe("registerWithRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves without retrying when register succeeds on the first attempt", async () => {
    const register = vi.fn().mockResolvedValue(undefined);
    const client = makeClient(register);

    await registerWithRetry(client);

    expect(register).toHaveBeenCalledTimes(1);
  });

  it("retries after a transient failure and eventually succeeds", async () => {
    const register = vi
      .fn()
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValueOnce(undefined);
    const client = makeClient(register);

    const promise = registerWithRetry(client);
    await vi.runAllTimersAsync();
    await promise;

    expect(register).toHaveBeenCalledTimes(2);
  });

  it("exits the process after exhausting all retry attempts", async () => {
    const register = vi.fn().mockRejectedValue(new Error("register failed: 400 boom"));
    const client = makeClient(register);
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);

    const promise = registerWithRetry(client);
    await vi.runAllTimersAsync();
    await promise;

    expect(register).toHaveBeenCalledTimes(3);
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
  });
});
