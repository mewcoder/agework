import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withTimeout } from "./with-timeout";

describe("withTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with the promise's value when it settles before the timeout", async () => {
    const promise = Promise.resolve("done");

    await expect(withTimeout(promise, 1000, "timed out")).resolves.toBe("done");
  });

  it("rejects with a timeout error when the promise never settles in time", async () => {
    const promise = new Promise(() => {
      /* never resolves */
    });

    const result = withTimeout(promise, 1000, "timed out after 1s");
    const assertion = expect(result).rejects.toThrow("timed out after 1s");
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it("rejects with the original error when the promise rejects before the timeout", async () => {
    const promise = Promise.reject(new Error("boom"));

    await expect(withTimeout(promise, 1000, "timed out")).rejects.toThrow(
      "boom"
    );
  });
});
