vi.mock("../prisma/prisma.service", () => ({
  PrismaService: class PrismaService {},
}));

vi.mock("fs", () => ({
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(),
  realpathSync: vi.fn((path: string) => path),
  rmSync: vi.fn(),
  statSync: vi.fn(() => ({ isDirectory: () => true })),
}));

vi.mock("@agework/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@agework/shared")>()),
  generateId: () => "ws260614113047",
}));

import { join, resolve } from "path";
import { WorkspaceService } from "./workspace.service";
import {
  WORKSPACE_DELETED_EVENT,
  WorkspaceDeletedEvent,
} from "./workspace.events";
import { mkdirSync, rmSync } from "fs";

beforeEach(() => {
  vi.clearAllMocks();
});

function makeMocks() {
  const emit = vi.fn();
  const events = { emit } as never;

  const config = {
    getUserWorkspace: (username: string) => `/tmp/workspace/${username}`,
    getAllowedRuntimeTypes: () => ["local"],
    getDefaultRuntimeType: () => "local",
    isRuntimeTypeAllowed: (runtimeType: string) => runtimeType === "local",
    getAllowedIsolationScopes: () => ["user"],
    getDefaultIsolationScope: () => "user",
    isIsolationScopeAllowed: (scope: string) => scope === "user",
    getSandboxEngine: () => "docker",
  } as never;

  return { emit, events, config };
}

