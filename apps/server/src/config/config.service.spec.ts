import { describe, it, expect, vi, afterEach } from "vitest";
import { DEV_JWT_SECRET, getJwtSecret, ConfigService } from "./config.service";
import { SystemSettingRepository } from "./system-setting.repository";

function createService(rows: { key: string; value: string }[]) {
  const findMany = vi.fn().mockResolvedValue(rows);
  const upsert = vi.fn().mockResolvedValue(undefined);
  const deleteMany = vi.fn().mockResolvedValue(undefined);
  const repo = new SystemSettingRepository({
    systemSetting: { findMany, upsert, deleteMany },
  } as never);
  const service = new ConfigService(repo);
  return { service, findMany, upsert, deleteMany };
}

describe("getJwtSecret", () => {
  const originalSecret = process.env.AGEWORK_PRIVATE_JWT_SECRET;
  const originalDevAuthDisabled = process.env.AGEWORK_DEV_AUTH_DISABLED;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.AGEWORK_PRIVATE_JWT_SECRET;
    } else {
      process.env.AGEWORK_PRIVATE_JWT_SECRET = originalSecret;
    }
    if (originalDevAuthDisabled === undefined) {
      delete process.env.AGEWORK_DEV_AUTH_DISABLED;
    } else {
      process.env.AGEWORK_DEV_AUTH_DISABLED = originalDevAuthDisabled;
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it("returns AGEWORK_PRIVATE_JWT_SECRET when set", () => {
    process.env.NODE_ENV = "test";
    process.env.AGEWORK_PRIVATE_JWT_SECRET = "custom-secret";
    expect(getJwtSecret()).toBe("custom-secret");
  });

  it("falls back to DEV_JWT_SECRET when unset and AGEWORK_DEV_AUTH_DISABLED=true", () => {
    process.env.NODE_ENV = "development";
    delete process.env.AGEWORK_PRIVATE_JWT_SECRET;
    process.env.AGEWORK_DEV_AUTH_DISABLED = "true";
    expect(getJwtSecret()).toBe(DEV_JWT_SECRET);
  });

  it("fails fast when AGEWORK_PRIVATE_JWT_SECRET unset and AGEWORK_DEV_AUTH_DISABLED is not true", () => {
    process.env.NODE_ENV = "test";
    delete process.env.AGEWORK_PRIVATE_JWT_SECRET;
    delete process.env.AGEWORK_DEV_AUTH_DISABLED;
    expect(() => getJwtSecret()).toThrow("未配置 AGEWORK_PRIVATE_JWT_SECRET");
  });

  it("fails fast in production when AGEWORK_PRIVATE_JWT_SECRET is missing", () => {
    process.env.NODE_ENV = "production";
    delete process.env.AGEWORK_PRIVATE_JWT_SECRET;
    process.env.AGEWORK_DEV_AUTH_DISABLED = "true";

    expect(() => getJwtSecret()).toThrow(
      "生产环境必须配置安全的 AGEWORK_PRIVATE_JWT_SECRET"
    );
  });

  it("fails fast in production when AGEWORK_PRIVATE_JWT_SECRET is DEV_JWT_SECRET", () => {
    process.env.NODE_ENV = "production";
    process.env.AGEWORK_PRIVATE_JWT_SECRET = DEV_JWT_SECRET;

    expect(() => getJwtSecret()).toThrow(
      "生产环境必须配置安全的 AGEWORK_PRIVATE_JWT_SECRET"
    );
  });
});

