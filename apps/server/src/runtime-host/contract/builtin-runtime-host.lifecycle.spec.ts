import { describe, expect, it, vi } from "vitest";
import { BuiltinRuntimeHostLifecycle } from "./builtin-runtime-host";

describe("BuiltinRuntimeHostLifecycle", () => {
  it("bootstraps the host before opening the worker HTTP server", async () => {
    const order: string[] = [];
    const host = {
      bootstrap: vi.fn(async () => {
        order.push("bootstrap");
      }),
      shutdown: vi.fn(async () => {
        order.push("shutdown");
      }),
    };
    const httpServer = {
      start: vi.fn(async () => {
        order.push("http-start");
      }),
      stop: vi.fn(async () => {
        order.push("http-stop");
      }),
    };
    const lifecycle = new BuiltinRuntimeHostLifecycle(
      host as never,
      httpServer as never
    );

    await lifecycle.initialize();

    expect(order).toEqual(["bootstrap", "http-start"]);
  });

  it("awaits host shutdown before stopping HTTP and is idempotent", async () => {
    const order: string[] = [];
    const host = {
      bootstrap: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn(async () => {
        await Promise.resolve();
        order.push("shutdown");
      }),
    };
    const httpServer = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(async () => {
        order.push("http-stop");
      }),
    };
    const lifecycle = new BuiltinRuntimeHostLifecycle(
      host as never,
      httpServer as never
    );

    const first = lifecycle.onApplicationShutdown();
    const second = lifecycle.onApplicationShutdown();
    await Promise.all([first, second]);

    expect(order).toEqual(["shutdown", "http-stop"]);
    expect(host.shutdown).toHaveBeenCalledTimes(1);
    expect(httpServer.stop).toHaveBeenCalledTimes(1);
  });
});
