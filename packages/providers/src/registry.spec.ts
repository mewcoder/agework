import { describe, it, expect } from "vitest";
import { createRuntimeResolver } from "./registry";
import type { RuntimeConfig, RuntimeType } from "./types";

const CONFIG: RuntimeConfig = {
  workerImage: "agework-worker:test",
  runtimeLogHostPath: "/tmp/agework-runtime-logs",
  serverBaseUrl: "http://127.0.0.1:3000/api/v1",
  native: {
    runtimeEntryPath: "/tmp/worker/index.js",
  },
  openSandbox: {
    domain: "opensandbox.test",
    protocol: "https",
    apiKey: "test-key",
    useServerProxy: false,
  },
};

describe("createRuntimeResolver", () => {
  it("resolves each runtimeType to its matching provider (build-once)", () => {
    const resolve = createRuntimeResolver(CONFIG);
    expect(resolve("native").type).toBe("native");
    expect(resolve("docker").type).toBe("docker");
    expect(resolve("opensandbox").type).toBe("opensandbox");
  });

  it("returns the same long-lived instance across calls (singleton)", () => {
    const resolve = createRuntimeResolver(CONFIG);
    expect(resolve("native")).toBe(resolve("native"));
  });

  it("throws for an unknown runtimeType", () => {
    const resolve = createRuntimeResolver(CONFIG);
    expect(() => resolve("unknown" as RuntimeType)).toThrow(
      /Unknown runtime provider/
    );
  });

  it("the legacy 'sandbox' runtimeType is dead: resolving throws", () => {
    const resolve = createRuntimeResolver(CONFIG);
    expect(() => resolve("sandbox" as RuntimeType)).toThrow(
      /Unknown runtime provider/
    );
  });
});
