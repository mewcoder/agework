import { describe, expect, it, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { AdminRuntimeController } from "./admin-runtime.controller";

function makeController(overrides: {
  configService?: Record<string, unknown>;
  prisma?: Record<string, unknown>;
  runtimeService?: Record<string, unknown>;
} = {}) {
  return new AdminRuntimeController(
    {
      getDefaultRuntimeType: vi.fn().mockReturnValue("sandbox"),
      getAllowedRuntimeTypes: vi.fn().mockReturnValue(["local", "sandbox"]),
      getDefaultIsolationScope: vi.fn().mockReturnValue("workspace"),
      getAllowedIsolationScopes: vi.fn().mockReturnValue(["user", "workspace"]),
      getIdleTimeoutSeconds: vi.fn().mockReturnValue(600),
      ...overrides.configService,
    } as never,
    {
      runtimeInstance: {
        count: vi.fn().mockResolvedValue(0),
        findMany: vi.fn().mockResolvedValue([]),
        findUnique: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockResolvedValue({}),
      },
      ...overrides.prisma,
    } as never,
    {
      shutdownRuntimeInstance: vi.fn(),
      ...overrides.runtimeService,
    } as never
  );
}

describe("AdminRuntimeController", () => {
  it("lists runtime resources with derived ownership and diagnostics", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "rr-1",
        runtimeType: "sandbox",
        isolationScope: "workspace",
        ownerUserId: "user-1",
        ownerWorkspaceId: "ws-1",
        runtimeResourceId: "container-abc",
        status: "running",
        expiresAt: null,
        metadata: {
          resourceKey: "ws-1",
          statusReason: "running",
          lastSeenAt: "2026-06-25T00:00:00.000Z",
        },
        createdAt: new Date("2026-06-25T00:00:00.000Z"),
        updatedAt: new Date("2026-06-25T00:01:00.000Z"),
        workspaceRuntimeResources: [
          {
            id: "wr-1",
            workspaceId: "ws-1",
            createdAt: new Date("2026-06-25T00:00:00.000Z"),
            updatedAt: new Date("2026-06-25T00:01:00.000Z"),
          },
        ],
      },
    ]);
    const count = vi.fn().mockResolvedValue(1);
    const controller = makeController({
      prisma: {
        runtimeInstance: {
          findMany,
          count,
        },
      },
    });

    const result = await controller.listResources("running", "1", "10");

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: "running" },
        include: { workspaceRuntimeResources: true },
      })
    );
    expect(result.list[0]).toMatchObject({
      id: "rr-1",
      resourceKey: "ws-1",
      workspaceCount: 1,
      isReusable: true,
      diagnostics: {
        resourceKey: "ws-1",
        statusReason: "running",
        lastSeenAt: "2026-06-25T00:00:00.000Z",
        runtimeResourceId: "container-abc",
      },
      createdAt: "2026-06-25T00:00:00.000Z",
      updatedAt: "2026-06-25T00:01:00.000Z",
    });
  });

  it("stops a running runtime resource and records stop diagnostics", async () => {
    const shutdownRuntimeInstance = vi.fn();
    const findUnique = vi.fn().mockResolvedValue({
      id: "rr-1",
      runtimeType: "sandbox",
      isolationScope: "workspace",
      ownerUserId: "user-1",
      ownerWorkspaceId: "ws-1",
      status: "running",
    });
    const update = vi.fn().mockResolvedValue({});
    const controller = makeController({
      prisma: {
        runtimeInstance: {
          findUnique,
          update,
        },
      },
      runtimeService: {
        shutdownRuntimeInstance,
      },
    });

    await expect(controller.stopResource({ id: "rr-1" })).resolves.toEqual({
      ok: true,
    });

    expect(shutdownRuntimeInstance).toHaveBeenCalledWith("sandbox", "ws-1");
    expect(update).toHaveBeenCalledWith({
      where: { id: "rr-1" },
      data: {
        status: "stopped",
        metadata: expect.objectContaining({
          resourceKey: "ws-1",
          statusReason: "manual_stop",
          stoppedAt: expect.any(String),
        }),
      },
    });
  });

  it("throws when stopping a missing or non-running resource", async () => {
    const controller = makeController({
      prisma: {
        runtimeInstance: {
          findUnique: vi.fn().mockResolvedValue({ status: "stopped" }),
        },
      },
    });

    await expect(controller.stopResource({ id: "rr-1" })).rejects.toThrow(
      NotFoundException
    );
  });
});
