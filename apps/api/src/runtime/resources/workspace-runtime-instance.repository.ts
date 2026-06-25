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

function ownerWhereByScopeKey(
  runtimeType: string,
  isolationScope: string,
  scopeKey: string
) {
  if (isolationScope === "user") {
    return {
      runtimeType,
      isolationScope,
      ownerUserId: scopeKey,
      ownerWorkspaceId: null,
    };
  }
  if (isolationScope !== "workspace") {
    throw new Error(`Unknown isolationScope: ${isolationScope}`);
  }
  return {
    runtimeType,
    isolationScope,
    ownerWorkspaceId: scopeKey,
  };
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
    scopeKey: string,
    runtimeInstanceId: string,
    metadata?: object
  ) {
    const where = ownerWhere(placement);
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.runtimeInstance.findFirst({ where });
      const data = {
        runtimeInstanceId,
        status: "running",
        expiresAt: null,
        metadata: runtimeInstanceMetadataJson(
          runningInstanceMetadata({
            placement,
            scopeKey,
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
            scopeKey:
              isolationScope === "user"
                ? placement.userId
                : placement.workspaceId,
            reason: "stopped",
          })
        ),
      },
    });
  }

  async markStoppedByScopeKey(
    runtimeType: string,
    isolationScope: string,
    scopeKey: string
  ) {
    await this.prisma.runtimeInstance.updateMany({
      where: ownerWhereByScopeKey(
        runtimeType,
        isolationScope,
        scopeKey
      ),
      data: {
        status: "stopped",
        metadata: runtimeInstanceMetadataJson(
          stoppedInstanceMetadata({
            runtimeType,
            isolationScope,
            scopeKey,
            reason: "stopped",
          })
        ),
      },
    });
  }

  async markMissingByScopeKey(
    runtimeType: string,
    isolationScope: string,
    scopeKey: string,
    reason = "missing"
  ) {
    await this.prisma.runtimeInstance.updateMany({
      where: ownerWhereByScopeKey(
        runtimeType,
        isolationScope,
        scopeKey
      ),
      data: {
        status: "missing",
        metadata: runtimeInstanceMetadataJson(
          statusInstanceMetadata({
            runtimeType,
            isolationScope,
            scopeKey,
            reason,
          })
        ),
      },
    });
  }

  async markErrorByScopeKey(
    runtimeType: string,
    isolationScope: string,
    scopeKey: string,
    errorMessage: string
  ) {
    await this.prisma.runtimeInstance.updateMany({
      where: ownerWhereByScopeKey(
        runtimeType,
        isolationScope,
        scopeKey
      ),
      data: {
        status: "error",
        metadata: runtimeInstanceMetadataJson(
          statusInstanceMetadata({
            runtimeType,
            isolationScope,
            scopeKey,
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
}
