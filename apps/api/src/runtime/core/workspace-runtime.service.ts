import { Injectable } from "@nestjs/common";
import type { RuntimePlacement } from "@agework/shared/protocol";
import { PrismaService } from "../../prisma/prisma.service";

function ownerWhere(placement: RuntimePlacement) {
  return {
    runtimeType: placement.runtimeType,
    isolationScope: placement.isolationScope,
    ownerUserId: placement.userId,
    ownerWorkspaceId:
      placement.isolationScope === "workspace" ? placement.workspaceId : null,
  };
}

function ownerWhereByResourceKey(
  runtimeType: string,
  isolationScope: string,
  resourceKey: string
) {
  if (isolationScope === "user") {
    return {
      runtimeType,
      isolationScope,
      ownerUserId: resourceKey,
      ownerWorkspaceId: null,
    };
  }
  if (isolationScope !== "workspace") {
    throw new Error(`Unknown isolationScope: ${isolationScope}`);
  }
  return {
    runtimeType,
    isolationScope,
    ownerWorkspaceId: resourceKey,
  };
}

/**
 * 维护 workspace -> runtime resource 的绑定关系。
 * WorkspaceRuntime 表达业务绑定，RuntimeResource 表达容器/沙箱资源生命周期。
 */
@Injectable()
export class WorkspaceRuntimeService {
  constructor(private prisma: PrismaService) {}

  async findActiveByWorkspace(workspaceId: string) {
    const binding = await this.prisma.workspaceRuntime.findUnique({
      where: { workspaceId },
      include: { resource: true },
    });
    return binding?.resource.status === "running" ? binding : null;
  }

  async upsertRunning(
    placement: RuntimePlacement,
    runtimeResourceId: string,
    metadata?: object
  ) {
    const where = ownerWhere(placement);
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.runtimeResource.findFirst({ where });
      const data = {
        runtimeResourceId,
        status: "running",
        expiresAt: null,
        metadata: metadata ?? {},
      };
      const resource = existing
        ? await tx.runtimeResource.update({
            where: { id: existing.id },
            data,
          })
        : await tx.runtimeResource.create({
            data: {
              ...where,
              ...data,
            },
          });
      const workspaceRuntime = await tx.workspaceRuntime.upsert({
        where: { workspaceId: placement.workspaceId },
        create: {
          workspaceId: placement.workspaceId,
          resourceId: resource.id,
        },
        update: {
          resourceId: resource.id,
        },
      });
      return { resource, workspaceRuntime };
    });
  }

  async markStopped(placement: RuntimePlacement) {
    await this.prisma.runtimeResource.updateMany({
      where: ownerWhere(placement),
      data: { status: "stopped" },
    });
  }

  async markStoppedByResourceKey(
    runtimeType: string,
    isolationScope: string,
    resourceKey: string
  ) {
    await this.prisma.runtimeResource.updateMany({
      where: ownerWhereByResourceKey(
        runtimeType,
        isolationScope,
        resourceKey
      ),
      data: { status: "stopped" },
    });
  }

  async findActiveResourceByRuntimeId(
    runtimeType: string,
    runtimeResourceId: string
  ) {
    const resource = await this.prisma.runtimeResource.findUnique({
      where: {
        runtimeType_runtimeResourceId: {
          runtimeType,
          runtimeResourceId,
        },
      },
    });
    return resource?.status === "running" ? resource : null;
  }

  async isRuntimeResourceBoundToWorkspace(
    runtimeType: string,
    workspaceId: string,
    runtimeResourceId: string
  ) {
    const binding = await this.prisma.workspaceRuntime.findUnique({
      where: { workspaceId },
      include: { resource: true },
    });
    return (
      binding?.resource.runtimeType === runtimeType &&
      binding.resource.runtimeResourceId === runtimeResourceId
    );
  }

  async deleteWorkspaceBinding(workspaceId: string) {
    await this.prisma.workspaceRuntime.deleteMany({
      where: { workspaceId },
    });
  }

  async deleteStaleResources() {
    return this.prisma.runtimeResource.deleteMany({
      where: { status: "stale" },
    });
  }
}