describe("runtime capability config", () => {
  const originalAllowedTypes = process.env.AGEWORK_RUNTIME_ALLOWED_TYPES;
  const originalAllowedIsolationScopes =
    process.env.AGEWORK_RUNTIME_ALLOWED_ISOLATION_SCOPES;

  afterEach(() => {
    if (originalAllowedTypes === undefined) {
      delete process.env.AGEWORK_RUNTIME_ALLOWED_TYPES;
    } else {
      process.env.AGEWORK_RUNTIME_ALLOWED_TYPES = originalAllowedTypes;
    }
    if (originalAllowedIsolationScopes === undefined) {
      delete process.env.AGEWORK_RUNTIME_ALLOWED_ISOLATION_SCOPES;
    } else {
      process.env.AGEWORK_RUNTIME_ALLOWED_ISOLATION_SCOPES =
        originalAllowedIsolationScopes;
    }
  });

  it("defaults to native when AGEWORK_RUNTIME_ALLOWED_TYPES is unset", async () => {
    delete process.env.AGEWORK_RUNTIME_ALLOWED_TYPES;
    const { service } = createService([]);

    expect(service.getAllowedRuntimeTypes()).toEqual(["native"]);
    expect(service.getDefaultRuntimeType()).toBe("native");
  });

  it("parses allowed runtime types and uses the first as the create default", async () => {
    process.env.AGEWORK_RUNTIME_ALLOWED_TYPES = "docker,native";
    const { service } = createService([]);

    expect(service.getAllowedRuntimeTypes()).toEqual(["docker", "native"]);
    expect(service.getDefaultRuntimeType()).toBe("docker");
    expect(service.isRuntimeTypeAllowed("native")).toBe(true);
  });

  it("accepts all three runtime types (native, docker, opensandbox)", async () => {
    process.env.AGEWORK_RUNTIME_ALLOWED_TYPES = "native,docker,opensandbox";
    const { service } = createService([]);

    expect(service.getAllowedRuntimeTypes()).toEqual([
      "native",
      "docker",
      "opensandbox",
    ]);
  });

  it("fails fast on invalid runtime capability values", async () => {
    process.env.AGEWORK_RUNTIME_ALLOWED_TYPES = "native,bogus";
    const { service } = createService([]);

    expect(() => service.getAllowedRuntimeTypes()).toThrow(
      'AGEWORK_RUNTIME_ALLOWED_TYPES expects comma-separated values from "native", "docker", "opensandbox"'
    );
  });

  it("defaults to user isolation when AGEWORK_RUNTIME_ALLOWED_ISOLATION_SCOPES is unset", async () => {
    delete process.env.AGEWORK_RUNTIME_ALLOWED_ISOLATION_SCOPES;
    const { service } = createService([]);

    expect(service.getAllowedIsolationScopes()).toEqual(["user"]);
    expect(service.getDefaultIsolationScope()).toBe("user");
  });

  it("parses allowed isolation scopes and uses the first as the create default", async () => {
    process.env.AGEWORK_RUNTIME_ALLOWED_ISOLATION_SCOPES = "workspace,user";
    const { service } = createService([]);

    expect(service.getAllowedIsolationScopes()).toEqual(["workspace", "user"]);
    expect(service.getDefaultIsolationScope()).toBe("workspace");
    expect(service.isIsolationScopeAllowed("user")).toBe(true);
  });

  it("fails fast on invalid isolation capability values", async () => {
    process.env.AGEWORK_RUNTIME_ALLOWED_ISOLATION_SCOPES = "user,bogus";
    const { service } = createService([]);

    expect(() => service.getAllowedIsolationScopes()).toThrow(
      'AGEWORK_RUNTIME_ALLOWED_ISOLATION_SCOPES expects comma-separated values from "user", "workspace"'
    );
  });
});

