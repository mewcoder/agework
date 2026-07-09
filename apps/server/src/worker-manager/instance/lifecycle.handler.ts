import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import { WorkerRegistryRepository } from "../registry/worker-registry.repository";
import { WorkerProvisioner } from "./worker.provisioner";
import { RuntimeService } from "../../runtime/runtime.service";
import { isRuntimeType, type RuntimeInstanceRef } from "@agework/providers";
import { WorkerLivenessStore } from "../connection/worker-liveness.store";
import { swallow } from "../../common/swallow";

/**
 * Worker 生命周期清理:
 * - workspace 删除:解除 workspace 的 worker 绑定,只关闭专属于该 workspace 的载体。
 * - user 删除:关闭该用户名下的所有 user/workspace 隔离载体。
 *
 * 物理关闭统一经同模块的 WorkerProvisioner(local/sandbox 差异收在
 * WorkerProvisioner/RuntimeService 内部,这里不再区分)。
 */
@Injectable()
export class WorkerLifecycleHandler implements OnApplicationBootstrap {
  private readonly logger = new Logger(WorkerLifecycleHandler.name);

  constructor(
    private readonly registry: WorkerRegistryRepository,
    private readonly provisioner: WorkerProvisioner,
    private readonly runtimeService: RuntimeService,
    private readonly livenessStore: WorkerLivenessStore
  ) {}

  /** 关闭专属于该 workspace 的 worker 载体(user 隔离下的共享载体不受影响)。 */
  async shutdownForWorkspace(workspaceId: string): Promise<void> {
    const binding = await this.registry.findBindingWithResource(workspaceId);
    if (binding?.worker.status === "running") {
      const resource = binding.worker;
      if (
        resource.isolationScope === "workspace" &&
        resource.ownerId === workspaceId
      ) {
        await this.shutdownResource(resource);
      }
    }
    await this.registry.deleteWorkspaceBinding(workspaceId);
  }

  /** 关闭该用户名下所有 worker 载体(user 级共享载体 + 该用户所有 workspace 级载体)。
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
   * 容器错误标记为已停止(Phase 1 移除的 blanket 清理正是这个教训)。(3) 给
   * sandbox running 行一次被 WorkerLivenessStore track 的机会——重启后这份
   * 内存 store 是空的,不 touch 的话真的已经死透的 sandbox owner(容器随
   * server 一起没了、不会再来 poll)永远不会进入 listStale。这只是一次普通
   * 的 touch(),让这些 owner 从 boot 起获得一个完整的心跳超时窗口:真的还
   * 活着的会在窗口内 poll 一次自然刷新,真的已经死了的会被同一条 watchdog
   * sweep 逻辑 fence 掉,不需要单独的宽限窗/特殊标记。
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.registry.markAllStartingAsError();

    // "native" runtimeType 不等于 Managed——Registered manager 也能配成
    // --runtime native(裸远程机器)。这条扫尾专治"server 重启,fork 出的子进程
    // 父子关系断了"这一种孤儿,只对 Managed(managed-native)成立:Registered
    // worker 的父进程是远程 manager,server 重启跟它无关,不是孤儿,不该动它——
    // 它的存活由心跳 fence 另行判定。
    const managedNativeId = this.runtimeService.getManagedRuntimeId("native");
    const staleNativeRows = (
      await this.registry.findRunningByRuntimeType("native")
    ).filter((row) => row.runtimeId === managedNativeId);
    for (const row of staleNativeRows) {
      try {
        await this.runtimeService.runtimeFor(managedNativeId).destroy({
          runtimeType: "native",
          ownerId: row.ownerId,
          workerId: row.id,
          runtimeInstanceId: row.instanceId,
          isolationScope: row.isolationScope,
        });
      } catch (err) {
        this.logger.warn(
          `Failed to recover orphaned native instance ${row.instanceId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      await this.registry
        .markStoppedById(row, "interrupted_by_restart")
        .catch(
          swallow(this.logger, `mark stopped for orphaned native row ${row.id}`)
        );
    }

    const runningContainerRows = await this.registry.findRunningContainerRows();
    for (const row of runningContainerRows) {
      this.livenessStore.touch(row.ownerId);
    }
  }

  private async shutdownResource(resource: {
    id: string;
    runtimeType: string;
    isolationScope: string;
    ownerId: string;
    instanceId: string;
    runtimeId: string;
  }): Promise<void> {
    if (!isRuntimeType(resource.runtimeType)) {
      this.logger.warn(
        `skip shutdown for resource ${resource.id}: unknown runtimeType ${resource.runtimeType}`
      );
      return;
    }
    try {
      const ref: RuntimeInstanceRef = {
        runtimeType: resource.runtimeType,
        ownerId: resource.ownerId,
        workerId: resource.id,
        runtimeInstanceId: resource.instanceId,
        isolationScope: resource.isolationScope,
        targetRuntimeId: resource.runtimeId,
      };
      await this.provisioner.destroy(ref);
      await this.registry.markStoppedById(resource, "owner_released");
    } catch (err) {
      this.logger.warn(
        `Failed to shut down runtime resource ${resource.id}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
