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

function ownerWhere(placement: SandboxRuntimePlacement) {
  const isolationScope = placement.sandbox.isolationScope;
  return {
    runtimeType: placement.runtimeType,
    isolationScope,
    ownerUserId: placement.userId,
    ownerWorkspaceId:
      isolationScope === "workspace" ? placement.workspaceId : null,
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
    resourceKey: string,
    runtimeResourceId: string,
    metadata?: object
  ) {
    const where = ownerWhere(placement);
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.runtimeInstance.findFirst({ where });
      const data = {
        runtimeResourceId,
        status: "running",
        expiresAt: null,
        metadata: runtimeInstanceMetadataJson(
          runningInstanceMetadata({
            placement,
            resourceKey,
            runtimeResourceId,
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

  async markStopped(placement: SandboxRuntimePlacement) {
    const isolationScope = placement.sandbox.isolationScope;
    await this.prisma.runtimeInstance.updateMany({
      where: ownerWhere(placement),
      data: {
        status: "stopped",
        metadata: runtimeInstanceMetadataJson(
          stoppedInstanceMetadata({
            runtimeType: placement.runtimeType,
            isolationScope,
            resourceKey:
              isolationScope === "user"
                ? placement.userId
                : placement.workspaceId,
            reason: "stopped",
          })
        ),
      },
    });
  }

  async markStoppedByResourceKey(
    runtimeType: string,
    isolationScope: string,
    resourceKey: string
  ) {
    await this.prisma.runtimeInstance.updateMany({
      where: ownerWhereByResourceKey(
        runtimeType,
        isolationScope,
        resourceKey
      ),
      data: {
        status: "stopped",
        metadata: runtimeInstanceMetadataJson(
          stoppedInstanceMetadata({
            runtimeType,
            isolationScope,
            resourceKey,
            reason: "stopped",
          })
        ),
      },
    });
  }

  async markMissingByResourceKey(
    runtimeType: string,
    isolationScope: string,
    resourceKey: string,
    reason = "missing"
  ) {
    await this.prisma.runtimeInstance.updateMany({
      where: ownerWhereByResourceKey(
        runtimeType,
        isolationScope,
        resourceKey
      ),
      data: {
        status: "missing",
        metadata: runtimeInstanceMetadataJson(
          statusInstanceMetadata({
            runtimeType,
            isolationScope,
            resourceKey,
            reason,
          })
        ),
      },
    });
  }

  async markErrorByResourceKey(
    runtimeType: string,
    isolationScope: string,
    resourceKey: string,
    errorMessage: string
  ) {
    await this.prisma.runtimeInstance.updateMany({
      where: ownerWhereByResourceKey(
        runtimeType,
        isolationScope,
        resourceKey
      ),
      data: {
        status: "error",
        metadata: runtimeInstanceMetadataJson(
          statusInstanceMetadata({
            runtimeType,
            isolationScope,
            resourceKey,
            reason: "error",
            errorMessage,
          })
        ),
      },
    });
  }

  async findActiveResourceByRuntimeId(
    runtimeType: string,
    runtimeResourceId: string
  ) {
    const resource = await this.prisma.runtimeInstance.findUnique({
      where: {
        runtimeType_runtimeResourceId: {
          runtimeType,
          runtimeResourceId,
        },
      },
    });
    return resource?.status === "running" ? resource : null;
  }

  async isRuntimeInstanceBoundToWorkspace(
    runtimeType: string,
    workspaceId: string,
    runtimeResourceId: string
  ) {
    const binding = await this.prisma.workspaceRuntimeInstance.findUnique({
      where: { workspaceId },
      include: { resource: true },
    });
    return (
      binding?.resource.runtimeType === runtimeType &&
      binding.resource.runtimeResourceId === runtimeResourceId
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
}
