import { describe, it, expect, beforeEach } from "vitest";
import { RuntimeProviderRegistry } from "./provider-registry";
import type { RuntimeProvider } from "./provider-contracts";

describe("RuntimeProviderRegistry", () => {
  let registry: RuntimeProviderRegistry;
  let mockLocalProvider: RuntimeProvider;
  let mockSandboxProvider: RuntimeProvider;

  beforeEach(() => {
    mockLocalProvider = {
      type: "local" as const,
      recoverOrphan: async () => undefined,
    };
    mockSandboxProvider = {
      type: "sandbox" as const,
      recoverOrphan: async () => undefined,
    };
    registry = new RuntimeProviderRegistry([
      mockLocalProvider,
      mockSandboxProvider,
    ]);
  });

  it("should resolve local provider", () => {
    const provider = registry.resolve("local");
    expect(provider.type).toBe("local");
    expect(provider).toBe(mockLocalProvider);
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
});
