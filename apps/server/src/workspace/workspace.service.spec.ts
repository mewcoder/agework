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
// runtimeType 作为 workspace 快照持久化；runtimeHostId 只选择 builtin/registered Host。
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
    runtimeHost: {
      source: input.runtimeHostId === "builtin" ? "builtin" : "registered",
    },
    runtimeType: runtimeType,
    scope: input.scope,
    runtimeHostId: input.runtimeHostId,
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
          input.runtimeHostId === "builtin" ? "native" : "docker"
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
    getAllowedRuntimeTypes: () => ["native"],
    getDefaultRuntimeType: () => "native",
    isRuntimeTypeAllowed: (runtimeType: string) => runtimeType === "native",
    getAllowedScopes: () => ["user"],
    getDefaultWorkerScope: () => "user",
    isWorkerScopeAllowed: (scope: string) => scope === "user",
    ...overrides,
  };
}

function makeRuntimeService(overrides: Record<string, unknown> = {}) {
  return {
    getOwned: vi.fn().mockResolvedValue(null),
    getBuiltinHostId: vi.fn(() => "builtin"),
    isBuiltinHost: vi.fn(
      (runtimeHostId: string) => runtimeHostId === "builtin"
    ),
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
      list: [{ path: "a.ts", status: "modified", additions: 1, deletions: 0 }],
      truncated: false,
    }),
    readFileDiff: vi.fn().mockResolvedValue({
      path: "a.ts",
      status: "modified",
      before: "old",
      after: "new",
    }),
    ...overrides,
  };
}

function makeService(
  repo: ReturnType<typeof makeRepo>,
  config: ReturnType<typeof makeConfig>,
  runtimeService: ReturnType<typeof makeRuntimeService> = makeRuntimeService()
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
    runtimeService as never
  );
}

