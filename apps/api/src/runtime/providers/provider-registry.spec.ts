import { describe, it, expect, beforeEach } from "vitest";
import { RuntimeProviderRegistry } from "./provider-registry";
import type { RuntimeProvider } from "./provider-contracts";

describe("RuntimeProviderRegistry", () => {
  let registry: RuntimeProviderRegistry;
  let mockSandboxProvider: RuntimeProvider;

  beforeEach(() => {
    mockSandboxProvider = {
      type: "sandbox" as const,
      recoverOrphan: async () => undefined,
    };
    registry = new RuntimeProviderRegistry([mockSandboxProvider]);
  });

  it("resolves local to a built-in no-op provider", async () => {
    const provider = registry.resolve("local");
    expect(provider.type).toBe("local");
    expect(provider).not.toBe(mockSandboxProvider);
    await expect(provider.recoverOrphan("legacy-local")).resolves.toBeUndefined();
    expect(() => provider.shutdownRuntimeInstance?.("ws-1")).not.toThrow();
  });

  it("should resolve sandbox provider", () => {
    const provider = registry.resolve("sandbox");
    expect(provider.type).toBe("sandbox");
    expect(provider).toBe(mockSandboxProvider);
  });

  it("should throw for unknown provider type", () => {
    expect(() => registry.resolve("docker")).toThrow(
      "Unknown runtime provider: docker"
    );
  });

  it("all returns only registered providers", () => {
    expect(registry.all()).toEqual([mockSandboxProvider]);
  });
});
