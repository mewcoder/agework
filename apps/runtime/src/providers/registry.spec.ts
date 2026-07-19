import { describe, it, expect } from "vitest";
import { createRuntimeResolver } from "./registry";
import type {
  RuntimeProviderPlugin,
  RuntimeType,
} from "@agework/runtime-sdk";
import type { RuntimeHostProviderConfig } from "./types";
import { createRuntimePlugin as createDockerRuntimePlugin } from "@agework/runtime-docker";

const CONFIG: RuntimeHostProviderConfig = {
  workerImage: "agework-worker:test",
  runtimeLogHostPath: "/tmp/agework-runtime-logs",
  workerApiBaseUrl: "http://127.0.0.1:7101/api/v1",
  native: {
    runtimeEntryPath: "/tmp/worker/index.js",
  },
};

describe("createRuntimeResolver", () => {
  it("keeps only native as a built-in runtime", () => {
    const resolve = createRuntimeResolver(CONFIG);
    expect(resolve("native").type).toBe("native");
    expect(() => resolve("docker")).toThrow(/Unknown runtime provider/);
  });

  it("resolves Docker through the same plugin path as external runtimes", () => {
    const resolve = createRuntimeResolver(CONFIG, [createDockerRuntimePlugin()]);
    expect(resolve("docker").type).toBe("docker");
  });

  it("resolves an externally supplied runtime provider plugin", () => {
    const plugin: RuntimeProviderPlugin = {
      apiVersion: 1,
      type: "opensandbox",
      displayName: "OpenSandbox",
      scopes: ["user", "workspace"],
      create: () => ({
        type: "opensandbox",
        start: async () => ({ runtimeInstanceId: "sandbox-1" }),
        release: async () => {},
        stop: async () => {},
        destroy: async () => {},
      }),
    };
    const resolve = createRuntimeResolver(CONFIG, [plugin]);
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

  it("throws when an optional runtime has no plugin", () => {
    const resolve = createRuntimeResolver(CONFIG);
    expect(() => resolve("opensandbox")).toThrow(/Unknown runtime provider/);
  });

  it("rejects a plugin that shadows the native built-in provider", () => {
    const plugin: RuntimeProviderPlugin = {
      apiVersion: 1,
      type: "native",
      displayName: "Native replacement",
      scopes: ["workspace"],
      create: () => ({
        type: "native",
        start: async () => ({ runtimeInstanceId: "native-1" }),
        release: async () => {},
        stop: async () => {},
        destroy: async () => {},
      }),
    };
    expect(() => createRuntimeResolver(CONFIG, [plugin])).toThrow(
      /Duplicate runtime provider/
    );
  });

  it("the legacy 'sandbox' runtimeType is dead: resolving throws", () => {
    const resolve = createRuntimeResolver(CONFIG);
    expect(() => resolve("sandbox" as RuntimeType)).toThrow(
      /Unknown runtime provider/
    );
  });
});
