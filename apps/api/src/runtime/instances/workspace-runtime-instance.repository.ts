import { Injectable } from "@nestjs/common";
import { generateId } from "@agework/shared";
import type { SandboxRuntimePlacement } from "@agework/shared/protocol";
import { PrismaService } from "../../prisma/prisma.service";
import {
  runtimeInstanceMetadataJson,
  runningInstanceMetadata,
  statusInstanceMetadata,
  stoppedInstanceMetadata,
} from "./runtime-instance-metadata";

function ownerWhere(
  runtimeType: string,
  isolationScope: string,
  ownerId: string
) {
  return { runtimeType, isolationScope, ownerId };
}

/**
 * 维护 workspace -> runtime resource 的绑定关系。
 * WorkspaceRuntime 表达业务绑定，RuntimeTarget 表达容器/沙箱资源生命周期。
 */
@Injectable()
export class WorkspaceRuntimeInstanceRepository {
  constructor(private prisma: PrismaService) {}

  async findActiveByWorkspace(workspaceId: string) {
    const binding = await this.prisma.workspaceRuntimeInstance.findUnique({
      where: { workspaceId },
      include: { resource: true },
    });
    return binding?.resource.status === "running" ? binding : null;
  }

  async upsertRunning(
    placement: SandboxRuntimePlacement,
    ownerId: string,
    runtimeInstanceId: string,
    metadata?: object
  ) {
    const where = ownerWhere(
      placement.runtimeType,
      placement.sandbox.isolationScope,
      ownerId
    );
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.runtimeInstance.findFirst({ where });
      const data = {
        runtimeInstanceId,
        status: "running",
        expiresAt: null,
        metadata: runtimeInstanceMetadataJson(
          runningInstanceMetadata({
            placement,
            ownerId,
            runtimeInstanceId,
            existing: existing?.metadata,
            metadata,
          })
        ),
      };
      const resource = existing
        ? await tx.runtimeInstance.update({
            where: { id: existing.id },
            data,
          })
        : await tx.runtimeInstance.create({
            data: {
              id: generateId(),
              ...where,
              ...data,
            },
          });
      const workspaceRuntimeInstance = await tx.workspaceRuntimeInstance.upsert({
        where: { workspaceId: placement.workspaceId },
        create: {
          id: generateId(),
          workspaceId: placement.workspaceId,
          resourceId: resource.id,
        },
        update: {
          resourceId: resource.id,
        },
      });
      return { resource, workspaceRuntimeInstance };
    });
  }

  async markStoppedByOwner(
    runtimeType: string,
    isolationScope: string,
    ownerId: string
  ) {
    await this.prisma.runtimeInstance.updateMany({
      where: ownerWhere(runtimeType, isolationScope, ownerId),
      data: {
        status: "stopped",
        metadata: runtimeInstanceMetadataJson(
          stoppedInstanceMetadata({
            runtimeType,
            isolationScope,
            ownerId,
            reason: "stopped",
          })
        ),
      },
    });
  }

  async markErrorByOwner(
    runtimeType: string,
    isolationScope: string,
    ownerId: string,
    errorMessage: string
  ) {
    await this.prisma.runtimeInstance.updateMany({
      where: ownerWhere(runtimeType, isolationScope, ownerId),
      data: {
        status: "error",
        metadata: runtimeInstanceMetadataJson(
          statusInstanceMetadata({
            runtimeType,
            isolationScope,
            ownerId,
            reason: "error",
            errorMessage,
          })
        ),
      },
    });
  }

  async findActiveResourceByRuntimeId(
    runtimeType: string,
    runtimeInstanceId: string
  ) {
    const resource = await this.prisma.runtimeInstance.findUnique({
      where: {
        runtimeType_runtimeInstanceId: {
          runtimeType,
          runtimeInstanceId,
        },
      },
    });
    return resource?.status === "running" ? resource : null;
  }

  async isRuntimeInstanceBoundToWorkspace(
    runtimeType: string,
    workspaceId: string,
    runtimeInstanceId: string
  ) {
    const binding = await this.prisma.workspaceRuntimeInstance.findUnique({
      where: { workspaceId },
      include: { resource: true },
    });
    return (
      binding?.resource.runtimeType === runtimeType &&
      binding.resource.runtimeInstanceId === runtimeInstanceId
    );
  }

  async deleteWorkspaceBinding(workspaceId: string) {
    await this.prisma.workspaceRuntimeInstance.deleteMany({
      where: { workspaceId },
    });
  }

  async deleteStaleResources() {
    return this.prisma.runtimeInstance.deleteMany({
      where: { status: "stale" },
    });
  }

  countRunning(): Promise<number> {
    return this.prisma.runtimeInstance.count({ where: { status: "running" } });
  }

  async listResourcesPage(opts: {
    status?: string;
    take: number;
    skip: number;
  }) {
    const where = opts.status ? { status: opts.status } : {};
    const [items, total] = await Promise.all([
      this.prisma.runtimeInstance.findMany({
        where,
        include: { workspaceRuntimeInstances: true },
        orderBy: { updatedAt: "desc" },
        take: opts.take,
        skip: opts.skip,
      }),
      this.prisma.runtimeInstance.count({ where }),
    ]);
    return { items, total };
  }

  findById(id: string) {
    return this.prisma.runtimeInstance.findUnique({ where: { id } });
  }

  /** 绑定 + 资源（不限状态），供生命周期清理判断隔离归属。 */
  findBindingWithResource(workspaceId: string) {
    return this.prisma.workspaceRuntimeInstance.findUnique({
      where: { workspaceId },
      include: { resource: true },
    });
  }

  findWorkspaceIdsByUser(userId: string): Promise<{ id: string }[]> {
    return this.prisma.workspace.findMany({
      where: { userId, deletedAt: null },
      select: { id: true },
    });
  }

  findRunningByOwners(ownerIds: string[]) {
    return this.prisma.runtimeInstance.findMany({
      where: { ownerId: { in: ownerIds }, status: "running" },
    });
  }

  /** 按 id 置为 stopped 并写入停机诊断元数据。 */
  async markStoppedById(
    resource: {
      id: string;
      runtimeType: string;
      isolationScope: string;
      ownerId: string;
    },
    reason: string
  ): Promise<void> {
    await this.prisma.runtimeInstance.update({
      where: { id: resource.id },
      data: {
        status: "stopped",
        metadata: runtimeInstanceMetadataJson(
          stoppedInstanceMetadata({
            runtimeType: resource.runtimeType,
            isolationScope: resource.isolationScope,
            ownerId: resource.ownerId,
            reason,
          })
        ),
      },
    });
  }
}
