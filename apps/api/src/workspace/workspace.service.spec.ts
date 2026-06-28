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
import type { WorkspaceCreateInput } from "./workspace.repository";
import { WorkspaceDirectoryHandler } from "./directory/workspace-directory.handler";
import { WorkspaceRuntimePolicy } from "./runtime/workspace-runtime.policy";
import {
  WORKSPACE_DELETED_EVENT,
  WorkspaceDeletedEvent,
} from "./workspace.events";
import { mkdirSync, rmSync } from "fs";

beforeEach(() => {
  vi.clearAllMocks();
});

// Repository 返回的行由入参回推，保证 toWorkspaceDto 的 rootPath / source 映射可被断言。
function workspaceRowFromCreate(input: WorkspaceCreateInput) {
  return {
    id: input.id,
    name: input.name,
    gitUrl: input.gitUrl ?? null,
    description: input.description,
    userId: input.userId,
    runtimeType: input.runtimeType,
    isolationScope: input.isolationScope,
    sandboxEngine: input.sandboxEngine,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    directory: {
      id: "directory-1",
      workspaceId: input.id,
      rootPath: input.rootPath,
      status: "ready",
      source: input.directorySource,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  };
}

function makeRepo(overrides: Record<string, unknown> = {}) {
  return {
    listAllWithMeta: vi.fn().mockResolvedValue({ list: [], total: 0 }),
    listByOwner: vi.fn().mockResolvedValue([]),
    createWithDirectory: vi.fn((input: WorkspaceCreateInput) =>
      Promise.resolve(workspaceRowFromCreate(input))
    ),
    updateOwned: vi.fn().mockResolvedValue(null),
    updateById: vi.fn().mockResolvedValue(null),
    findOwnedId: vi.fn().mockResolvedValue(null),
    softDeleteCascade: vi.fn().mockResolvedValue(undefined),
    findDirectoryByRootPath: vi.fn().mockResolvedValue(null),
    findUsername: vi.fn().mockResolvedValue("admin-1"),
    ...overrides,
  };
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    getWorkspace: () => "/tmp/agework/workspaces",
    getUserWorkspace: (username: string) => `/tmp/workspace/${username}`,
    getAllowedRuntimeTypes: () => ["local"],
    getDefaultRuntimeType: () => "local",
    isRuntimeTypeAllowed: (runtimeType: string) => runtimeType === "local",
    getAllowedIsolationScopes: () => ["user"],
    getDefaultIsolationScope: () => "user",
    isIsolationScopeAllowed: (scope: string) => scope === "user",
    getSandboxEngine: () => "docker",
    ...overrides,
  };
}

function makeRunService(overrides: Record<string, unknown> = {}) {
  return {
    hasActiveRunForWorkspace: vi.fn().mockResolvedValue(false),
    ...overrides,
  };
}

function makeService(
  repo: ReturnType<typeof makeRepo>,
  config: ReturnType<typeof makeConfig>,
  runService: ReturnType<typeof makeRunService> = makeRunService()
) {
  const runtimePolicy = new WorkspaceRuntimePolicy(config as never);
  const directoryHandler = new WorkspaceDirectoryHandler(
    repo as never,
    config as never,
    runtimePolicy
  );
  return new WorkspaceService(
    repo as never,
    { emit: vi.fn() } as never,
    runService as never,
    runtimePolicy,
    directoryHandler
  );
}

