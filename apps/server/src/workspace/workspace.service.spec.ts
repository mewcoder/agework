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
import type { ConversationService } from "../conversation/conversation.service";
import { WorkspaceDirectoryHandler } from "./directory/workspace-directory.handler";
import { WorkspaceRuntimePolicy } from "./placement/workspace-runtime.policy";
import {
  WORKSPACE_DELETED_EVENT,
  WorkspaceDeletedEvent,
} from "./workspace.events";
import { mkdirSync, rmSync } from "fs";

beforeEach(() => {
  vi.clearAllMocks();
});

// Repository 返回的行由入参回推，保证 toWorkspaceDto 的 rootPath / source 映射可被断言。
// runtimeType 不再是 WorkspaceCreateInput 的字段（由 runtimeId 关联的 Runtime 派生），
// 从 builtin runtimeId（"builtin-xxx"）反推，registered runtimeId 由调用方显式传入。
function workspaceRowFromCreate(
  input: WorkspaceCreateInput,
  runtimeType: string
) {
  return {
    id: input.id,
    name: input.name,
    gitUrl: input.gitUrl ?? null,
    description: input.description,
    userId: input.userId,
    runtime: { runtimeType },
    isolationScope: input.isolationScope,
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
      Promise.resolve(
        workspaceRowFromCreate(
          input,
          input.runtimeId.startsWith("builtin-")
            ? input.runtimeId.slice("builtin-".length)
            : "docker"
        )
      )
    ),
    updateOwned: vi.fn().mockResolvedValue(null),
    updateById: vi.fn().mockResolvedValue(null),
    getOwnedId: vi.fn().mockResolvedValue(null),
    findRunView: vi.fn().mockResolvedValue(null),
    softDelete: vi.fn().mockResolvedValue(undefined),
    findDirectoryByRootPath: vi.fn().mockResolvedValue(null),
    findUsername: vi.fn().mockResolvedValue("admin-1"),
    ...overrides,
  };
}

function makeConversationService(overrides: Record<string, unknown> = {}) {
  return {
    deleteByWorkspace: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as ConversationService;
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
    ...overrides,
  };
}

function makeRuntimeService(overrides: Record<string, unknown> = {}) {
  return {
    getOwned: vi.fn().mockResolvedValue(null),
    getBuiltinRuntimeId: vi.fn(
      (runtimeType: string) => `builtin-${runtimeType}`
    ),
    isManaged: vi.fn((runtimeId: string) => runtimeId.startsWith("builtin-")),
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
    ...overrides,
  };
}

function makeWorkerManager(overrides: Record<string, unknown> = {}) {
  return {
    ensureWorkerForFilePreview: vi.fn().mockResolvedValue("owner-1"),
    sendFileCommand: vi.fn(),
    waitForFileCommandResult: vi.fn().mockResolvedValue({
      type: "list_files",
      commandId: "cmd-1",
      path: "src",
      list: [{ name: "a.ts", type: "file", size: 10 }],
      truncated: false,
    }),
    cancelFileCommand: vi.fn(),
    ...overrides,
  };
}