describe("WorkspaceService", () => {
  it("creates a managed directory and maps directory.rootPath back to rootPath", async () => {
    const expectedRootPath = join(
      "/tmp/agework/workspaces",
      "admin-1_ws260614113047"
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
        runtimeHostId: "builtin",
        scope: "workspace",
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

  it("auto-selects workspace runtimeType for sandbox custom directories when allowed", async () => {
    const repo = makeRepo();
    const config = makeConfig({
      getAllowedRuntimeTypes: () => ["native", "docker"],
      isRuntimeTypeAllowed: (runtimeType: string) =>
        runtimeType === "native" || runtimeType === "docker",
      getAllowedScopes: () => ["user", "workspace"],
      isWorkerScopeAllowed: (scope: string) =>
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
        runtimeHostId: "builtin",
        scope: "workspace",
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
      getAllowedRuntimeTypes: () => ["native", "docker"],
      isRuntimeTypeAllowed: (runtimeType: string) =>
        runtimeType === "native" || runtimeType === "docker",
      getAllowedScopes: () => ["user", "workspace"],
      isWorkerScopeAllowed: (scope: string) =>
        scope === "user" || scope === "workspace",
    });
    const service = makeService(repo, config);

    const workspace = await service.create({
      userId: "admin-1",
      name: "Sandbox workspace",
      runtimeType: "docker",
      scope: "workspace",
    });

    expect(repo.createWithDirectory).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeHostId: "builtin",
        scope: "workspace",
        rootPath: expectedRootPath,
        directorySource: "managed",
      })
    );
    expect(workspace.rootPath).toBe(expectedRootPath);
    expect(workspace.directorySource).toBe("managed");
  });

  it("rejects workspace-isolated custom directories inside the user root", async () => {
    const config = makeConfig({
      getAllowedRuntimeTypes: () => ["native", "docker"],
      isRuntimeTypeAllowed: (runtimeType: string) =>
        runtimeType === "native" || runtimeType === "docker",
      getAllowedScopes: () => ["user", "workspace"],
      isWorkerScopeAllowed: (scope: string) =>
        scope === "user" || scope === "workspace",
    });
    const service = makeService(makeRepo(), config);

    await expect(
      service.create({
        userId: "admin-1",
        name: "Sandbox workspace",
        rootPath: "/tmp/workspace/admin-1/my-project",
        runtimeType: "docker",
        scope: "workspace",
      })
    ).rejects.toThrow("工作空间范围的自定义目录不能在用户工作空间目录内");
  });

  it("rejects sandbox custom directories when user runtimeType is explicitly selected", async () => {
    const config = makeConfig({
      getAllowedRuntimeTypes: () => ["native", "docker"],
      isRuntimeTypeAllowed: (runtimeType: string) =>
        runtimeType === "native" || runtimeType === "docker",
      getAllowedScopes: () => ["user", "workspace"],
      isWorkerScopeAllowed: (scope: string) =>
        scope === "user" || scope === "workspace",
    });
    const service = makeService(makeRepo(), config);

    await expect(
      service.create({
        userId: "admin-1",
        name: "Local workspace",
        rootPath: "/tmp/other-project",
        runtimeType: "docker",
        scope: "user",
      })
    ).rejects.toThrow("沙箱工作空间指定本地目录时必须使用工作空间范围");
  });

  it("rejects sandbox custom directories when workspace runtimeType is not allowed", async () => {
    const config = makeConfig({
      getAllowedRuntimeTypes: () => ["native", "docker"],
      isRuntimeTypeAllowed: (runtimeType: string) =>
        runtimeType === "native" || runtimeType === "docker",
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

  it("rejects sandbox worker scopes outside deployment capabilities", async () => {
    const config = makeConfig({
      getAllowedRuntimeTypes: () => ["native", "docker"],
      isRuntimeTypeAllowed: (runtimeType: string) =>
        runtimeType === "native" || runtimeType === "docker",
    });
    const service = makeService(makeRepo(), config);

    await expect(
      service.create({
        userId: "admin-1",
        name: "Sandbox workspace",
        runtimeType: "docker",
        scope: "workspace",
      })
    ).rejects.toThrow("当前部署不支持该沙箱运行范围: workspace");
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
        ownerId: "admin-1",
        status: "online",
        lastHeartbeatAt: new Date(),
        createdAt: new Date(),
        capabilities: {
          docker: { available: true, scopes: ["user", "workspace"] },
        },
        ...overrides,
      };
    }

    it("derives runtimeType from the target Runtime and stores runtimeHostId, bypassing fs ops", async () => {
      const repo = makeRepo();
      const runtimeService = makeRuntimeService({
        getOwned: vi.fn().mockResolvedValue(makeRegisteredRuntimeRow()),
      });
      const service = makeService(repo, makeConfig(), runtimeService);

      const workspace = await service.create({
        userId: "admin-1",
        name: "Remote workspace",
        rootPath: "/remote/project",
        runtimeHostId: "rt-1",
        scope: "workspace",
      });

      expect(runtimeService.getOwned).toHaveBeenCalledWith("admin-1", "rt-1");
      expect(mkdirSync).not.toHaveBeenCalled();
      expect(repo.createWithDirectory).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: "workspace",
          rootPath: "/remote/project",
          directorySource: "remote",
          runtimeHostId: "rt-1",
        })
      );
      expect(workspace.directorySource).toBe("remote");
    });

    it("defaults scope to the runtime's first advertised scope when unspecified", async () => {
      const repo = makeRepo();
      const runtimeService = makeRuntimeService({
        getOwned: vi.fn().mockResolvedValue(makeRegisteredRuntimeRow()),
      });
      const service = makeService(repo, makeConfig(), runtimeService);

      await service.create({
        userId: "admin-1",
        name: "Remote workspace",
        rootPath: "/remote/project",
        runtimeHostId: "rt-1",
      });

      expect(repo.createWithDirectory).toHaveBeenCalledWith(
        expect.objectContaining({ scope: "user" })
      );
    });

    it("requires runtimeType when a Registered Host exposes multiple runtime types", async () => {
      const runtimeService = makeRuntimeService({
        getOwned: vi.fn().mockResolvedValue(
          makeRegisteredRuntimeRow({
            capabilities: {
              native: { available: true, scopes: ["workspace"] },
              docker: { available: true, scopes: ["user", "workspace"] },
            },
          })
        ),
      });
      const service = makeService(makeRepo(), makeConfig(), runtimeService);

      await expect(
        service.create({
          userId: "admin-1",
          name: "Remote workspace",
          rootPath: "/remote/project",
          runtimeHostId: "rt-1",
        })
      ).rejects.toThrow("该运行环境提供多种运行方式,请选择一种");
    });

    it("selects one runtimeType from a multi-runtimeType Registered Host", async () => {
      const repo = makeRepo();
      const runtimeService = makeRuntimeService({
        getOwned: vi.fn().mockResolvedValue(
          makeRegisteredRuntimeRow({
            capabilities: {
              native: { available: true, scopes: ["workspace"] },
              docker: { available: true, scopes: ["user", "workspace"] },
            },
          })
        ),
      });
      const service = makeService(repo, makeConfig(), runtimeService);

      await service.create({
        userId: "admin-1",
        name: "Remote workspace",
        rootPath: "/remote/project",
        runtimeHostId: "rt-1",
        runtimeType: "docker",
        scope: "workspace",
      });

      expect(repo.createWithDirectory).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimeHostId: "rt-1",
          runtimeType: "docker",
          scope: "workspace",
        })
      );
    });

    it("uses workspace scope for a registered native runtime without local fs validation", async () => {
      const repo = makeRepo({
        createWithDirectory: vi.fn((input: WorkspaceCreateInput) =>
          Promise.resolve(workspaceRowFromCreate(input, "native"))
        ),
      });
      const runtimeService = makeRuntimeService({
        getOwned: vi.fn().mockResolvedValue(
          makeRegisteredRuntimeRow({
            capabilities: {
              native: { available: true, scopes: ["workspace"] },
            },
          })
        ),
      });
      const service = makeService(repo, makeConfig(), runtimeService);

      const workspace = await service.create({
        userId: "admin-1",
        name: "Remote local ws",
        rootPath: "/remote/home/project",
        runtimeHostId: "rt-1",
      });

      expect(repo.createWithDirectory).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimeHostId: "rt-1",
          scope: "workspace",
        })
      );
      expect(workspace.scope).toBe("workspace");
    });

    it("accepts the only supported scope on a registered native runtime", async () => {
      const repo = makeRepo();
      const runtimeService = makeRuntimeService({
        getOwned: vi.fn().mockResolvedValue(
          makeRegisteredRuntimeRow({
            capabilities: {
              native: { available: true, scopes: ["workspace"] },
            },
          })
        ),
      });
      const service = makeService(repo, makeConfig(), runtimeService);

      await service.create({
        userId: "admin-1",
        name: "Remote workspace",
        rootPath: "/remote/project",
        runtimeHostId: "rt-1",
        scope: "workspace",
      });

      expect(repo.createWithDirectory).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimeType: "native",
          scope: "workspace",
        })
      );
    });

    it("rejects user scope on a registered native runtime", async () => {
      const runtimeService = makeRuntimeService({
        getOwned: vi.fn().mockResolvedValue(
          makeRegisteredRuntimeRow({
            capabilities: {
              native: { available: true, scopes: ["workspace"] },
            },
          })
        ),
      });
      const service = makeService(makeRepo(), makeConfig(), runtimeService);

      await expect(
        service.create({
          userId: "admin-1",
          name: "Remote workspace",
          rootPath: "/remote/project",
          runtimeHostId: "rt-1",
          scope: "user",
        })
      ).rejects.toThrow("native 运行方式只支持 workspace 范围");
    });

    it("404s when the runtimeHostId does not belong to the caller", async () => {
      const runtimeService = makeRuntimeService({
        getOwned: vi.fn().mockResolvedValue(null),
      });
      const service = makeService(makeRepo(), makeConfig(), runtimeService);

      await expect(
        service.create({
          userId: "admin-1",
          name: "Remote workspace",
          rootPath: "/remote/project",
          runtimeHostId: "rt-x",
        })
      ).rejects.toThrow("Runtime rt-x not found");
    });

    it("rejects a runtime that has never completed registration", async () => {
      const runtimeService = makeRuntimeService({
        getOwned: vi
          .fn()
          .mockResolvedValue(makeRegisteredRuntimeRow({ capabilities: null })),
      });
      const service = makeService(makeRepo(), makeConfig(), runtimeService);

      await expect(
        service.create({
          userId: "admin-1",
          name: "Remote workspace",
          rootPath: "/remote/project",
          runtimeHostId: "rt-1",
        })
      ).rejects.toThrow("该运行环境还未完成配对");
    });

    it("rejects an scope the target runtime does not advertise", async () => {
      const runtimeService = makeRuntimeService({
        getOwned: vi.fn().mockResolvedValue(
          makeRegisteredRuntimeRow({
            capabilities: {
              docker: { available: true, scopes: ["user"] },
            },
          })
        ),
      });
      const service = makeService(makeRepo(), makeConfig(), runtimeService);

      await expect(
        service.create({
          userId: "admin-1",
          name: "Remote workspace",
          rootPath: "/remote/project",
          runtimeHostId: "rt-1",
          scope: "workspace",
        })
      ).rejects.toThrow("该运行环境不支持运行范围: workspace");
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
          runtimeHostId: "rt-1",
          scope: "workspace",
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
          runtimeHostId: "rt-1",
          scope: "workspace",
        })
      ).rejects.toThrow("远程运行环境不支持 Git 克隆");
    });
  });

  it("returns the stored worker scope even when current deployment disallows it", async () => {
    const repo = makeRepo({
      listByOwner: vi.fn().mockResolvedValue([
        {
          id: "ws-1",
          name: "Sandbox workspace",
          gitUrl: null,
          description: null,
          runtimeHost: { source: "builtin" },
          scope: "workspace",
          userId: "admin-1",
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
          directory: {
            rootPath: "/tmp/workspace/admin-1/ws-1",
            status: "ready",
            source: "builtin",
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

    expect(result.list[0]?.scope).toBe("workspace");
    expect(result.list[0]?.directorySource).toBe("managed");
  });

  describe("delete", () => {
    const workspaceId = "ws-123";
    const userId = "user-1";

    it("emits WorkspaceDeletedEvent so downstream can clean up runtime resources", async () => {
      const emit = vi.fn();
      const repo = makeRepo({
        getOwnedId: vi
          .fn()
          .mockResolvedValue({ id: workspaceId, runtimeHostId: "builtin" }),
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
        makeRuntimeService() as never
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
        new WorkspaceDeletedEvent(workspaceId, userId, "builtin")
      );
    });
  });

  describe("getRunContext", () => {
    it("maps the workspace run view (directory + runtime config + owner username)", async () => {
      const repo = makeRepo({
        findRunView: vi.fn().mockResolvedValue({
          id: "ws-1",
          runtimeType: "docker",
          runtimeHost: { source: "builtin" },
          scope: "workspace",
          runtimeHostId: "builtin",
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
        scope: "workspace",
        username: "mew",
        runtimeHostId: "builtin",
        runtimeSource: "builtin",
      });
    });

    it("prefers the runtimeType snapshot column over runtime.runtimeType (Phase 2 双读)", async () => {
      const repo = makeRepo({
        findRunView: vi.fn().mockResolvedValue({
          id: "ws-1",
          runtimeType: "docker",
          runtimeHost: { source: "builtin" },
          scope: "workspace",
          runtimeHostId: "builtin",
          directory: { rootPath: "/tmp/ws" },
          user: { username: "mew" },
        }),
      });
      const service = makeService(repo, makeConfig());

      const view = await service.getRunContext("ws-1");

      expect(view.runtimeType).toBe("docker");
    });

    it("carries the bound runtimeHostId through for Registered runtime workspaces", async () => {
      const repo = makeRepo({
        findRunView: vi.fn().mockResolvedValue({
          id: "ws-1",
          runtimeType: "docker",
          runtimeHost: { source: "registered" },
          scope: "workspace",
          runtimeHostId: "rt-1",
          directory: { rootPath: "/remote/ws" },
          user: { username: "mew" },
        }),
      });
      const service = makeService(repo, makeConfig());

      const view = await service.getRunContext("ws-1");

      expect(view.runtimeHostId).toBe("rt-1");
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
          runtimeHost: { source: "builtin" },
          scope: "workspace",
          runtimeHostId: "builtin",
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

  // ── 文件预览路由（builtin 直读，registered 经隧道 RPC） ──

  describe("file preview routing", () => {
    function makeBuiltinRunView() {
      return {
        id: "ws-1",
        runtimeHost: { source: "builtin" },
        scope: "workspace",
        runtimeHostId: "builtin",
        directory: { rootPath: "/tmp/ws" },
        user: { username: "mew" },
      };
    }

    function makeRegisteredRunView() {
      return {
        id: "ws-1",
        runtimeHost: { source: "registered" },
        scope: "workspace",
        runtimeHostId: "rt-1",
        directory: { rootPath: "/remote/ws" },
        user: { username: "mew" },
      };
    }

    it("builtin listFiles routes to RuntimeHostService with runtimeHostId", async () => {
      const repo = makeRepo({
        getOwnedId: vi.fn().mockResolvedValue({ id: "ws-1" }),
        findRunView: vi.fn().mockResolvedValue(makeBuiltinRunView()),
      });
      const runtimeService = makeRuntimeService();
      const service = makeService(repo, makeConfig(), runtimeService);

      const result = await service.listFiles("mew", "ws-1", "src");

      expect(runtimeService.listFiles).toHaveBeenCalledWith(
        "builtin",
        "/tmp/ws",
        "src"
      );
      expect(result).toEqual({
        path: "src",
        list: [{ name: "a.ts", type: "file", size: 10 }],
        truncated: false,
      });
    });

    it("builtin readFile routes to RuntimeHostService with runtimeHostId", async () => {
      const repo = makeRepo({
        getOwnedId: vi.fn().mockResolvedValue({ id: "ws-1" }),
        findRunView: vi.fn().mockResolvedValue(makeBuiltinRunView()),
      });
      const runtimeService = makeRuntimeService();
      const service = makeService(repo, makeConfig(), runtimeService);

      const result = await service.readFile("mew", "ws-1", "a.ts");

      expect(runtimeService.readFile).toHaveBeenCalledWith(
        "builtin",
        "/tmp/ws",
        "a.ts"
      );
      expect(result).toEqual({
        path: "a.ts",
        encoding: "utf8",
        content: "hello",
        size: 5,
        truncated: false,
      });
    });

    it("registered listFiles routes to RuntimeHostService with runtimeHostId, not worker proxy", async () => {
      const repo = makeRepo({
        getOwnedId: vi.fn().mockResolvedValue({ id: "ws-1" }),
        findRunView: vi.fn().mockResolvedValue(makeRegisteredRunView()),
      });
      const runtimeService = makeRuntimeService();
      const service = makeService(repo, makeConfig(), runtimeService);

      await service.listFiles("mew", "ws-1", "src");

      expect(runtimeService.listFiles).toHaveBeenCalledWith(
        "rt-1",
        "/remote/ws",
        "src"
      );
    });

    it("registered readFile routes to RuntimeHostService with runtimeHostId, not worker proxy", async () => {
      const repo = makeRepo({
        getOwnedId: vi.fn().mockResolvedValue({ id: "ws-1" }),
        findRunView: vi.fn().mockResolvedValue(makeRegisteredRunView()),
      });
      const runtimeService = makeRuntimeService();
      const service = makeService(repo, makeConfig(), runtimeService);

      const result = await service.readFile("mew", "ws-1", "a.ts");

      expect(runtimeService.readFile).toHaveBeenCalledWith(
        "rt-1",
        "/remote/ws",
        "a.ts"
      );
      expect(result.content).toBe("hello");
    });

    it("builtin listChangedFiles routes to RuntimeHostService with runtimeHostId", async () => {
      const repo = makeRepo({
        getOwnedId: vi.fn().mockResolvedValue({ id: "ws-1" }),
        findRunView: vi.fn().mockResolvedValue(makeBuiltinRunView()),
      });
      const runtimeService = makeRuntimeService();
      const service = makeService(repo, makeConfig(), runtimeService);

      const result = await service.listChangedFiles("mew", "ws-1");

      expect(runtimeService.listChangedFiles).toHaveBeenCalledWith(
        "builtin",
        "/tmp/ws"
      );
      expect(result.list[0].path).toBe("a.ts");
    });

    it("registered listChangedFiles routes to RuntimeHostService with runtimeHostId", async () => {
      const repo = makeRepo({
        getOwnedId: vi.fn().mockResolvedValue({ id: "ws-1" }),
        findRunView: vi.fn().mockResolvedValue(makeRegisteredRunView()),
      });
      const runtimeService = makeRuntimeService();
      const service = makeService(repo, makeConfig(), runtimeService);

      await service.listChangedFiles("mew", "ws-1");

      expect(runtimeService.listChangedFiles).toHaveBeenCalledWith(
        "rt-1",
        "/remote/ws"
      );
    });

    it("builtin readFileDiff routes to RuntimeHostService with runtimeHostId", async () => {
      const repo = makeRepo({
        getOwnedId: vi.fn().mockResolvedValue({ id: "ws-1" }),
        findRunView: vi.fn().mockResolvedValue(makeBuiltinRunView()),
      });
      const runtimeService = makeRuntimeService();
      const service = makeService(repo, makeConfig(), runtimeService);

      const result = await service.readFileDiff("mew", "ws-1", "a.ts");

      expect(runtimeService.readFileDiff).toHaveBeenCalledWith(
        "builtin",
        "/tmp/ws",
        "a.ts"
      );
      expect(result.after).toBe("new");
    });

    it("registered readFileDiff routes to RuntimeHostService with runtimeHostId", async () => {
      const repo = makeRepo({
        getOwnedId: vi.fn().mockResolvedValue({ id: "ws-1" }),
        findRunView: vi.fn().mockResolvedValue(makeRegisteredRunView()),
      });
      const runtimeService = makeRuntimeService();
      const service = makeService(repo, makeConfig(), runtimeService);

      await service.readFileDiff("mew", "ws-1", "a.ts");

      expect(runtimeService.readFileDiff).toHaveBeenCalledWith(
        "rt-1",
        "/remote/ws",
        "a.ts"
      );
    });

    it("404s when the builtin workspace does not belong to the caller", async () => {
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

      await expect(
        service.readFile("intruder", "ws-x", "a.ts")
      ).rejects.toThrow("Workspace ws-x not found");
    });
  });
});
