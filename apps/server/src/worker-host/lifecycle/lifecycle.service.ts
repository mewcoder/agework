import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import { WorkerRegistryRepository } from "../registry/worker-registry.repository";
import { SandboxInstanceExecutor } from "../sandbox-instance/sandbox-instance.executor";
import { LocalInstanceExecutor } from "../local-instance/local-instance.executor";
import { swallow } from "../../common/swallow";

/**
 * Runtime 资源生命周期清理:
 * - workspace 删除:解除 workspace runtime 绑定,只关闭专属于该 workspace 的资源。
 * - user 删除:关闭该用户名下的所有 user/workspace 隔离资源。
 *
 * sandbox 资源经同模块的 SandboxInstanceExecutor 物理关闭;local 资源现在也写
 * WorkerRegistry(owner 长期复用),经同模块的 LocalInstanceExecutor 物理关闭。
 */
@Injectable()
export class RuntimeInstanceLifecycleService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RuntimeInstanceLifecycleService.name);

  constructor(
    private readonly registry: WorkerRegistryRepository,
    private readonly sandboxInstances: SandboxInstanceExecutor,
    private readonly localInstances: LocalInstanceExecutor
  ) {}

  /** 关闭专属于该 workspace 的 runtime 资源(user 隔离下的共享资源不受影响)。 */
  async shutdownForWorkspace(workspaceId: string): Promise<void> {
    const binding = await this.registry.findBindingWithResource(workspaceId);
    if (binding?.resource.status === "running") {
      const resource = binding.resource;
      if (
        resource.isolationScope === "workspace" &&
        resource.ownerId === workspaceId
      ) {
        await this.shutdownResource(resource);
      }
    }
    await this.registry.deleteWorkspaceBinding(workspaceId);
  }

  /** 关闭该用户名下所有 runtime 资源(user 级共享资源 + 该用户所有 workspace 级资源)。
   *  user 隔离下 ownerId = userId;workspace 隔离下 ownerId = workspaceId(也归该 user),
   *  通过 ownerId IN (userId, 该 user 的 workspace ids) 匹配。 */
  async shutdownForUser(userId: string): Promise<void> {
    const workspaces = await this.registry.findWorkspaceIdsByUser(userId);
    const ownerIds = [userId, ...workspaces.map((w) => w.id)];
    const resources = await this.registry.findRunningByOwners(ownerIds);
    for (const resource of resources) {
      await this.shutdownResource(resource);
    }
  }

  /**
   * 服务重启后的扫尾:(1) 清空所有卡在 starting 的行——这些行代表上一个
   * (已经不在了的)进程没来得及确认完成的启动尝试,不清空会让并发防重
   * 唯一索引把对应 owner 永久卡死(仍待讨论第 13 条)。(2) 回收残留的
   * local running 行——local 走 IPC,父子进程关系随 API 进程重启必然断,
   * 不存在"重连"这回事(设计文档 2.4 节),物理杀掉可能还在跑的孤儿进程
   * 并把行标记为 stopped。sandbox 的 running 行不在这次扫尾范围内:容器
   * 是独立进程,大概率在 API 重启后还活着,盲目清空会把仍在正常工作的
   * 容器错误标记为已停止(Phase 1 移除的 blanket 清理正是这个教训)。
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.registry.markAllStartingAsError();

    const staleLocalRows =
      await this.registry.findRunningByRuntimeType("local");
    for (const row of staleLocalRows) {
      try {
        await this.localInstances.recoverOrphan(row.runtimeInstanceId);
      } catch (err) {
        this.logger.warn(
          `Failed to recover orphaned local instance ${row.runtimeInstanceId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      await this.registry
        .markStoppedById(row, "interrupted_by_restart")
        .catch(
          swallow(this.logger, `mark stopped for orphaned local row ${row.id}`)
        );
    }
  }

  private async shutdownResource(resource: {
    id: string;
    runtimeType: string;
    isolationScope: string;
    ownerId: string;
  }): Promise<void> {
    try {
      if (resource.runtimeType === "sandbox") {
        await Promise.resolve(
          this.sandboxInstances.shutdownRuntimeInstanceByOwnerId(
            resource.ownerId
          )
        );
      } else if (resource.runtimeType === "local") {
        await Promise.resolve(
          this.localInstances.shutdownRuntimeInstanceByOwnerId(resource.ownerId)
        );
      }
      await this.registry.markStoppedById(resource, "owner_released");
    } catch (err) {
      this.logger.warn(
        `Failed to shut down runtime resource ${resource.id}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
