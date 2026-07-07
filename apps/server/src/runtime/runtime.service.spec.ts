import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConfigService } from "../config/config.service";
import { LocalRuntime } from "./local/local-runtime";
import { RemoteRuntime } from "./remote/remote-runtime";
import { RuntimeRepository, type RuntimeRow } from "./runtime.repository";
import { RuntimeTunnelHandler } from "./gateway/runtime-tunnel.handler";
import { RuntimeService } from "./runtime.service";

const mockEnvConfig = {
  claude: {
    executablePath: "/usr/bin/claude",
    version: "1.0",
    authAvailable: true,
  },
  codex: { executablePath: null, version: null, authAvailable: false },
  detectedAt: "2026-07-06T00:00:00.000Z",
};

function makeRow(overrides: Partial<RuntimeRow> = {}): RuntimeRow {
  return {
    id: "rt-1",
    name: "mac-studio",
    source: "registered",
    runtimeType: null,
    ownerId: "u-1",
    status: "offline",
    lastHeartbeatAt: null,
    createdAt: new Date("2026-07-04T00:00:00Z"),
    capabilities: null,
    envConfig: null,
    envConfigOverride: null,
    removedAt: null,
    ...overrides,
  };
}

// 起/停/毁的 provider 分发测试在 local/local-runtime.spec.ts;这里测门面:
// runtimeFor 解析、resolveRuntimeSpec 纯计算、getRuntimePolicy 读配置、配对管理、
// builtin 注册表 upsert。
describe("RuntimeService", () => {
  let configService: Partial<ConfigService>;
  let localRuntime: LocalRuntime;
  let repository: {
    create: ReturnType<typeof vi.fn>;
    listVisibleToOwner: ReturnType<typeof vi.fn>;
    listAll: ReturnType<typeof vi.fn>;
    revokeByOwner: ReturnType<typeof vi.fn>;
    findVisibleToOwner: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    upsertBuiltin: ReturnType<typeof vi.fn>;
    updateEnvConfig: ReturnType<typeof vi.fn>;
    updateEnvConfigOverride: ReturnType<typeof vi.fn>;
  };
  let tunnelHandler: {
    closeConnection: ReturnType<typeof vi.fn>;
    isConnected: ReturnType<typeof vi.fn>;
    sendRequest: ReturnType<typeof vi.fn>;
  };
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
      getLaunchTimeoutSeconds: vi.fn().mockReturnValue(20),
    };
    localRuntime = {
      start: vi.fn(),
      stop: vi.fn(),
      destroy: vi.fn(),
      detectEnv: vi.fn().mockResolvedValue(mockEnvConfig),
      listDirectory: vi
        .fn()
        .mockResolvedValue({ path: "/home/agework", entries: ["/home/agework/foo"] }),
      createDirectory: vi
        .fn()
        .mockResolvedValue({ path: "/home/agework/new" }),
    } as unknown as LocalRuntime;
    repository = {
      create: vi.fn().mockResolvedValue(makeRow()),
      listVisibleToOwner: vi.fn().mockResolvedValue([makeRow()]),
      listAll: vi.fn().mockResolvedValue([makeRow()]),
      revokeByOwner: vi.fn().mockResolvedValue(true),
      findVisibleToOwner: vi.fn().mockResolvedValue(makeRow()),
      findById: vi.fn().mockResolvedValue(makeRow()),
      upsertBuiltin: vi.fn().mockResolvedValue(makeRow({ source: "builtin" })),
      updateEnvConfig: vi.fn().mockResolvedValue(true),
      updateEnvConfigOverride: vi.fn().mockResolvedValue(true),
    };
    tunnelHandler = {
      closeConnection: vi.fn(),
      isConnected: vi.fn().mockReturnValue(false),
      sendRequest: vi.fn(),
    };
    service = new RuntimeService(
      configService as ConfigService,
      localRuntime,
      repository as unknown as RuntimeRepository,
      tunnelHandler as unknown as RuntimeTunnelHandler
    );
  });

  it("runtimeFor(builtin id) resolves the managed LocalRuntime", () => {
    expect(service.runtimeFor("builtin-local")).toBe(localRuntime);
    expect(service.runtimeFor("builtin-docker")).toBe(localRuntime);
  });

  it("runtimeFor(registered id) resolves a RemoteRuntime bound to that id", () => {
    const remote = service.runtimeFor("rt-1");
    expect(remote).toBeInstanceOf(RemoteRuntime);
  });

  it("isManaged distinguishes builtin ids from registered ids", () => {
    expect(service.isManaged("builtin-local")).toBe(true);
    expect(service.isManaged("rt-1")).toBe(false);
  });

  it("getBuiltinRuntimeId returns the fixed id for a runtimeType", () => {
    expect(service.getBuiltinRuntimeId("docker")).toBe("builtin-docker");
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

  it("onApplicationBootstrap upserts a builtin row per allowed runtimeType and detects envConfig", async () => {
    await service.onApplicationBootstrap();
    expect(repository.upsertBuiltin).toHaveBeenCalledTimes(3);
    expect(repository.upsertBuiltin).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "builtin-local",
        runtimeType: "local",
        capabilities: { isolationScopes: ["workspace"] },
      })
    );
    expect(repository.upsertBuiltin).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "builtin-docker",
        runtimeType: "docker",
        capabilities: { isolationScopes: ["user", "workspace"] },
      })
    );
    // builtin runtime 的 envConfig 也应被检测并写入
    expect(repository.updateEnvConfig).toHaveBeenCalledTimes(3);
    expect(repository.updateEnvConfig).toHaveBeenCalledWith(
      "builtin-local",
      expect.objectContaining({ claude: expect.any(Object) })
    );
  });

  it("detectEnv for builtin runtime uses local detection", async () => {
    const result = await service.detectEnv("builtin-local");
    expect(result.envConfig).not.toBeNull();
    expect(repository.updateEnvConfig).toHaveBeenCalledWith(
      "builtin-local",
      expect.objectContaining({ claude: expect.any(Object) })
    );
    // 不应该走隧道
    expect(tunnelHandler.sendRequest).not.toHaveBeenCalled();
  });

  it("detectEnv for registered runtime uses tunnel when connected", async () => {
    tunnelHandler.isConnected.mockReturnValue(true);
    const mockEnvConfig = {
      claude: { executablePath: "/bin/claude", version: "2.0", authAvailable: true },
      codex: { executablePath: null, version: null, authAvailable: false },
      detectedAt: "2026-07-06T01:00:00.000Z",
    };
    tunnelHandler.sendRequest.mockResolvedValue({ envConfig: mockEnvConfig });

    const result = await service.detectEnv("rt-1");
    expect(result.envConfig).toEqual(mockEnvConfig);
    expect(repository.updateEnvConfig).toHaveBeenCalledWith("rt-1", mockEnvConfig);
  });

  it("detectEnv for disconnected registered runtime returns null", async () => {
    tunnelHandler.isConnected.mockReturnValue(false);
    const result = await service.detectEnv("rt-1");
    expect(result.envConfig).toBeNull();
  });

  it("create stores only the sha256 of the pairing token and returns the plaintext once", async () => {
    const result = await service.create("u-1", "mac-studio");

    expect(result.token).toMatch(/^[0-9a-f]{64}$/);
    const stored = repository.create.mock.calls[0][0];
    expect(stored.name).toBe("mac-studio");
    expect(stored.ownerId).toBe("u-1");
    expect(stored.tokenHash).not.toBe(result.token);
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.runtime).not.toHaveProperty("tokenHash");
  });

  it("create maps unique violation to ConflictException", async () => {
    repository.create.mockRejectedValueOnce({ code: "P2002" });
    await expect(service.create("u-1", "mac-studio")).rejects.toThrow(
      "runtime name already exists"
    );
  });

  it("list maps rows to response shape", async () => {
    const { list } = await service.list("u-1");
    expect(list).toEqual([
      {
        id: "rt-1",
        name: "mac-studio",
        source: "registered",
        ownerId: "u-1",
        runtimeType: null,
        status: "offline",
        capabilities: null,
        envConfig: null,
        envConfigOverride: null,
        envStatus: null,
        lastHeartbeatAt: null,
        createdAt: "2026-07-04T00:00:00.000Z",
      },
    ]);
  });

  it("listAll maps rows to response shape", async () => {
    const { list } = await service.listAll();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("rt-1");
  });

  it("delete revokes the row but does not touch the live tunnel connection", async () => {
    await service.delete("u-1", "rt-1");
    expect(repository.revokeByOwner).toHaveBeenCalledWith("u-1", "rt-1");
    expect(tunnelHandler.closeConnection).not.toHaveBeenCalled();
  });

  it("delete throws NotFound when the row is missing or owned by someone else", async () => {
    repository.revokeByOwner.mockResolvedValueOnce(false);
    await expect(service.delete("u-1", "rt-x")).rejects.toThrow(
      "runtime not found"
    );
  });

  it("getOwned delegates to repository.findVisibleToOwner and returns the row", async () => {
    const result = await service.getOwned("u-1", "rt-1");
    expect(repository.findVisibleToOwner).toHaveBeenCalledWith("u-1", "rt-1");
    expect(result).toEqual(makeRow());
  });

  it("getOwned returns null when the row is missing or owned by someone else", async () => {
    repository.findVisibleToOwner.mockResolvedValueOnce(null);
    const result = await service.getOwned("u-1", "rt-x");
    expect(result).toBeNull();
  });

  it("listDirectory for builtin runtime delegates to LocalRuntime and maps entries to list", async () => {
    const result = await service.listDirectory("u-1", "builtin-local", "/home/agework");
    expect(localRuntime.listDirectory).toHaveBeenCalledWith("/home/agework");
    expect(result).toEqual({
      path: "/home/agework",
      list: ["/home/agework/foo"],
    });
  });

  it("listDirectory throws NotFoundException when the runtime is not visible to the user", async () => {
    repository.findVisibleToOwner.mockResolvedValueOnce(null);
    await expect(
      service.listDirectory("u-1", "rt-x", undefined)
    ).rejects.toThrow("runtime not found");
  });

  it("listDirectory for a disconnected registered runtime throws BadRequestException", async () => {
    tunnelHandler.isConnected.mockReturnValue(false);
    await expect(
      service.listDirectory("u-1", "rt-1", undefined)
    ).rejects.toThrow("is not connected");
  });

  it("listDirectory wraps underlying filesystem errors as BadRequestException", async () => {
    (localRuntime.listDirectory as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("目录不存在或不可访问")
    );
    await expect(
      service.listDirectory("u-1", "builtin-local", "/no/such/dir")
    ).rejects.toThrow("目录不存在或不可访问");
  });

  it("createDirectory for builtin runtime delegates to LocalRuntime", async () => {
    const result = await service.createDirectory(
      "u-1",
      "builtin-local",
      "/home/agework/new"
    );
    expect(localRuntime.createDirectory).toHaveBeenCalledWith(
      "/home/agework/new"
    );
    expect(result).toEqual({ path: "/home/agework/new" });
  });

  it("createDirectory for registered runtime delegates to RemoteRuntime over the tunnel", async () => {
    tunnelHandler.isConnected.mockReturnValue(true);
    tunnelHandler.sendRequest.mockResolvedValue({ path: "/data/new" });
    const result = await service.createDirectory("u-1", "rt-1", "/data/new");
    expect(tunnelHandler.sendRequest).toHaveBeenCalledWith(
      "rt-1",
      expect.objectContaining({ method: "runtime.create-dir" }),
      expect.any(Number)
    );
    expect(result).toEqual({ path: "/data/new" });
  });
});
