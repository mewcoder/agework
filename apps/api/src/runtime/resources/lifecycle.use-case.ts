import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { RuntimeProviderRegistry } from "../providers/provider-registry";
import {
  runtimeResourceMetadataJson,
  stoppedResourceMetadata,
} from "./runtime-resource-metadata";
import { runtimeResourceKeyForOwner } from "./runtime-resource";

/**
 * Runtime 资源生命周期清理：
 * - workspace 删除：解除 workspace runtime 绑定，只关闭专属于该 workspace 的资源。
 * - user 删除：关闭该用户名下的所有 user/workspace 隔离资源。
 */
@Injectable()
export class RuntimeResourceLifecycleUseCase {
  private readonly logger = new Logger(RuntimeResourceLifecycleUseCase.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly runtimeProviderRegistry: RuntimeProviderRegistry
  ) {}

  /** 关闭专属于该 workspace 的 runtime 资源（user 隔离下的共享资源不受影响）。 */
  async shutdownForWorkspace(workspaceId: string): Promise<void> {
    const binding = await this.prisma.workspaceRuntimeResource.findUnique({
      where: { workspaceId },
      include: { resource: true },
    });
    if (binding?.resource.status === "running") {
      const resource = binding.resource;
      if (
        resource.isolationScope === "workspace" &&
        resource.ownerWorkspaceId === workspaceId
      ) {
        await this.shutdownResource(resource);
      }
    }
    await this.prisma.workspaceRuntimeResource.deleteMany({ where: { workspaceId } });
  }

  /** 关闭该用户名下所有 runtime 资源（user 级共享资源 + 该用户所有 workspace 级资源）。 */
  async shutdownForUser(userId: string): Promise<void> {
    const resources = await this.prisma.runtimeResource.findMany({
      where: { ownerUserId: userId, status: "running" },
    });
    for (const resource of resources) {
      await this.shutdownResource(resource);
    }
  }

  private async shutdownResource(resource: {
    id: string;
    runtimeType: string;
    isolationScope: string;
    ownerUserId: string;
    ownerWorkspaceId: string | null;
  }): Promise<void> {
    try {
      const resourceKey = runtimeResourceKeyForOwner(resource);
      const provider = this.runtimeProviderRegistry.resolve(
        resource.runtimeType
      );
      await Promise.resolve(
        provider.shutdownRuntimeResource?.(resourceKey)
      );
      await this.prisma.runtimeResource.update({
        where: { id: resource.id },
        data: {
          status: "stopped",
          metadata: runtimeResourceMetadataJson(
            stoppedResourceMetadata({
              runtimeType: resource.runtimeType,
              isolationScope: resource.isolationScope,
              resourceKey,
              reason: "owner_released",
            })
          ),
        },
      });
    } catch (err) {
      this.logger.warn(
        `Failed to shut down runtime resource ${resource.id}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
