import { describe, it, expect, vi, beforeEach } from "vitest";
import { RuntimeHostRepository } from "./runtime-host.repository";
import type {
  RuntimeHostConnectivity,
  RuntimeHostRow,
} from "./runtime-host.types";
import { RuntimeHostService } from "./runtime-host.service";
import type {
  RuntimeHostEnvironment,
  RuntimeHostWorkspaceData,
} from "@agework/shared/protocol";

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

// RuntimeHost 的 worker 生命周期由 apps/runtime 测试；这里测注册表、策略与 Host 路由。
describe("RuntimeHostService", () => {
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
  let connectivity: {
    isConnected: ReturnType<typeof vi.fn>;
  };
  let environment: Record<
    keyof RuntimeHostEnvironment,
    ReturnType<typeof vi.fn>
  >;
  let workspaceData: Record<
    keyof RuntimeHostWorkspaceData,
    ReturnType<typeof vi.fn>
  >;
  let service: RuntimeHostService;

  beforeEach(() => {
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
    connectivity = {
      isConnected: vi.fn().mockImplementation((runtimeHostId: string) => {
        return runtimeHostId === "builtin";
      }),
    };
    environment = {
      detectEnv: vi.fn().mockResolvedValue({
        native: {
          available: true,
          scopes: ["workspace"],
          cli: mockEnvConfig,
        },
        docker: { available: true, scopes: ["user", "workspace"] },
        opensandbox: { available: true, scopes: ["user", "workspace"] },
      }),
      installCli: vi.fn().mockResolvedValue({ executablePath: "/cli/claude" }),
    };
    workspaceData = {
      listDirectory: vi.fn().mockResolvedValue({
        path: "/home/agework",
        entries: ["/home/agework/foo"],
      }),
      createDirectory: vi.fn().mockResolvedValue(undefined),
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
      readFileDiff: vi.fn().mockResolvedValue({
        path: "a.ts",
        status: "modified",
        before: "old",
        after: "new",
      }),
      searchFiles: vi.fn().mockResolvedValue({ list: [], truncated: false }),
      listChangedFiles: vi.fn().mockResolvedValue({
        list: [
          { path: "a.ts", status: "modified", additions: 1, deletions: 0 },
        ],
        truncated: false,
      }),
    };
    service = new RuntimeHostService(
      repository as unknown as RuntimeHostRepository,
      connectivity as unknown as RuntimeHostConnectivity,
      environment as unknown as RuntimeHostEnvironment,
      workspaceData as unknown as RuntimeHostWorkspaceData
    );
  });

  it("isBuiltinHost distinguishes builtin from registered ids", () => {
    expect(service.isBuiltinHost("builtin")).toBe(true);
    expect(service.isBuiltinHost("builtin")).toBe(true);
    expect(service.isBuiltinHost("rt-1")).toBe(false);
  });

  it("getBuiltinHostId returns the fixed builtin Host id", () => {
    expect(service.getBuiltinHostId()).toBe("builtin");
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

  it("onApplicationBootstrap persists the builtin Host capability report", async () => {
    await service.onApplicationBootstrap();
    expect(repository.upsertBuiltin).toHaveBeenCalledTimes(1);
    expect(repository.upsertBuiltin).toHaveBeenCalledWith({
      name: "builtin",
      capabilities: {
        native: {
          available: true,
          scopes: ["workspace"],
          cli: mockEnvConfig,
        },
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

  it("detectEnv for the builtin Host uses local detection (no tunnel)", async () => {
    const result = await service.detectEnv("builtin");
    expect(result.envConfig).not.toBeNull();
    expect(repository.updateEnvConfig).toHaveBeenCalledWith(
      "builtin",
      expect.objectContaining({ claude: expect.any(Object) })
    );
    expect(environment.detectEnv).toHaveBeenCalledWith("builtin");
  });

  it("detectEnv for a registered Runtime Host uses the tunnel when connected", async () => {
    connectivity.isConnected.mockReturnValue(true);
    const mockEnvConfig = {
      claude: {
        executablePath: "/bin/claude",
        version: "2.0",
        authAvailable: true,
      },
      codex: { executablePath: null, version: null, authAvailable: false },
      detectedAt: "2026-07-06T01:00:00.000Z",
    };
    environment.detectEnv.mockResolvedValue({
      native: {
        available: true,
        scopes: ["workspace"],
        cli: mockEnvConfig,
      },
    });

    const result = await service.detectEnv("rt-1");
    expect(result.envConfig).toEqual(mockEnvConfig);
    expect(repository.updateEnvConfig).toHaveBeenCalledWith(
      "rt-1",
      mockEnvConfig
    );
    expect(environment.detectEnv).toHaveBeenCalledWith("rt-1");
  });

  it("detectEnv for a disconnected registered Runtime Host returns null", async () => {
    connectivity.isConnected.mockReturnValue(false);
    const result = await service.detectEnv("rt-1");
    expect(result.envConfig).toBeNull();
    expect(environment.detectEnv).not.toHaveBeenCalled();
  });

  it("detectEnv rejects a missing Runtime Host before reaching the execution plane", async () => {
    repository.findById.mockResolvedValueOnce(null);

    await expect(service.detectEnv("missing")).rejects.toThrow(
      "runtime host not found: missing"
    );
    expect(environment.detectEnv).not.toHaveBeenCalled();
  });

  it("installCli delegates execution to RuntimeHostEnvironment and stores the override", async () => {
    repository.findById.mockResolvedValueOnce(
      makeRow({ id: "builtin", source: "builtin" })
    );

    await service.installCli("builtin", "claude");

    expect(environment.installCli).toHaveBeenCalledWith({
      runtimeHostId: "builtin",
      agentType: "claude",
    });
    expect(repository.updateEnvConfigOverride).toHaveBeenCalledWith("builtin", {
      claude: { executablePath: "/cli/claude" },
    });
    expect(environment.detectEnv).toHaveBeenCalledWith("builtin");
  });

  it("create stores only the sha256 of the pairing token and returns the plaintext once", async () => {
    const result = await service.create("u-1", "mac-studio");

    expect(result.token).toMatch(/^[0-9a-f]{64}$/);
    const stored = repository.create.mock.calls[0][0];
    expect(stored.name).toBe("mac-studio");
    expect(stored.ownerId).toBe("u-1");
    expect(stored.tokenHash).not.toBe(result.token);
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.runtimeHost).not.toHaveProperty("tokenHash");
  });

  it("create maps unique violation to ConflictException", async () => {
    repository.create.mockRejectedValueOnce({ code: "P2002" });
    await expect(service.create("u-1", "mac-studio")).rejects.toThrow(
      "runtime host name already exists"
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

  it("listForAdmin maps rows to response shape", async () => {
    const { list } = await service.listForAdmin();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("rt-1");
  });

  it("delete revokes the row without consulting Host connectivity", async () => {
    await service.delete("u-1", "rt-1");
    expect(repository.revokeByOwner).toHaveBeenCalledWith("u-1", "rt-1");
    expect(connectivity.isConnected).not.toHaveBeenCalled();
  });

  it("delete throws NotFound when the row is missing or owned by someone else", async () => {
    repository.revokeByOwner.mockResolvedValueOnce(false);
    await expect(service.delete("u-1", "rt-x")).rejects.toThrow(
      "runtime host not found"
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

  it("listDirectory delegates builtin Host access to RuntimeHostWorkspaceData", async () => {
    const result = await service.listDirectory(
      "u-1",
      "builtin",
      "/home/agework"
    );
    expect(workspaceData.listDirectory).toHaveBeenCalledWith({
      runtimeHostId: "builtin",
      path: "/home/agework",
    });
    expect(result).toEqual({
      path: "/home/agework",
      list: ["/home/agework/foo"],
    });
  });

  it("listDirectory throws NotFoundException when the Runtime Host is not visible to the user", async () => {
    repository.findVisibleToOwner.mockResolvedValueOnce(null);
    await expect(
      service.listDirectory("u-1", "rt-x", undefined)
    ).rejects.toThrow("runtime host not found");
  });

  it("listDirectory for a disconnected registered Runtime Host throws BadRequestException", async () => {
    connectivity.isConnected.mockReturnValue(false);
    await expect(
      service.listDirectory("u-1", "rt-1", undefined)
    ).rejects.toThrow("is not connected");
  });

  it("listDirectory wraps underlying filesystem errors as BadRequestException", async () => {
    workspaceData.listDirectory.mockRejectedValueOnce(
      new Error("目录不存在或不可访问")
    );
    await expect(
      service.listDirectory("u-1", "builtin", "/no/such/dir")
    ).rejects.toThrow("目录不存在或不可访问");
  });

  it("createDirectory delegates builtin Host access to RuntimeHostWorkspaceData", async () => {
    const result = await service.createDirectory(
      "u-1",
      "builtin",
      "/home/agework/new"
    );
    expect(workspaceData.createDirectory).toHaveBeenCalledWith({
      runtimeHostId: "builtin",
      path: "/home/agework/new",
    });
    expect(result).toEqual({ path: "/home/agework/new" });
  });

  it("createDirectory delegates registered Host access to RuntimeHostWorkspaceData", async () => {
    connectivity.isConnected.mockReturnValue(true);
    const result = await service.createDirectory("u-1", "rt-1", "/data/new");
    expect(workspaceData.createDirectory).toHaveBeenCalledWith({
      runtimeHostId: "rt-1",
      path: "/data/new",
    });
    expect(result).toEqual({ path: "/data/new" });
  });

  // ── 文件预览（统一经 RuntimeHostWorkspaceData） ─────

  it("listFiles for builtin Host uses RuntimeHostWorkspaceData", async () => {
    const result = await service.listFiles("builtin", "/tmp/ws", "src");
    expect(workspaceData.listFiles).toHaveBeenCalledWith({
      runtimeHostId: "builtin",
      rootPath: "/tmp/ws",
      path: "src",
    });
    expect(result).toEqual({
      path: "src",
      list: [{ name: "a.ts", type: "file", size: 10 }],
      truncated: false,
    });
  });

  it("listFiles for registered Host uses RuntimeHostWorkspaceData", async () => {
    workspaceData.listFiles.mockResolvedValue({
      path: "src",
      list: [{ name: "b.ts", type: "file", size: 20 }],
      truncated: false,
    });
    const result = await service.listFiles("rt-1", "/remote/ws", "src");
    expect(workspaceData.listFiles).toHaveBeenCalledWith({
      runtimeHostId: "rt-1",
      rootPath: "/remote/ws",
      path: "src",
    });
    expect(result).toEqual({
      path: "src",
      list: [{ name: "b.ts", type: "file", size: 20 }],
      truncated: false,
    });
  });

  it("listFiles wraps underlying errors as BadRequestException", async () => {
    workspaceData.listFiles.mockRejectedValueOnce(new Error("路径越界"));
    await expect(service.listFiles("builtin", "/tmp/ws", "..")).rejects.toThrow(
      "路径越界"
    );
  });

  it("readFile for builtin Host uses RuntimeHostWorkspaceData", async () => {
    const result = await service.readFile("builtin", "/tmp/ws", "a.ts");
    expect(workspaceData.readFile).toHaveBeenCalledWith({
      runtimeHostId: "builtin",
      rootPath: "/tmp/ws",
      path: "a.ts",
    });
    expect(result).toEqual({
      path: "a.ts",
      encoding: "utf8",
      content: "hello",
      size: 5,
      truncated: false,
    });
  });

  it("readFile for registered Host uses RuntimeHostWorkspaceData", async () => {
    workspaceData.readFile.mockResolvedValue({
      path: "a.ts",
      encoding: "utf8",
      content: "remote",
      size: 6,
      truncated: false,
    });
    const result = await service.readFile("rt-1", "/remote/ws", "a.ts");
    expect(workspaceData.readFile).toHaveBeenCalledWith({
      runtimeHostId: "rt-1",
      rootPath: "/remote/ws",
      path: "a.ts",
    });
    expect(result).toEqual({
      path: "a.ts",
      encoding: "utf8",
      content: "remote",
      size: 6,
      truncated: false,
    });
  });

  it("readFile wraps underlying errors as BadRequestException", async () => {
    workspaceData.readFile.mockRejectedValueOnce(
      new Error("二进制文件不支持预览")
    );
    await expect(
      service.readFile("builtin", "/tmp/ws", "bin.dat")
    ).rejects.toThrow("二进制文件不支持预览");
  });

  // ── 变更查看(git diff) ────────────────────────────────────────

  it("listChangedFiles for builtin Host uses RuntimeHostWorkspaceData", async () => {
    const result = await service.listChangedFiles("builtin", "/tmp/ws");
    expect(workspaceData.listChangedFiles).toHaveBeenCalledWith({
      runtimeHostId: "builtin",
      rootPath: "/tmp/ws",
    });
    expect(result).toEqual({
      list: [{ path: "a.ts", status: "modified", additions: 1, deletions: 0 }],
      truncated: false,
    });
  });

  it("listChangedFiles for registered Host uses RuntimeHostWorkspaceData", async () => {
    workspaceData.listChangedFiles.mockResolvedValue({
      list: [
        { path: "b.ts", status: "added", additions: null, deletions: null },
      ],
      truncated: false,
    });
    const result = await service.listChangedFiles("rt-1", "/remote/ws");
    expect(workspaceData.listChangedFiles).toHaveBeenCalledWith({
      runtimeHostId: "rt-1",
      rootPath: "/remote/ws",
    });
    expect(result.list[0].path).toBe("b.ts");
  });

  it("readFileDiff for builtin Host uses RuntimeHostWorkspaceData", async () => {
    const result = await service.readFileDiff("builtin", "/tmp/ws", "a.ts");
    expect(workspaceData.readFileDiff).toHaveBeenCalledWith({
      runtimeHostId: "builtin",
      rootPath: "/tmp/ws",
      path: "a.ts",
    });
    expect(result).toEqual({
      path: "a.ts",
      status: "modified",
      before: "old",
      after: "new",
    });
  });

  it("readFileDiff for registered Host uses RuntimeHostWorkspaceData", async () => {
    workspaceData.readFileDiff.mockResolvedValue({
      path: "a.ts",
      status: "modified",
      before: "remote-old",
      after: "remote-new",
    });
    const result = await service.readFileDiff("rt-1", "/remote/ws", "a.ts");
    expect(workspaceData.readFileDiff).toHaveBeenCalledWith({
      runtimeHostId: "rt-1",
      rootPath: "/remote/ws",
      path: "a.ts",
    });
    expect(result.after).toBe("remote-new");
  });
});