describe("ConfigService settings (DB > env > default)", () => {
  const original = process.env.AGEWORK_RUNTIME_IDLE_TIMEOUT_SECONDS;
  const originalRunTimeout = process.env.AGEWORK_RUNTIME_RUN_TIMEOUT_SECONDS;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.AGEWORK_RUNTIME_IDLE_TIMEOUT_SECONDS;
    } else {
      process.env.AGEWORK_RUNTIME_IDLE_TIMEOUT_SECONDS = original;
    }
    if (originalRunTimeout === undefined) {
      delete process.env.AGEWORK_RUNTIME_RUN_TIMEOUT_SECONDS;
    } else {
      process.env.AGEWORK_RUNTIME_RUN_TIMEOUT_SECONDS = originalRunTimeout;
    }
  });

  it("falls back to env when no DB override exists", async () => {
    process.env.AGEWORK_RUNTIME_IDLE_TIMEOUT_SECONDS = "900";
    const { service } = createService([]);
    await service.onModuleInit();

    expect(service.getIdleTimeoutSeconds()).toBe(900);
  });

  it("DB override takes priority over env", async () => {
    process.env.AGEWORK_RUNTIME_IDLE_TIMEOUT_SECONDS = "900";
    const { service } = createService([
      { key: "AGEWORK_RUNTIME_IDLE_TIMEOUT_SECONDS", value: "3600" },
    ]);
    await service.onModuleInit();

    expect(service.getIdleTimeoutSeconds()).toBe(3600);
  });

  it("falls back to default when neither DB nor env is set", async () => {
    delete process.env.AGEWORK_RUNTIME_IDLE_TIMEOUT_SECONDS;
    const { service } = createService([]);
    await service.onModuleInit();

    expect(service.getIdleTimeoutSeconds()).toBe(1800);
  });

  it("reads run timeout from env when no DB override exists", async () => {
    process.env.AGEWORK_RUNTIME_RUN_TIMEOUT_SECONDS = "120";
    const { service } = createService([]);
    await service.onModuleInit();

    expect(service.getRunTimeoutSeconds()).toBe(120);
  });

  it("DB run timeout override takes priority over env", async () => {
    process.env.AGEWORK_RUNTIME_RUN_TIMEOUT_SECONDS = "120";
    const { service } = createService([
      { key: "AGEWORK_RUNTIME_RUN_TIMEOUT_SECONDS", value: "240" },
    ]);
    await service.onModuleInit();

    expect(service.getRunTimeoutSeconds()).toBe(240);
  });

  it("falls back to the default run timeout when neither DB nor env is set", async () => {
    delete process.env.AGEWORK_RUNTIME_RUN_TIMEOUT_SECONDS;
    const { service } = createService([]);
    await service.onModuleInit();

    expect(service.getRunTimeoutSeconds()).toBe(1800);
  });

  it("setSetting() persists and immediately refreshes the cache (hot reload)", async () => {
    const { service, upsert } = createService([]);
    await service.onModuleInit();

    await service.setSetting("AGEWORK_APP_NAME", "MyApp", "user-1");

    expect(upsert).toHaveBeenCalledWith({
      where: { key: "AGEWORK_APP_NAME" },
      create: { key: "AGEWORK_APP_NAME", value: "MyApp", updatedBy: "user-1" },
      update: { value: "MyApp", updatedBy: "user-1" },
    });
    expect(service.getAppName()).toBe("MyApp");
  });

  it("setSetting() rejects an unknown key", async () => {
    const { service } = createService([]);
    await service.onModuleInit();

    await expect(
      service.setSetting("UNKNOWN_KEY", "x", "user-1")
    ).rejects.toThrow("未知的系统设置项");
  });

  it("setSetting() rejects a non-numeric value for a numeric key", async () => {
    const { service } = createService([]);
    await service.onModuleInit();

    await expect(
      service.setSetting(
        "AGEWORK_RUNTIME_IDLE_TIMEOUT_SECONDS",
        "abc",
        "user-1"
      )
    ).rejects.toThrow("必须是数字");
  });

  it("resetSetting() removes the DB override and falls back to env", async () => {
    process.env.AGEWORK_RUNTIME_IDLE_TIMEOUT_SECONDS = "900";
    const { service, deleteMany } = createService([
      { key: "AGEWORK_RUNTIME_IDLE_TIMEOUT_SECONDS", value: "3600" },
    ]);
    await service.onModuleInit();
    expect(service.getIdleTimeoutSeconds()).toBe(3600);

    await service.resetSetting("AGEWORK_RUNTIME_IDLE_TIMEOUT_SECONDS");

    expect(deleteMany).toHaveBeenCalledWith({
      where: { key: "AGEWORK_RUNTIME_IDLE_TIMEOUT_SECONDS" },
    });
    expect(service.getIdleTimeoutSeconds()).toBe(900);
  });

  it("listSettings() reports the source of each registry entry", async () => {
    process.env.AGEWORK_RUNTIME_IDLE_TIMEOUT_SECONDS = "900";
    const { service } = createService([
      { key: "AGEWORK_APP_NAME", value: "MyApp" },
    ]);
    await service.onModuleInit();

    const list = service.listSettings();

    expect(list).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "AGEWORK_APP_NAME",
          value: "MyApp",
          source: "db",
        }),
        expect.objectContaining({
          key: "AGEWORK_RUNTIME_IDLE_TIMEOUT_SECONDS",
          value: "900",
          source: "env",
        }),
      ])
    );
  });
});

describe("ConfigService.isDevAuthDisabled", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalDevAuthDisabled = process.env.AGEWORK_DEV_AUTH_DISABLED;

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    if (originalDevAuthDisabled === undefined) {
      delete process.env.AGEWORK_DEV_AUTH_DISABLED;
    } else {
      process.env.AGEWORK_DEV_AUTH_DISABLED = originalDevAuthDisabled;
    }
  });

  function makeService() {
    return createService([]).service;
  }

  it("returns true when NODE_ENV is development and flag is true", () => {
    process.env.NODE_ENV = "development";
    process.env.AGEWORK_DEV_AUTH_DISABLED = "true";
    expect(makeService().isDevAuthDisabled()).toBe(true);
  });

  it("returns true when NODE_ENV is unset and flag is true", () => {
    delete process.env.NODE_ENV;
    process.env.AGEWORK_DEV_AUTH_DISABLED = "true";
    expect(makeService().isDevAuthDisabled()).toBe(true);
  });

  it("returns false when NODE_ENV is production even if flag is true", () => {
    process.env.NODE_ENV = "production";
    process.env.AGEWORK_DEV_AUTH_DISABLED = "true";
    expect(makeService().isDevAuthDisabled()).toBe(false);
  });

  it("returns false when NODE_ENV is test even if flag is true", () => {
    process.env.NODE_ENV = "test";
    process.env.AGEWORK_DEV_AUTH_DISABLED = "true";
    expect(makeService().isDevAuthDisabled()).toBe(false);
  });

  it("returns false when flag is not true", () => {
    process.env.NODE_ENV = "development";
    process.env.AGEWORK_DEV_AUTH_DISABLED = "false";
    expect(makeService().isDevAuthDisabled()).toBe(false);
  });

  it("returns false when flag is unset", () => {
    process.env.NODE_ENV = "development";
    delete process.env.AGEWORK_DEV_AUTH_DISABLED;
    expect(makeService().isDevAuthDisabled()).toBe(false);
  });
});
