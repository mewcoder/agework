import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConfigService } from "../config/config.service";
import { LocalRuntime } from "./local/local-runtime";
import { RemoteRuntime } from "./remote/remote-runtime";
import { RuntimeRepository, type RuntimeHostRow } from "./runtime.repository";
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

function makeRow(overrides: Partial<RuntimeHostRow> = {}): RuntimeHostRow {
  return {
    id: "rt-1",
    name: "mac-studio",
    source: "registered",
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
// managed 注册表 upsert。
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
      getDefaultRuntimeType: vi.fn().mockReturnValue("native"),
      getDefaultIsolationScope: vi.fn().mockReturnValue("user"),
      getAllowedRuntimeTypes: vi
        .fn()
        .mockReturnValue(["native", "docker", "opensandbox"]),
      getAllowedIsolationScopes: vi.fn().mockReturnValue(["user", "workspace"]),
      getIdleTimeoutSeconds: vi.fn().mockReturnValue(600),
      getLaunchTimeoutSeconds: vi.fn().mockReturnValue(20),
    };
    localRuntime = {
      start: vi.fn(),
      stop: vi.fn(),
      destroy: vi.fn(),
      detectEnv: vi.fn().mockResolvedValue(mockEnvConfig),
      listDirectory: vi.fn().mockResolvedValue({
        path: "/home/agework",
        entries: ["/home/agework/foo"],
      }),
      createDirectory: vi.fn().mockResolvedValue({ path: "/home/agework/new" }),
      listFiles: vi.fn().mockResolvedValue({
        path: "src",
        list: [{ name: "a.ts", type: "file", size: 10 }],
        truncated: false,
      }),
      readFile: vi.fn().mockResolvedValue({
        path: "a.ts",
        encoding: "utf8",
        content: "hello",
        size: 5,
        truncated: false,
      }),
      listChangedFiles: vi.fn().mockResolvedValue({
        list: [
          { path: "a.ts", status: "modified", additions: 1, deletions: 0 },
        ],
        truncated: false,
      }),
      readFileDiff: vi.fn().mockResolvedValue({
        path: "a.ts",
        status: "modified",
        before: "old",
        after: "new",
      }),
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

  it("runtimeFor(builtin) resolves LocalRuntime; registered ids resolve RemoteRuntime", () => {
    expect(service.runtimeFor("builtin")).toBe(localRuntime);
    expect(service.runtimeFor("rt-1")).toBeInstanceOf(RemoteRuntime);
  });

  it("runtimeFor(registered id) resolves a RemoteRuntime bound to that id", () => {
    const remote = service.runtimeFor("rt-1");
    expect(remote).toBeInstanceOf(RemoteRuntime);
  });

  it("isManaged distinguishes managed ids from registered ids", () => {
    expect(service.isManaged("builtin")).toBe(true);
    expect(service.isManaged("builtin")).toBe(true);
    expect(service.isManaged("rt-1")).toBe(false);
  });

  it("getManagedRuntimeId returns the fixed id for a runtimeType", () => {
    expect(service.getManagedRuntimeId("docker")).toBe("builtin");
  });

  it("resolveRuntimeSpec delegates to the pure resolver", () => {
    const result = service.resolveRuntimeSpec({
      userId: "u-1",
      workspaceId: "ws-1",
      workspaceRootPath: "/data/u-1/ws-1",
      userWorkspaceRootPath: "/data/u-1",
      runtimeLogHostPath: "/data/logs/runtime",
      runtimeType: "native",
    });
    expect(result.runtimeType).toBe("native");
    expect(result.ownerId).toBe("ws-1");
  });

  it("getRuntimePolicy reads from ConfigService", () => {
    expect(service.getRuntimePolicy()).toEqual({
      runtimeType: "native",
      allowedRuntimeTypes: ["native", "docker", "opensandbox"],
      scope: "user",
      allowedIsolationScopes: ["user", "workspace"],
      idleTimeoutSeconds: 600,
    });
  });

  it("onApplicationBootstrap: upserts one multi-runtimeType builtin Host", async () => {
    await service.onApplicationBootstrap();
    expect(repository.upsertBuiltin).toHaveBeenCalledTimes(1);
    expect(repository.upsertBuiltin).toHaveBeenCalledWith({
      name: "builtin",
      capabilities: {
        native: { available: true, scopes: ["workspace"] },
        docker: { available: true, scopes: ["user", "workspace"] },
        opensandbox: {
          available: true,
          scopes: ["user", "workspace"],
        },
      },
      tokenHash: null,
    });
    expect(repository.updateEnvConfig).toHaveBeenCalledTimes(1);
    expect(repository.updateEnvConfig).toHaveBeenCalledWith(
      "builtin",
      expect.objectContaining({ claude: expect.any(Object) })
    );
  });

  it("detectEnv for managed native runtime uses local detection (no tunnel)", async () => {
    const result = await service.detectEnv("builtin");
    expect(result.envConfig).not.toBeNull();
    expect(repository.updateEnvConfig).toHaveBeenCalledWith(
      "builtin",
      expect.objectContaining({ claude: expect.any(Object) })
    );
    // 不应该走隧道
    expect(tunnelHandler.sendRequest).not.toHaveBeenCalled();
  });

  it("detectEnv for registered runtime uses tunnel when connected", async () => {
    tunnelHandler.isConnected.mockReturnValue(true);
    const mockEnvConfig = {
      claude: {
        executablePath: "/bin/claude",
        version: "2.0",
        authAvailable: true,
      },
      codex: { executablePath: null, version: null, authAvailable: false },
      detectedAt: "2026-07-06T01:00:00.000Z",
    };
    tunnelHandler.sendRequest.mockResolvedValue({ envConfig: mockEnvConfig });

    const result = await service.detectEnv("rt-1");
    expect(result.envConfig).toEqual(mockEnvConfig);
    expect(repository.updateEnvConfig).toHaveBeenCalledWith(
      "rt-1",
      mockEnvConfig
    );
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

  it("list exposes the registered Host capability matrix", async () => {
    repository.listVisibleToOwner.mockResolvedValueOnce([
      makeRow({
        capabilities: {
          docker: { available: true, scopes: ["user", "workspace"] },
        },
      }),
    ]);

    const { list } = await service.list("u-1");

    expect(list[0]).toMatchObject({
      capabilities: {
        docker: { available: true, scopes: ["user", "workspace"] },
      },
    });
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

  it("listDirectory for managed runtime delegates to LocalRuntime and maps entries to list", async () => {
    const result = await service.listDirectory(
      "u-1",
      "builtin",
      "/home/agework"
    );
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
    (
      localRuntime.listDirectory as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("目录不存在或不可访问"));
    await expect(
      service.listDirectory("u-1", "builtin", "/no/such/dir")
    ).rejects.toThrow("目录不存在或不可访问");
  });

  it("createDirectory for managed runtime delegates to LocalRuntime", async () => {
    const result = await service.createDirectory(
      "u-1",
      "builtin",
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

  // ── 文件预览(managed native 直读, registered/docker 隧道 RPC) ─────

  it("listFiles for managed native delegates to LocalRuntime", async () => {
    const result = await service.listFiles("builtin", "/tmp/ws", "src");
    expect(localRuntime.listFiles).toHaveBeenCalledWith("/tmp/ws", "src");
    expect(result).toEqual({
      path: "src",
      list: [{ name: "a.ts", type: "file", size: 10 }],
      truncated: false,
    });
  });

  it("listFiles for registered runtime delegates to RemoteRuntime over the tunnel", async () => {
    tunnelHandler.sendRequest.mockResolvedValue({
      path: "src",
      list: [{ name: "b.ts", type: "file", size: 20 }],
      truncated: false,
    });
    const result = await service.listFiles("rt-1", "/remote/ws", "src");
    expect(tunnelHandler.sendRequest).toHaveBeenCalledWith(
      "rt-1",
      expect.objectContaining({ method: "runtime.list-files" }),
      expect.any(Number)
    );
    expect(result).toEqual({
      path: "src",
      list: [{ name: "b.ts", type: "file", size: 20 }],
      truncated: false,
    });
  });

  it("listFiles wraps underlying errors as BadRequestException", async () => {
    (localRuntime.listFiles as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("路径越界")
    );
    await expect(service.listFiles("builtin", "/tmp/ws", "..")).rejects.toThrow(
      "路径越界"
    );
  });

  it("readFile for managed native delegates to LocalRuntime", async () => {
    const result = await service.readFile("builtin", "/tmp/ws", "a.ts");
    expect(localRuntime.readFile).toHaveBeenCalledWith("/tmp/ws", "a.ts");
    expect(result).toEqual({
      path: "a.ts",
      encoding: "utf8",
      content: "hello",
      size: 5,
      truncated: false,
    });
  });

  it("readFile for registered runtime delegates to RemoteRuntime over the tunnel", async () => {
    tunnelHandler.sendRequest.mockResolvedValue({
      path: "a.ts",
      encoding: "utf8",
      content: "remote",
      size: 6,
      truncated: false,
    });
    const result = await service.readFile("rt-1", "/remote/ws", "a.ts");
    expect(tunnelHandler.sendRequest).toHaveBeenCalledWith(
      "rt-1",
      expect.objectContaining({ method: "runtime.read-file" }),
      expect.any(Number)
    );
    expect(result).toEqual({
      path: "a.ts",
      encoding: "utf8",
      content: "remote",
      size: 6,
      truncated: false,
    });
  });

  it("readFile wraps underlying errors as BadRequestException", async () => {
    (localRuntime.readFile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("二进制文件不支持预览")
    );
    await expect(
      service.readFile("builtin", "/tmp/ws", "bin.dat")
    ).rejects.toThrow("二进制文件不支持预览");
  });

  // ── 变更查看(git diff) ────────────────────────────────────────

  it("listChangedFiles for managed native delegates to LocalRuntime", async () => {
    const result = await service.listChangedFiles("builtin", "/tmp/ws");
    expect(localRuntime.listChangedFiles).toHaveBeenCalledWith("/tmp/ws");
    expect(result).toEqual({
      list: [{ path: "a.ts", status: "modified", additions: 1, deletions: 0 }],
      truncated: false,
    });
  });

  it("listChangedFiles for registered runtime delegates to RemoteRuntime over the tunnel", async () => {
    tunnelHandler.sendRequest.mockResolvedValue({
      list: [
        { path: "b.ts", status: "added", additions: null, deletions: null },
      ],
      truncated: false,
    });
    const result = await service.listChangedFiles("rt-1", "/remote/ws");
    expect(tunnelHandler.sendRequest).toHaveBeenCalledWith(
      "rt-1",
      expect.objectContaining({ method: "runtime.list-changed-files" }),
      expect.any(Number)
    );
    expect(result.list[0].path).toBe("b.ts");
  });

  it("readFileDiff for managed native delegates to LocalRuntime", async () => {
    const result = await service.readFileDiff("builtin", "/tmp/ws", "a.ts");
    expect(localRuntime.readFileDiff).toHaveBeenCalledWith("/tmp/ws", "a.ts");
    expect(result).toEqual({
      path: "a.ts",
      status: "modified",
      before: "old",
      after: "new",
    });
  });

  it("readFileDiff for registered runtime delegates to RemoteRuntime over the tunnel", async () => {
    tunnelHandler.sendRequest.mockResolvedValue({
      path: "a.ts",
      status: "modified",
      before: "remote-old",
      after: "remote-new",
    });
    const result = await service.readFileDiff("rt-1", "/remote/ws", "a.ts");
    expect(tunnelHandler.sendRequest).toHaveBeenCalledWith(
      "rt-1",
      expect.objectContaining({ method: "runtime.read-file-diff" }),
      expect.any(Number)
    );
    expect(result.after).toBe("remote-new");
  });
});