describe("WorkspaceService", () => {
  it("creates a managed directory and maps directory.rootPath back to rootPath", async () => {
    const expectedRootPath = join(
      "/tmp/workspace",
      "admin-1",
      "ws260614113047"
    );
    const repo = makeRepo();
    const service = makeService(repo, makeConfig());

    const workspace = await service.create({
      userId: "admin-1",
      name: "Local workspace",
    });

    expect(repo.createWithDirectory).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "ws260614113047",
        userId: "admin-1",
        runtimeType: "local",
        isolationScope: null,
        sandboxEngine: null,
        rootPath: expectedRootPath,
        directorySource: "managed",
      })
    );
    expect(mkdirSync).toHaveBeenCalled();
    expect(workspace.rootPath).toBe(expectedRootPath);
    expect(workspace.directorySource).toBe("managed");
    expect((workspace as Record<string, unknown>).directory).toBeUndefined();
  });

  it("binds an existing local directory without creating or deleting it", async () => {
    const selectedRootPath = "/tmp/existing-project";
    const repo = makeRepo();
    const service = makeService(repo, makeConfig());

    const workspace = await service.create({
      userId: "admin-1",
      name: "Local workspace",
      rootPath: selectedRootPath,
    });

    expect(mkdirSync).not.toHaveBeenCalled();
    expect(rmSync).not.toHaveBeenCalled();
    expect(repo.createWithDirectory).toHaveBeenCalledWith(
      expect.objectContaining({
        rootPath: resolve(selectedRootPath),
        directorySource: "external",
      })
    );
    expect(workspace.rootPath).toBe(resolve(selectedRootPath));
    expect(workspace.directorySource).toBe("external");
  });

  it("auto-selects workspace isolation for sandbox custom directories when allowed", async () => {
    const repo = makeRepo();
    const config = makeConfig({
      getAllowedRuntimeTypes: () => ["local", "sandbox"],
      isRuntimeTypeAllowed: (runtimeType: string) =>
        runtimeType === "local" || runtimeType === "sandbox",
      getAllowedIsolationScopes: () => ["user", "workspace"],
      isIsolationScopeAllowed: (scope: string) =>
        scope === "user" || scope === "workspace",
    });
    const service = makeService(repo, config);

    await service.create({
      userId: "admin-1",
      name: "Sandbox workspace",
      rootPath: "/tmp/other-project",
      runtimeType: "sandbox",
    });

    expect(repo.createWithDirectory).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeType: "sandbox",
        isolationScope: "workspace",
        sandboxEngine: "docker",
      })
    );
  });

  it("places sandbox workspace-isolated directories outside the user root", async () => {
    const expectedRootPath = join(
      "/tmp/agework/workspaces",
      "admin-1_ws260614113047"
    );
    const repo = makeRepo();
    const config = makeConfig({
      getAllowedRuntimeTypes: () => ["local", "sandbox"],
      isRuntimeTypeAllowed: (runtimeType: string) =>
        runtimeType === "local" || runtimeType === "sandbox",
      getAllowedIsolationScopes: () => ["user", "workspace"],
      isIsolationScopeAllowed: (scope: string) =>
        scope === "user" || scope === "workspace",
    });
    const service = makeService(repo, config);

    const workspace = await service.create({
      userId: "admin-1",
      name: "Sandbox workspace",
      runtimeType: "sandbox",
      isolationScope: "workspace",
    });

    expect(repo.createWithDirectory).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeType: "sandbox",
        isolationScope: "workspace",
        sandboxEngine: "docker",
        rootPath: expectedRootPath,
        directorySource: "managed",
      })
    );
    expect(workspace.rootPath).toBe(expectedRootPath);
    expect(workspace.directorySource).toBe("managed");
  });

  it("rejects workspace-isolated custom directories inside the user root", async () => {
    const config = makeConfig({
      getAllowedRuntimeTypes: () => ["local", "sandbox"],
      isRuntimeTypeAllowed: (runtimeType: string) =>
        runtimeType === "local" || runtimeType === "sandbox",
      getAllowedIsolationScopes: () => ["user", "workspace"],
      isIsolationScopeAllowed: (scope: string) =>
        scope === "user" || scope === "workspace",
    });
    const service = makeService(makeRepo(), config);

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
    const config = makeConfig({
      getAllowedRuntimeTypes: () => ["local", "sandbox"],
      isRuntimeTypeAllowed: (runtimeType: string) =>
        runtimeType === "local" || runtimeType === "sandbox",
      getAllowedIsolationScopes: () => ["user", "workspace"],
      isIsolationScopeAllowed: (scope: string) =>
        scope === "user" || scope === "workspace",
    });
    const service = makeService(makeRepo(), config);

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
    const config = makeConfig({
      getAllowedRuntimeTypes: () => ["local", "sandbox"],
      isRuntimeTypeAllowed: (runtimeType: string) =>
        runtimeType === "local" || runtimeType === "sandbox",
    });
    const service = makeService(makeRepo(), config);

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
    const config = makeConfig({
      getAllowedRuntimeTypes: () => ["local", "sandbox"],
      isRuntimeTypeAllowed: (runtimeType: string) =>
        runtimeType === "local" || runtimeType === "sandbox",
    });
    const service = makeService(makeRepo(), config);

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
    const service = makeService(makeRepo(), makeConfig());

    await expect(
      service.create({
        userId: "admin-1",
        name: "Sandbox workspace",
        runtimeType: "sandbox",
      })
    ).rejects.toThrow("当前部署不支持该工作空间运行环境");
  });

  it("returns the stored sandbox isolation scope even when current deployment disallows it", async () => {
    const repo = makeRepo({
      listByOwner: vi.fn().mockResolvedValue([
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
    });
    const config = makeConfig({
      getAllowedRuntimeTypes: () => ["sandbox"],
      getDefaultRuntimeType: () => "sandbox",
    });
    const service = makeService(repo, config);

    const result = await service.list("admin-1");

    expect(result.list[0]?.isolationScope).toBe("workspace");
    expect(result.list[0]?.directorySource).toBe("managed");
  });

  describe("delete", () => {
    const workspaceId = "ws-123";
    const userId = "user-1";

    it("emits WorkspaceDeletedEvent so downstream can clean up runtime resources", async () => {
      const emit = vi.fn();
      const repo = makeRepo({
        findOwnedId: vi.fn().mockResolvedValue({ id: workspaceId }),
      });
      const config = makeConfig();
      const runtimePolicy = new WorkspaceRuntimePolicy(config as never);
      const service = new WorkspaceService(
        repo as never,
        { emit } as never,
        makeRunService() as never,
        runtimePolicy,
        new WorkspaceDirectoryHandler(
          repo as never,
          config as never,
          runtimePolicy
        )
      );

      await service.delete(userId, workspaceId);

      expect(repo.softDeleteCascade).toHaveBeenCalledWith(workspaceId);
      expect(emit).toHaveBeenCalledWith(
        WORKSPACE_DELETED_EVENT,
        new WorkspaceDeletedEvent(workspaceId)
      );
    });

    it("refuses to delete when runs module reports an active run", async () => {
      const repo = makeRepo({
        findOwnedId: vi.fn().mockResolvedValue({ id: workspaceId }),
      });
      const runService = makeRunService({
        hasActiveRunForWorkspace: vi.fn().mockResolvedValue(true),
      });
      const service = makeService(repo, makeConfig(), runService);

      await expect(service.delete(userId, workspaceId)).rejects.toThrow(
        "工作空间有正在运行的任务，不能删除"
      );
      expect(runService.hasActiveRunForWorkspace).toHaveBeenCalledWith(
        workspaceId
      );
      expect(repo.softDeleteCascade).not.toHaveBeenCalled();
    });
  });

  // 资源归属：用户接口的 update/delete 必须按属主限定，别人的 id 一律 404。
  // 跨用户的管理操作走 updateAny/listAll，受 @Roles("admin") 保护，不在此路径。
  describe("ownership scoping", () => {
    it("delete 404s and never soft-deletes a workspace the caller does not own", async () => {
      const repo = makeRepo({
        findOwnedId: vi.fn().mockResolvedValue(null),
      });
      const service = makeService(repo, makeConfig());

      await expect(service.delete("intruder", "ws-x")).rejects.toThrow(
        "Workspace ws-x not found"
      );
      expect(repo.findOwnedId).toHaveBeenCalledWith("intruder", "ws-x");
      expect(repo.softDeleteCascade).not.toHaveBeenCalled();
    });

    it("update 404s and never mutates a workspace the caller does not own", async () => {
      const repo = makeRepo({
        updateOwned: vi.fn().mockResolvedValue(null),
      });
      const service = makeService(repo, makeConfig());

      await expect(
        service.update("intruder", "ws-x", "New name")
      ).rejects.toThrow("Workspace ws-x not found");
      expect(repo.updateOwned).toHaveBeenCalledWith(
        "intruder",
        "ws-x",
        expect.objectContaining({ name: "New name" })
      );
    });
  });
});
