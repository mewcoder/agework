import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConfigService } from "../config/config.service";
import { LocalRuntime } from "./local/local-runtime";
import { RuntimeService } from "./runtime.service";

// 起/停/毁的 provider 分发测试在 local/local-runtime.spec.ts;这里测门面:
// runtimeFor 解析、resolveRuntimeSpec 纯计算、getRuntimePolicy 读配置。
describe("RuntimeService", () => {
  let configService: Partial<ConfigService>;
  let localRuntime: LocalRuntime;
  let service: RuntimeService;

  beforeEach(() => {
    configService = {
      getDefaultRuntimeType: vi.fn().mockReturnValue("local"),
      getDefaultIsolationScope: vi.fn().mockReturnValue("user"),
      getAllowedRuntimeTypes: vi
        .fn()
        .mockReturnValue(["local", "docker", "opensandbox"]),
      getAllowedIsolationScopes: vi.fn().mockReturnValue(["user", "workspace"]),
      getIdleTimeoutSeconds: vi.fn().mockReturnValue(600),
    };
    localRuntime = {
      start: vi.fn(),
      stop: vi.fn(),
      destroy: vi.fn(),
    } as unknown as LocalRuntime;
    service = new RuntimeService(configService as ConfigService, localRuntime);
  });

  it("runtimeFor(null) resolves the managed LocalRuntime", () => {
    expect(service.runtimeFor(null)).toBe(localRuntime);
  });

  it("runtimeFor rejects registered runtime ids until Phase 2", () => {
    expect(() => service.runtimeFor("rt-1")).toThrow(
      "Registered runtime not supported yet: rt-1"
    );
  });

  it("resolveRuntimeSpec delegates to the pure resolver", () => {
    const result = service.resolveRuntimeSpec({
      userId: "u-1",
      workspaceId: "ws-1",
      workspaceRootPath: "/data/u-1/ws-1",
      userWorkspaceRootPath: "/data/u-1",
      runtimeLogHostPath: "/data/logs/runtime",
      runtimeType: "local",
    });
    expect(result.runtimeType).toBe("local");
    expect(result.ownerId).toBe("ws-1");
  });

  it("getRuntimePolicy reads from ConfigService", () => {
    expect(service.getRuntimePolicy()).toEqual({
      runtimeType: "local",
      allowedRuntimeTypes: ["local", "docker", "opensandbox"],
      isolationScope: "user",
      allowedIsolationScopes: ["user", "workspace"],
      idleTimeoutSeconds: 600,
    });
  });
});
