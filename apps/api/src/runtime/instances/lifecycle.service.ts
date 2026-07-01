import { Injectable, Logger } from "@nestjs/common";
import { RuntimeProviderRegistry } from "../providers/provider-registry";
import { WorkerHostService } from "../../worker-host/worker-host.service";

/**
 * Runtime 资源生命周期清理：
 * - workspace 删除：解除 workspace runtime 绑定，只关闭专属于该 workspace 的资源。
 * - user 删除：关闭该用户名下的所有 user/workspace 隔离资源。
 */
@Injectable()
export class RuntimeInstanceLifecycleService {
  private readonly logger = new Logger(RuntimeInstanceLifecycleService.name);

  constructor(
    private readonly workerHost: WorkerHostService,
    private readonly runtimeProviderRegistry: RuntimeProviderRegistry
  ) {}

  /** 关闭专属于该 workspace 的 runtime 资源（user 隔离下的共享资源不受影响）。 */
  async shutdownForWorkspace(workspaceId: string): Promise<void> {
    const binding =
      await this.workerHost.findRuntimeBindingWithResource(workspaceId);
    if (binding?.resource.status === "running") {
      const resource = binding.resource;
      if (
        resource.isolationScope === "workspace" &&
        resource.ownerId === workspaceId
      ) {
        await this.shutdownResource(resource);
      }
    }
    await this.workerHost.deleteRuntimeWorkspaceBinding(workspaceId);
  }

  /** 关闭该用户名下所有 runtime 资源（user 级共享资源 + 该用户所有 workspace 级资源）。
   *  user 隔离下 ownerId = userId；workspace 隔离下 ownerId = workspaceId（也归该 user），
   *  通过 ownerId IN (userId, 该 user 的 workspace ids) 匹配。 */
  async shutdownForUser(userId: string): Promise<void> {
    const workspaces = await this.workerHost.findWorkspaceIdsByUser(userId);
    const ownerIds = [userId, ...workspaces.map((w) => w.id)];
    const resources =
      await this.workerHost.findRunningRuntimesByOwners(ownerIds);
    for (const resource of resources) {
      await this.shutdownResource(resource);
    }
  }

  private async shutdownResource(resource: {
    id: string;
    runtimeType: string;
    isolationScope: string;
    ownerId: string;
  }): Promise<void> {
    try {
      const provider = this.runtimeProviderRegistry.resolve(
        resource.runtimeType
      );
      await Promise.resolve(
        provider.shutdownRuntimeInstanceByOwnerId?.(resource.ownerId)
      );
      await this.workerHost.markRuntimeStoppedById(resource, "owner_released");
    } catch (err) {
      this.logger.warn(
        `Failed to shut down runtime resource ${resource.id}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