function makeService(
  repo: ReturnType<typeof makeRepo>,
  config: ReturnType<typeof makeConfig>,
  runtimeService: ReturnType<typeof makeRuntimeService> = makeRuntimeService(),
  workerManager: ReturnType<typeof makeWorkerManager> = makeWorkerManager()
) {
  const runtimePolicy = new WorkspaceRuntimePolicy(config as never);
  const directoryHandler = new WorkspaceDirectoryHandler(
    repo as never,
    config as never,
    runtimePolicy
  );
  return new WorkspaceService(
    repo as never,
    makeConversationService(),
    { emit: vi.fn() } as never,
    runtimePolicy,
    directoryHandler,
    runtimeService as never,
    workerManager as never
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
        runtimeId: "builtin-local",
        isolationScope: "workspace",
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
      getAllowedRuntimeTypes: () => ["local", "docker"],
      isRuntimeTypeAllowed: (runtimeType: string) =>
        runtimeType === "local" || runtimeType === "docker",
      getAllowedIsolationScopes: () => ["user", "workspace"],
      isIsolationScopeAllowed: (scope: string) =>
        scope === "user" || scope === "workspace",
    });
    const service = makeService(repo, config);

    await service.create({
      userId: "admin-1",
      name: "Sandbox workspace",
      rootPath: "/tmp/other-project",
      runtimeType: "docker",
    });

    expect(repo.createWithDirectory).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeId: "builtin-docker",
        isolationScope: "workspace",
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
      getAllowedRuntimeTypes: () => ["local", "docker"],
      isRuntimeTypeAllowed: (runtimeType: string) =>
        runtimeType === "local" || runtimeType === "docker",
      getAllowedIsolationScopes: () => ["user", "workspace"],
      isIsolationScopeAllowed: (scope: string) =>
        scope === "user" || scope === "workspace",
    });
    const service = makeService(repo, config);

    const workspace = await service.create({
      userId: "admin-1",
      name: "Sandbox workspace",
      runtimeType: "docker",
      isolationScope: "workspace",
    });

    expect(repo.createWithDirectory).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeId: "builtin-docker",
        isolationScope: "workspace",
        rootPath: expectedRootPath,
        directorySource: "managed",
      })
    );
    expect(workspace.rootPath).toBe(expectedRootPath);
    expect(workspace.directorySource).toBe("managed");
  });

  it("rejects workspace-isolated custom directories inside the user root", async () => {
    const config = makeConfig({
      getAllowedRuntimeTypes: () => ["local", "docker"],
      isRuntimeTypeAllowed: (runtimeType: string) =>
        runtimeType === "local" || runtimeType === "docker",
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
        runtimeType: "docker",
        isolationScope: "workspace",
      })
    ).rejects.toThrow("工作空间隔离的自定义目录不能在用户工作空间目录内");
  });

  it("rejects sandbox custom directories when user isolation is explicitly selected", async () => {
    const config = makeConfig({
      getAllowedRuntimeTypes: () => ["local", "docker"],
      isRuntimeTypeAllowed: (runtimeType: string) =>
        runtimeType === "local" || runtimeType === "docker",
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
        runtimeType: "docker",
        isolationScope: "user",
      })
    ).rejects.toThrow("沙箱工作空间指定本地目录时必须使用工作空间级隔离");
  });

  it("rejects sandbox custom directories when workspace isolation is not allowed", async () => {
    const config = makeConfig({
      getAllowedRuntimeTypes: () => ["local", "docker"],
      isRuntimeTypeAllowed: (runtimeType: string) =>
        runtimeType === "local" || runtimeType === "docker",
    });
    const service = makeService(makeRepo(), config);

    await expect(
      service.create({
        userId: "admin-1",
        name: "Sandbox workspace",
        rootPath: "/tmp/other-project",
        runtimeType: "docker",
      })
    ).rejects.toThrow("当前部署不支持沙箱工作空间使用自定义本地目录");
  });

  it("rejects sandbox isolation scopes outside deployment capabilities", async () => {
    const config = makeConfig({
      getAllowedRuntimeTypes: () => ["local", "docker"],
      isRuntimeTypeAllowed: (runtimeType: string) =>
        runtimeType === "local" || runtimeType === "docker",
    });
    const service = makeService(makeRepo(), config);

    await expect(
      service.create({
        userId: "admin-1",
        name: "Sandbox workspace",
        runtimeType: "docker",
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
        runtimeType: "docker",
      })
    ).rejects.toThrow("当前部署不支持该工作空间运行环境");
  });

  describe("registered runtime placement", () => {
    function makeRegisteredRuntimeRow(overrides: Record<string, unknown> = {}) {
      return {
        id: "rt-1",
        name: "mac-studio",
        source: "registered",
        runtimeType: "docker",
        ownerId: "admin-1",
        status: "online",
        lastHeartbeatAt: new Date(),
        createdAt: new Date(),
        capabilities: { isolationScopes: ["user", "workspace"] },
        ...overrides,
      };
    }

    it("derives runtimeType from the target Runtime and stores runtimeId, bypassing fs ops", async () => {
      const repo = makeRepo();
      const runtimeService = makeRuntimeService({
        getOwned: vi.fn().mockResolvedValue(makeRegisteredRuntimeRow()),
      });
      const service = makeService(repo, makeConfig(), runtimeService);

      const workspace = await service.create({
        userId: "admin-1",
        name: "Remote workspace",
        rootPath: "/remote/project",
        runtimeId: "rt-1",
        isolationScope: "workspace",
      });

      expect(runtimeService.getOwned).toHaveBeenCalledWith("admin-1", "rt-1");
      expect(mkdirSync).not.toHaveBeenCalled();
      expect(repo.createWithDirectory).toHaveBeenCalledWith(
        expect.objectContaining({
          isolationScope: "workspace",
          rootPath: "/remote/project",
          directorySource: "remote",
          runtimeId: "rt-1",
        })
      );
      expect(workspace.directorySource).toBe("remote");
    });

    it("defaults isolationScope to the runtime's first advertised scope when unspecified", async () => {
      const repo = makeRepo();
      const runtimeService = makeRuntimeService({
        getOwned: vi.fn().mockResolvedValue(makeRegisteredRuntimeRow()),
      });
      const service = makeService(repo, makeConfig(), runtimeService);

      await service.create({
        userId: "admin-1",
        name: "Remote workspace",
        rootPath: "/remote/project",
        runtimeId: "rt-1",
      });

      expect(repo.createWithDirectory).toHaveBeenCalledWith(
        expect.objectContaining({ isolationScope: "user" })
      );
    });

    it("treats a registered local runtime like local: no isolationScope, no fs validation", async () => {
      const repo = makeRepo({
        createWithDirectory: vi.fn((input: WorkspaceCreateInput) =>
          Promise.resolve(workspaceRowFromCreate(input, "local"))
        ),
      });
      const runtimeService = makeRuntimeService({
        getOwned: vi.fn().mockResolvedValue(
          makeRegisteredRuntimeRow({
            runtimeType: "local",
            capabilities: null,
          })
        ),
      });
      const service = makeService(repo, makeConfig(), runtimeService);

      const workspace = await service.create({
        userId: "admin-1",
        name: "Remote local ws",
        rootPath: "/remote/home/project",
        runtimeId: "rt-1",
      });

      expect(repo.createWithDirectory).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimeId: "rt-1",
          isolationScope: "workspace",
        })
      );
      expect(workspace.isolationScope).toBeNull();
    });

    it("rejects isolationScope on a registered local runtime", async () => {
      const runtimeService = makeRuntimeService({
        getOwned: vi
          .fn()
          .mockResolvedValue(
            makeRegisteredRuntimeRow({ runtimeType: "local" })
          ),
      });
      const service = makeService(makeRepo(), makeConfig(), runtimeService);

      await expect(
        service.create({
          userId: "admin-1",
          name: "Remote workspace",
          rootPath: "/remote/project",
          runtimeId: "rt-1",
          isolationScope: "workspace",
        })
      ).rejects.toThrow("本地运行环境不能设置 isolationScope");
    });

    it("404s when the runtimeId does not belong to the caller", async () => {
      const runtimeService = makeRuntimeService({
        getOwned: vi.fn().mockResolvedValue(null),
      });
      const service = makeService(makeRepo(), makeConfig(), runtimeService);

      await expect(
        service.create({
          userId: "admin-1",
          name: "Remote workspace",
          rootPath: "/remote/project",
          runtimeId: "rt-x",
        })
      ).rejects.toThrow("Runtime rt-x not found");
    });

    it("rejects a runtime that has never completed registration", async () => {
      const runtimeService = makeRuntimeService({
        getOwned: vi
          .fn()
          .mockResolvedValue(makeRegisteredRuntimeRow({ runtimeType: null })),
      });
      const service = makeService(makeRepo(), makeConfig(), runtimeService);

      await expect(
        service.create({
          userId: "admin-1",
          name: "Remote workspace",
          rootPath: "/remote/project",
          runtimeId: "rt-1",
        })
      ).rejects.toThrow("该运行环境还未完成配对");
    });

    it("rejects an isolationScope the target runtime does not advertise", async () => {
      const runtimeService = makeRuntimeService({
        getOwned: vi.fn().mockResolvedValue(
          makeRegisteredRuntimeRow({
            capabilities: { isolationScopes: ["user"] },
          })
        ),
      });
      const service = makeService(makeRepo(), makeConfig(), runtimeService);

      await expect(
        service.create({
          userId: "admin-1",
          name: "Remote workspace",
          rootPath: "/remote/project",
          runtimeId: "rt-1",
          isolationScope: "workspace",
        })
      ).rejects.toThrow("该运行环境不支持隔离级别: workspace");
    });

    it("requires an absolute rootPath — no auto-generated path for a registered runtime", async () => {
      const runtimeService = makeRuntimeService({
        getOwned: vi.fn().mockResolvedValue(makeRegisteredRuntimeRow()),
      });
      const service = makeService(makeRepo(), makeConfig(), runtimeService);

      await expect(
        service.create({
          userId: "admin-1",
          name: "Remote workspace",
          runtimeId: "rt-1",
          isolationScope: "workspace",
        })
      ).rejects.toThrow("选择运行环境时必须填写绝对路径");
    });

    it("rejects Git clone for a registered runtime", async () => {
      const runtimeService = makeRuntimeService({
        getOwned: vi.fn().mockResolvedValue(makeRegisteredRuntimeRow()),
      });
      const service = makeService(makeRepo(), makeConfig(), runtimeService);

      await expect(
        service.create({
          userId: "admin-1",
          name: "Remote workspace",
          rootPath: "/remote/project",
          gitUrl: "https://github.com/example/repo.git",
          runtimeId: "rt-1",
          isolationScope: "workspace",
        })
      ).rejects.toThrow("远程运行环境不支持 Git 克隆");
    });
  });

  it("returns the stored sandbox isolation scope even when current deployment disallows it", async () => {
    const repo = makeRepo({
      listByOwner: vi.fn().mockResolvedValue([
        {
          id: "ws-1",
          name: "Sandbox workspace",
          gitUrl: null,
          description: null,
          runtime: { runtimeType: "docker" },
          isolationScope: "workspace",
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
      getAllowedRuntimeTypes: () => ["docker"],
      getDefaultRuntimeType: () => "docker",
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
        getOwnedId: vi.fn().mockResolvedValue({ id: workspaceId }),
      });
      const conversations = makeConversationService();
      const config = makeConfig();
      const runtimePolicy = new WorkspaceRuntimePolicy(config as never);
      const service = new WorkspaceService(
        repo as never,
        conversations,
        { emit } as never,
        runtimePolicy,
        new WorkspaceDirectoryHandler(
          repo as never,
          config as never,
          runtimePolicy
        ),
        makeRuntimeService() as never,
        {} as never
      );

      await service.delete(userId, workspaceId);

      expect(repo.softDelete).toHaveBeenCalledWith(
        workspaceId,
        expect.any(Date)
      );
      expect(conversations.deleteByWorkspace).toHaveBeenCalledWith(
        workspaceId,
        expect.any(Date)
      );
      expect(emit).toHaveBeenCalledWith(
        WORKSPACE_DELETED_EVENT,
        new WorkspaceDeletedEvent(workspaceId)
      );
    });
  });

  describe("getRunContext", () => {
    it("maps the workspace run view (directory + runtime config + owner username)", async () => {
      const repo = makeRepo({
        findRunView: vi.fn().mockResolvedValue({
          id: "ws-1",
          runtime: { runtimeType: "docker", source: "builtin" },
          isolationScope: "workspace",
          runtimeId: "builtin-docker",
          directory: { rootPath: "/tmp/ws" },
          user: { username: "mew" },
        }),
      });
      const service = makeService(repo, makeConfig());

      const view = await service.getRunContext("ws-1");

      expect(view).toEqual({
        workspaceId: "ws-1",
        workspaceRootPath: "/tmp/ws",
        runtimeType: "docker",
        isolationScope: "workspace",
        username: "mew",
        runtimeId: "builtin-docker",
        runtimeSource: "builtin",
      });
    });

    it("carries the bound runtimeId through for Registered runtime workspaces", async () => {
      const repo = makeRepo({
        findRunView: vi.fn().mockResolvedValue({
          id: "ws-1",
          runtime: { runtimeType: "docker", source: "registered" },
          isolationScope: "workspace",
          runtimeId: "rt-1",
          directory: { rootPath: "/remote/ws" },
          user: { username: "mew" },
        }),
      });
      const service = makeService(repo, makeConfig());

      const view = await service.getRunContext("ws-1");

      expect(view.runtimeId).toBe("rt-1");
      expect(view.runtimeSource).toBe("registered");
    });

    it("404s when the workspace does not exist", async () => {
      const repo = makeRepo({ findRunView: vi.fn().mockResolvedValue(null) });
      const service = makeService(repo, makeConfig());

      await expect(service.getRunContext("missing")).rejects.toThrow(
        "Workspace missing not found"
      );
    });

    it("400s when the workspace has no directory binding", async () => {
      const repo = makeRepo({
        findRunView: vi.fn().mockResolvedValue({
          id: "ws-1",
          runtime: { runtimeType: "local", source: "builtin" },
          isolationScope: "workspace",
          runtimeId: "builtin-local",
          directory: null,
          user: { username: "mew" },
        }),
      });
      const service = makeService(repo, makeConfig());

      await expect(service.getRunContext("ws-1")).rejects.toThrow(
        "工作空间必须关联目录才能运行 agent"
      );
    });
  });

  // 资源归属：用户接口的 update/delete 必须按属主限定，别人的 id 一律 404。
  // 跨用户的管理操作走 updateAny/listAll，受 @Roles("admin") 保护，不在此路径。
  describe("ownership scoping", () => {
    it("delete 404s and never soft-deletes a workspace the caller does not own", async () => {
      const repo = makeRepo({
        getOwnedId: vi.fn().mockResolvedValue(null),
      });
      const service = makeService(repo, makeConfig());

      await expect(service.delete("intruder", "ws-x")).rejects.toThrow(
        "Workspace ws-x not found"
      );
      expect(repo.getOwnedId).toHaveBeenCalledWith("intruder", "ws-x");
      expect(repo.softDelete).not.toHaveBeenCalled();
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

  // ── 文件预览路由(ADR-0005: builtin 直读 vs registered worker 代理) ──

  describe("file preview routing", () => {
    function makeBuiltinRunView() {
      return {
        id: "ws-1",
        runtime: { runtimeType: "local", source: "builtin" },
        isolationScope: "workspace",
        runtimeId: "builtin-local",
        directory: { rootPath: "/tmp/ws" },
        user: { username: "mew" },
      };
    }

    function makeRegisteredRunView() {
      return {
        id: "ws-1",
        runtime: { runtimeType: "docker", source: "registered" },
        isolationScope: "workspace",
        runtimeId: "rt-1",
        directory: { rootPath: "/remote/ws" },
        user: { username: "mew" },
      };
    }

    it("builtin listFiles routes to RuntimeService direct read, not worker", async () => {
      const repo = makeRepo({
        getOwnedId: vi.fn().mockResolvedValue({ id: "ws-1" }),
        findRunView: vi.fn().mockResolvedValue(makeBuiltinRunView()),
      });
      const runtimeService = makeRuntimeService();
      const workerManager = makeWorkerManager();
      const service = makeService(repo, makeConfig(), runtimeService, workerManager);

      const result = await service.listFiles("mew", "ws-1", "src");

      expect(runtimeService.listFiles).toHaveBeenCalledWith("/tmp/ws", "src");
      expect(workerManager.ensureWorkerForFilePreview).not.toHaveBeenCalled();
      expect(workerManager.sendFileCommand).not.toHaveBeenCalled();
      expect(result).toEqual({
        path: "src",
        list: [{ name: "a.ts", type: "file", size: 10 }],
        truncated: false,
      });
    });

    it("builtin readFile routes to RuntimeService direct read, not worker", async () => {
      const repo = makeRepo({
        getOwnedId: vi.fn().mockResolvedValue({ id: "ws-1" }),
        findRunView: vi.fn().mockResolvedValue(makeBuiltinRunView()),
      });
      const runtimeService = makeRuntimeService();
      const workerManager = makeWorkerManager();
      const service = makeService(repo, makeConfig(), runtimeService, workerManager);

      const result = await service.readFile("mew", "ws-1", "a.ts");

      expect(runtimeService.readFile).toHaveBeenCalledWith("/tmp/ws", "a.ts");
      expect(workerManager.ensureWorkerForFilePreview).not.toHaveBeenCalled();
      expect(result).toEqual({
        path: "a.ts",
        encoding: "utf8",
        content: "hello",
        size: 5,
        truncated: false,
      });
    });

    it("registered listFiles routes to worker proxy, not RuntimeService direct read", async () => {
      const repo = makeRepo({
        getOwnedId: vi.fn().mockResolvedValue({ id: "ws-1" }),
        findRunView: vi.fn().mockResolvedValue(makeRegisteredRunView()),
      });
      const runtimeService = makeRuntimeService();
      const workerManager = makeWorkerManager();
      const service = makeService(repo, makeConfig(), runtimeService, workerManager);

      await service.listFiles("mew", "ws-1", "src");

      expect(runtimeService.listFiles).not.toHaveBeenCalled();
      expect(workerManager.ensureWorkerForFilePreview).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: "ws-1", runtimeId: "rt-1" })
      );
      expect(workerManager.sendFileCommand).toHaveBeenCalled();
    });

    it("registered readFile routes to worker proxy, not RuntimeService direct read", async () => {
      const repo = makeRepo({
        getOwnedId: vi.fn().mockResolvedValue({ id: "ws-1" }),
        findRunView: vi.fn().mockResolvedValue(makeRegisteredRunView()),
      });
      const runtimeService = makeRuntimeService();
      const workerManager = makeWorkerManager({
        waitForFileCommandResult: vi.fn().mockResolvedValue({
          type: "read_file",
          commandId: "cmd-1",
          path: "a.ts",
          encoding: "utf8",
          content: "remote hello",
          size: 11,
          truncated: false,
        }),
      });
      const service = makeService(repo, makeConfig(), runtimeService, workerManager);

      const result = await service.readFile("mew", "ws-1", "a.ts");

      expect(runtimeService.readFile).not.toHaveBeenCalled();
      expect(workerManager.ensureWorkerForFilePreview).toHaveBeenCalled();
      expect(result.content).toBe("remote hello");
    });

    it("404s when the workspace does not belong to the caller (builtin)", async () => {
      const repo = makeRepo({
        getOwnedId: vi.fn().mockResolvedValue(null),
      });
      const service = makeService(repo, makeConfig());

      await expect(service.listFiles("intruder", "ws-x", "")).rejects.toThrow(
        "Workspace ws-x not found"
      );
    });

    it("404s when the workspace does not belong to the caller (registered)", async () => {
      const repo = makeRepo({
        getOwnedId: vi.fn().mockResolvedValue(null),
      });
      const service = makeService(repo, makeConfig());

      await expect(service.readFile("intruder", "ws-x", "a.ts")).rejects.toThrow(
        "Workspace ws-x not found"
      );
    });
  });
});