describe("WorkspaceService", () => {
  it("creates a directory for the workspace and maps directory.rootPath back to rootPath", async () => {
    const expectedRootPath = join(
      "/tmp/workspace",
      "admin-1",
      "ws260614113047"
    );

    const workspaceCreate = vi.fn((args: { data: Record<string, unknown> }) =>
      Promise.resolve({
        ...args.data,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
    );
    const directoryCreate = vi.fn((args: { data: Record<string, unknown> }) =>
      Promise.resolve({
        id: "directory-1",
        ...args.data,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
    );
    const transaction = vi.fn(async (cb) =>
      cb({
        workspace: { create: workspaceCreate },
        workspaceDirectory: { create: directoryCreate },
      })
    );
    const service = new WorkspaceService(
      {
        $transaction: transaction,
        user: {
          findUnique: vi.fn().mockResolvedValue({ username: "admin-1" }),
        },
      } as never,
      {
        getUserWorkspace: (username: string) => `/tmp/workspace/${username}`,
        getAllowedRuntimeTypes: () => ["local"],
        getDefaultRuntimeType: () => "local",
        isRuntimeTypeAllowed: (runtimeType: string) => runtimeType === "local",
        getAllowedIsolationScopes: () => ["user"],
        getDefaultIsolationScope: () => "user",
        isIsolationScopeAllowed: (scope: string) => scope === "user",
        getSandboxEngine: () => "docker",
      } as never,
      { emit: vi.fn() } as never
    );

    const workspace = await service.create({
      userId: "admin-1",
      name: "Local workspace",
    });

    expect(workspaceCreate.mock.calls[0]?.[0].data).toMatchObject({
      id: "ws260614113047",
      userId: "admin-1",
      runtimeType: "local",
      isolationScope: null,
      sandboxEngine: null,
    });
    expect(directoryCreate).toHaveBeenCalledWith({
      data: {
        id: expect.any(String),
        workspaceId: "ws260614113047",
        rootPath: expectedRootPath,
        status: "ready",
        source: "managed",
        metadata: {},
      },
    });
    expect(workspace.rootPath).toBe(expectedRootPath);
    expect(workspace.directorySource).toBe("managed");
    expect((workspace as Record<string, unknown>).directory).toBeUndefined();
  });

  it("binds an existing local directory without creating or deleting it", async () => {
    const selectedRootPath = "/tmp/existing-project";

    const workspaceCreate = vi.fn((args: { data: Record<string, unknown> }) =>
      Promise.resolve({
        ...args.data,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
    );
    const directoryCreate = vi.fn((args: { data: Record<string, unknown> }) =>
      Promise.resolve({
        id: "directory-1",
        ...args.data,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
    );
    const transaction = vi.fn(async (cb) =>
      cb({
        workspace: { create: workspaceCreate },
        workspaceDirectory: { create: directoryCreate },
      })
    );
    const service = new WorkspaceService(
      {
        $transaction: transaction,
        user: {
          findUnique: vi.fn().mockResolvedValue({ username: "admin-1" }),
        },
        workspaceDirectory: { findFirst: vi.fn().mockResolvedValue(null) },
      } as never,
      {
        getUserWorkspace: (username: string) => `/tmp/workspace/${username}`,
        getSandboxEngine: () => "docker",
        getAllowedRuntimeTypes: () => ["local"],
        getDefaultRuntimeType: () => "local",
        isRuntimeTypeAllowed: (runtimeType: string) => runtimeType === "local",
        getAllowedIsolationScopes: () => ["user"],
        getDefaultIsolationScope: () => "user",
        isIsolationScopeAllowed: (scope: string) => scope === "user",
      } as never,
      { emit: vi.fn() } as never
    );

    const workspace = await service.create({
      userId: "admin-1",
      name: "Local workspace",
      rootPath: selectedRootPath,
    });

    expect(mkdirSync).not.toHaveBeenCalled();
    expect(rmSync).not.toHaveBeenCalled();
    expect(directoryCreate).toHaveBeenCalledWith({
      data: {
        id: expect.any(String),
        workspaceId: "ws260614113047",
        rootPath: resolve(selectedRootPath),
        status: "ready",
        source: "external",
        metadata: {},
      },
    });
    expect(workspace.rootPath).toBe(resolve(selectedRootPath));
    expect(workspace.directorySource).toBe("external");
  });

  it("auto-selects workspace isolation for sandbox custom directories when allowed", async () => {
    const selectedRootPath = "/tmp/other-project";
    const workspaceCreate = vi.fn((args: { data: Record<string, unknown> }) =>
      Promise.resolve({
        ...args.data,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
    );
    const directoryCreate = vi.fn((args: { data: Record<string, unknown> }) =>
      Promise.resolve({
        id: "directory-1",
        ...args.data,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
    );
    const transaction = vi.fn(async (cb) =>
      cb({
        workspace: { create: workspaceCreate },
        workspaceDirectory: { create: directoryCreate },
      })
    );
    const service = new WorkspaceService(
      {
        $transaction: transaction,
        user: {
          findUnique: vi.fn().mockResolvedValue({ username: "admin-1" }),
        },
        workspaceDirectory: { findFirst: vi.fn().mockResolvedValue(null) },
      } as never,
      {
        getUserWorkspace: (username: string) => `/tmp/workspace/${username}`,
        getAllowedRuntimeTypes: () => ["local", "sandbox"],
        getDefaultRuntimeType: () => "local",
        isRuntimeTypeAllowed: (runtimeType: string) =>
          runtimeType === "local" || runtimeType === "sandbox",
        getAllowedIsolationScopes: () => ["user", "workspace"],
        getDefaultIsolationScope: () => "user",
        isIsolationScopeAllowed: (scope: string) =>
          scope === "user" || scope === "workspace",
        getSandboxEngine: () => "docker",
      } as never,
      { emit: vi.fn() } as never
    );

    await service.create({
      userId: "admin-1",
      name: "Sandbox workspace",
      rootPath: selectedRootPath,
      runtimeType: "sandbox",
    });

    expect(workspaceCreate.mock.calls[0]?.[0].data).toMatchObject({
      runtimeType: "sandbox",
      isolationScope: "workspace",
      sandboxEngine: "docker",
    });
  });

  it("places sandbox workspace-isolated directories outside the user root", async () => {
    const expectedRootPath = join(
      "/tmp/agework/workspaces",
      "admin-1_ws260614113047"
    );
    const workspaceCreate = vi.fn((args: { data: Record<string, unknown> }) =>
      Promise.resolve({
        ...args.data,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
    );
    const directoryCreate = vi.fn((args: { data: Record<string, unknown> }) =>
      Promise.resolve({
        id: "directory-1",
        ...args.data,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
    );
    const transaction = vi.fn(async (cb) =>
      cb({
        workspace: { create: workspaceCreate },
        workspaceDirectory: { create: directoryCreate },
      })
    );
    const service = new WorkspaceService(
      {
        $transaction: transaction,
        user: {
          findUnique: vi.fn().mockResolvedValue({ username: "admin-1" }),
        },
      } as never,
      {
        getWorkspace: () => "/tmp/agework/workspaces",
        getUserWorkspace: (username: string) => `/tmp/workspace/${username}`,
        getAllowedRuntimeTypes: () => ["local", "sandbox"],
        getDefaultRuntimeType: () => "local",
        isRuntimeTypeAllowed: (runtimeType: string) =>
          runtimeType === "local" || runtimeType === "sandbox",
        getAllowedIsolationScopes: () => ["user", "workspace"],
        getDefaultIsolationScope: () => "user",
        isIsolationScopeAllowed: (scope: string) =>
          scope === "user" || scope === "workspace",
        getSandboxEngine: () => "docker",
      } as never,
      { emit: vi.fn() } as never
    );

    const workspace = await service.create({
      userId: "admin-1",
      name: "Sandbox workspace",
      runtimeType: "sandbox",
      isolationScope: "workspace",
    });

    expect(workspaceCreate.mock.calls[0]?.[0].data).toMatchObject({
      runtimeType: "sandbox",
      isolationScope: "workspace",
      sandboxEngine: "docker",
    });
    expect(directoryCreate).toHaveBeenCalledWith({
      data: {
        id: expect.any(String),
        workspaceId: "ws260614113047",
        rootPath: expectedRootPath,
        status: "ready",
        source: "managed",
        metadata: {},
      },
    });
    expect(workspace.rootPath).toBe(expectedRootPath);
    expect(workspace.directorySource).toBe("managed");
  });

  it("rejects workspace-isolated custom directories inside the user root", async () => {
    const service = new WorkspaceService(
      {
        user: {
          findUnique: vi.fn().mockResolvedValue({ username: "admin-1" }),
        },
        workspaceDirectory: { findFirst: vi.fn() },
      } as never,
      {
        getWorkspace: () => "/tmp/agework/workspaces",
        getUserWorkspace: (username: string) => `/tmp/workspace/${username}`,
        getAllowedRuntimeTypes: () => ["local", "sandbox"],
        getDefaultRuntimeType: () => "local",
        isRuntimeTypeAllowed: (runtimeType: string) =>
          runtimeType === "local" || runtimeType === "sandbox",
        getAllowedIsolationScopes: () => ["user", "workspace"],
        getDefaultIsolationScope: () => "user",
        isIsolationScopeAllowed: (scope: string) =>
          scope === "user" || scope === "workspace",
        getSandboxEngine: () => "docker",
      } as never,
      { emit: vi.fn() } as never
    );

    await expect(
      service.create({
        userId: "admin-1",
        name: "Sandbox workspace",
        rootPath: "/tmp/workspace/admin-1/my-project",
        runtimeType: "sandbox",
        isolationScope: "workspace",
      })
    ).rejects.toThrow("工作空间隔离的自定义目录不能在用户工作空间目录内");
  });

  it("rejects sandbox custom directories when user isolation is explicitly selected", async () => {
    const service = new WorkspaceService(
      {
        user: {
          findUnique: vi.fn().mockResolvedValue({ username: "admin-1" }),
        },
        workspaceDirectory: { findFirst: vi.fn() },
      } as never,
      {
        getUserWorkspace: (username: string) => `/tmp/workspace/${username}`,
        getAllowedRuntimeTypes: () => ["local", "sandbox"],
        getDefaultRuntimeType: () => "local",
        isRuntimeTypeAllowed: (runtimeType: string) =>
          runtimeType === "local" || runtimeType === "sandbox",
        getAllowedIsolationScopes: () => ["user", "workspace"],
        getDefaultIsolationScope: () => "user",
        isIsolationScopeAllowed: (scope: string) =>
          scope === "user" || scope === "workspace",
        getSandboxEngine: () => "docker",
      } as never,
      { emit: vi.fn() } as never
    );

    await expect(
      service.create({
        userId: "admin-1",
        name: "Local workspace",
        rootPath: "/tmp/other-project",
        runtimeType: "sandbox",
        isolationScope: "user",
      })
    ).rejects.toThrow("沙箱工作空间指定本地目录时必须使用工作空间级隔离");
  });

  it("rejects sandbox custom directories when workspace isolation is not allowed", async () => {
    const service = new WorkspaceService(
      {
        user: {
          findUnique: vi.fn().mockResolvedValue({ username: "admin-1" }),
        },
        workspaceDirectory: { findFirst: vi.fn() },
      } as never,
      {
        getUserWorkspace: (username: string) => `/tmp/workspace/${username}`,
        getAllowedRuntimeTypes: () => ["local", "sandbox"],
        getDefaultRuntimeType: () => "local",
        isRuntimeTypeAllowed: (runtimeType: string) =>
          runtimeType === "local" || runtimeType === "sandbox",
        getAllowedIsolationScopes: () => ["user"],
        getDefaultIsolationScope: () => "user",
        isIsolationScopeAllowed: (scope: string) => scope === "user",
        getSandboxEngine: () => "docker",
      } as never,
      { emit: vi.fn() } as never
    );

    await expect(
      service.create({
        userId: "admin-1",
        name: "Sandbox workspace",
        rootPath: "/tmp/other-project",
        runtimeType: "sandbox",
      })
    ).rejects.toThrow("当前部署不支持沙箱工作空间使用自定义本地目录");
  });

  it("rejects sandbox isolation scopes outside deployment capabilities", async () => {
    const service = new WorkspaceService(
      {} as never,
      {
        getUserWorkspace: (username: string) => `/tmp/workspace/${username}`,
        getAllowedRuntimeTypes: () => ["local", "sandbox"],
        getDefaultRuntimeType: () => "local",
        isRuntimeTypeAllowed: (runtimeType: string) =>
          runtimeType === "local" || runtimeType === "sandbox",
        getAllowedIsolationScopes: () => ["user"],
        getDefaultIsolationScope: () => "user",
        isIsolationScopeAllowed: (scope: string) => scope === "user",
        getSandboxEngine: () => "docker",
      } as never,
      { emit: vi.fn() } as never
    );

    await expect(
      service.create({
        userId: "admin-1",
        name: "Sandbox workspace",
        runtimeType: "sandbox",
        isolationScope: "workspace",
      })
    ).rejects.toThrow("当前部署不支持该沙箱隔离级别: workspace");
  });

  it("rejects runtime types outside deployment capabilities", async () => {
    const service = new WorkspaceService(
      {} as never,
      {
        getUserWorkspace: (username: string) => `/tmp/workspace/${username}`,
        getAllowedRuntimeTypes: () => ["local"],
        getDefaultRuntimeType: () => "local",
        isRuntimeTypeAllowed: (runtimeType: string) => runtimeType === "local",
        getAllowedIsolationScopes: () => ["user"],
        getDefaultIsolationScope: () => "user",
        isIsolationScopeAllowed: (scope: string) => scope === "user",
        getSandboxEngine: () => "docker",
      } as never,
      { emit: vi.fn() } as never
    );

    await expect(
      service.create({
        userId: "admin-1",
        name: "Sandbox workspace",
        runtimeType: "sandbox",
      })
    ).rejects.toThrow("当前部署不支持该工作空间运行环境");
  });

  it("returns the stored sandbox isolation scope even when current deployment disallows it", async () => {
    const service = new WorkspaceService(
      {
        workspace: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "ws-1",
              name: "Sandbox workspace",
              gitUrl: null,
              description: null,
              runtimeType: "sandbox",
              isolationScope: "workspace",
              sandboxEngine: "docker",
              userId: "admin-1",
              createdAt: new Date(),
              updatedAt: new Date(),
              deletedAt: null,
              directory: {
                rootPath: "/tmp/workspace/admin-1/ws-1",
                status: "ready",
                source: "managed",
              },
            },
          ]),
        },
      } as never,
      {
        getAllowedRuntimeTypes: () => ["sandbox"],
        getDefaultRuntimeType: () => "sandbox",
        getAllowedIsolationScopes: () => ["user"],
        getDefaultIsolationScope: () => "user",
        isIsolationScopeAllowed: (scope: string) => scope === "user",
        getSandboxEngine: () => "docker",
      } as never,
      { emit: vi.fn() } as never
    );

    const result = await service.list("admin-1");

    expect(result.list[0]?.isolationScope).toBe("workspace");
    expect(result.list[0]?.directorySource).toBe("managed");
  });

  describe("delete", () => {
    const workspaceId = "ws-123";
    const userId = "user-1";

    function makeDeleteMocks() {
      const mocks = makeMocks();

      const prismaMock = {
        workspace: {
          findFirst: vi.fn().mockResolvedValue({ id: workspaceId }),
          update: vi
            .fn()
            .mockResolvedValue({ id: workspaceId, deletedAt: new Date() }),
        },
        run: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
        conversation: {
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        $transaction: vi.fn().mockResolvedValue(undefined),
      } as never;

      const service = new WorkspaceService(
        prismaMock,
        mocks.config,
        mocks.events
      );

      return { ...mocks, service, prismaMock };
    }

    it("emits WorkspaceDeletedEvent so downstream can clean up runtime resources", async () => {
      const { service, emit } = makeDeleteMocks();

      await service.delete(userId, workspaceId);

      expect(emit).toHaveBeenCalledWith(
        WORKSPACE_DELETED_EVENT,
        new WorkspaceDeletedEvent(workspaceId)
      );
    });
  });

  // 资源归属：用户接口的 update/delete 必须按 ownerWhere(userId) 限定，别人的 id 一律 404。
  // 跨用户的管理操作走 updateAny/listAll，受 @Roles("admin") 保护，不在此路径。
  describe("ownership scoping", () => {
    it("delete 404s and never soft-deletes a workspace the caller does not own", async () => {
      const findFirst = vi.fn().mockResolvedValue(null);
      const update = vi.fn();
      const service = new WorkspaceService(
        { workspace: { findFirst, update }, run: { findFirst: vi.fn() } } as never,
        {} as never,
        { emit: vi.fn() } as never
      );

      await expect(service.delete("intruder", "ws-x")).rejects.toThrow(
        "Workspace ws-x not found"
      );
      expect(findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "ws-x",
            userId: "intruder",
            deletedAt: null,
          }),
        })
      );
      expect(update).not.toHaveBeenCalled();
    });

    it("update 404s and never mutates a workspace the caller does not own", async () => {
      const txFindFirst = vi.fn().mockResolvedValue(null);
      const txUpdate = vi.fn();
      const service = new WorkspaceService(
        {
          $transaction: (fn: (tx: unknown) => unknown) =>
            fn({ workspace: { findFirst: txFindFirst, update: txUpdate } }),
        } as never,
        {} as never,
        { emit: vi.fn() } as never
      );

      await expect(
        service.update("intruder", "ws-x", "New name")
      ).rejects.toThrow("Workspace ws-x not found");
      expect(txFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "ws-x",
            userId: "intruder",
            deletedAt: null,
          }),
        })
      );
      expect(txUpdate).not.toHaveBeenCalled();
    });
  });
});
