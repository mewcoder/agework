import { Injectable } from "@nestjs/common";
import { generateId } from "@agework/shared";
import type { SandboxRuntimePlacement } from "@agework/shared/protocol";
import { PrismaService } from "../../prisma/prisma.service";
import {
  runtimeInstanceMetadataJson,
  runningInstanceMetadata,
  statusInstanceMetadata,
  stoppedInstanceMetadata,
} from "./worker-registry-metadata";

function ownerWhere(
  runtimeType: string,
  isolationScope: string,
  ownerId: string
) {
  return { runtimeType, isolationScope, ownerId };
}

/**
 * WorkerRegistry 的 repository 层:维护 workspace -> runtime resource 的绑定关系,
 * 以及实例本身的生命周期数据。数据表继续叫 RuntimeInstance/WorkspaceRuntimeInstance
 * (不改名),只是 repository 归属从 runtime 模块搬到 worker-host 模块——WorkerRegistry
 * 数据天然是 worker-host 自注册/心跳端点要读写的东西,归 runtime 会导致 worker-host
 * 反过来依赖 runtime,破坏 runtime 的零依赖身份。
 */
@Injectable()
export class WorkerRegistryRepository {
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
      const workspaceRuntimeInstance = await tx.workspaceRuntimeInstance.upsert(
        {
          where: { workspaceId: placement.workspaceId },
          create: {
            id: generateId(),
            workspaceId: placement.workspaceId,
            resourceId: resource.id,
          },
          update: {
            resourceId: resource.id,
          },
        }
      );
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

  countRunning(): Promise<number> {
    return this.prisma.runtimeInstance.count({ where: { status: "running" } });
  }

  findByRuntimeId(runtimeType: string, runtimeInstanceId: string) {
    return this.prisma.runtimeInstance.findUnique({
      where: {
        runtimeType_runtimeInstanceId: { runtimeType, runtimeInstanceId },
      },
    });
  }

  /** 管理端 run 详情用:运行实例视图 + 绑定的 workspace。 */
  findRunInstanceView(runtimeType: string, runtimeInstanceId: string) {
    return this.prisma.runtimeInstance.findUnique({
      where: {
        runtimeType_runtimeInstanceId: { runtimeType, runtimeInstanceId },
      },
      select: {
        id: true,
        runtimeType: true,
        isolationScope: true,
        ownerId: true,
        runtimeInstanceId: true,
        status: true,
        expiresAt: true,
        createdAt: true,
        updatedAt: true,
        workspaceRuntimeInstances: {
          select: {
            id: true,
            workspaceId: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
    });
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

  /** 绑定 + 资源(不限状态),供生命周期清理判断隔离归属。 */
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
