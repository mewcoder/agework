import { Injectable, Logger } from "@nestjs/common";
import { generateId } from "@agework/shared";
import { PrismaService } from "../../prisma/prisma.service";
import {
  workerInstanceMetadataJson,
  runningInstanceMetadata,
  statusInstanceMetadata,
} from "./worker-registry-metadata";

export type UpsertRunningInput = {
  runtimeType: string;
  isolationScope: string;
  workspaceId: string;
  ownerId: string;
};

export type InsertStartingResult =
  | { ok: true; workerId: string }
  | {
      ok: false;
      existing: { workerId: string; runtimeInstanceId: string; status: string };
    };

function isPrismaUniqueError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "P2002"
  );
}

/**
 * WorkerRegistry 的 repository 层:维护 workspace -> worker 的绑定关系,以及 Worker
 * 本身的生命周期数据。数据表是 Worker/WorkerWorkspaceBinding,repository 归属从 runtime
 * 模块搬到 worker-manager 模块——WorkerRegistry 数据天然是 worker-manager 自注册/心跳端点
 * 要读写的东西,归 runtime 会导致 worker-manager 反过来依赖 runtime,破坏 runtime 的零依赖身份。
 *
 * Worker 表里只有活跃行(starting/running):停止/报错立刻物理删除该行,不是标记终态再
 * 等下次启动 sweep——见 schema.prisma Worker 模型注释。
 */
@Injectable()
export class WorkerRegistryRepository {
  private readonly logger = new Logger(WorkerRegistryRepository.name);

  constructor(private prisma: PrismaService) {}

  async findActiveByWorkspace(workspaceId: string) {
    const binding = await this.prisma.workerWorkspaceBinding.findUnique({
      where: { workspaceId },
      include: { worker: true },
    });
    return binding?.worker.status === "running" ? binding : null;
  }

  async upsertRunning(
    input: UpsertRunningInput,
    workerId: string,
    runtimeInstanceId: string,
    transport: string,
    targetRuntimeId: string,
    metadata?: object
  ) {
    return this.prisma.$transaction(async (tx) => {
      const data = {
        runtimeType: input.runtimeType,
        isolationScope: input.isolationScope,
        ownerId: input.ownerId,
        instanceId: runtimeInstanceId,
        transport,
        status: "running",
        runtimeId: targetRuntimeId,
        expiresAt: null,
        metadata: workerInstanceMetadataJson(
          runningInstanceMetadata({
            workspaceId: input.workspaceId,
            ownerId: input.ownerId,
            runtimeInstanceId,
            metadata,
          })
        ),
      };
      const worker = await tx.worker.update({ where: { id: workerId }, data });
      const binding = await tx.workerWorkspaceBinding.upsert({
        where: { workspaceId: input.workspaceId },
        create: {
          id: generateId(),
          workspaceId: input.workspaceId,
          workerId: worker.id,
        },
        update: { workerId: worker.id },
      });
      return { resource: worker, workspaceWorkerBinding: binding };
    });
  }

  /**
   * 冷启动前插入一条 starting 记录,靠 Worker 的复合唯一约束
   * (ownerId, runtimeId, isolationScope) 做并发防重:
   * 表里只有活跃行,同一 (owner, runtime, scope) 同时只能有一条。撞见冲突时返回已存在的活跃行,由调用方
   * 决定是复用还是报错(sandbox/native 的策略不同,不在这一层判断)。
   *
   * workerId 由调用方(provisioner)预生成,作为 Worker.id 主键写入,同时注入 worker env
   * 供 worker 回连时携带(协议身份见 Ticket 03)。
   */
  async insertStarting(
    input: UpsertRunningInput,
    workerId: string,
    instanceIdPlaceholder: string,
    transport: string,
    startToken: string,
    targetRuntimeId: string
  ): Promise<InsertStartingResult> {
    try {
      await this.prisma.worker.create({
        data: {
          id: workerId,
          runtimeType: input.runtimeType,
          isolationScope: input.isolationScope,
          ownerId: input.ownerId,
          instanceId: instanceIdPlaceholder, // placeholder, updated by upsertRunning
          transport,
          startToken,
          status: "starting",
          runtimeId: targetRuntimeId,
          metadata: workerInstanceMetadataJson(
            statusInstanceMetadata({
              runtimeType: input.runtimeType,
              isolationScope: input.isolationScope,
              ownerId: input.ownerId,
              reason: "starting",
            })
          ),
        },
      });
      return { ok: true, workerId };
    } catch (err) {
      if (!isPrismaUniqueError(err)) throw err;
      const existing = await this.prisma.worker.findUnique({
        where: {
          ownerId_runtimeId_isolationScope: {
            ownerId: input.ownerId,
            runtimeId: targetRuntimeId,
            isolationScope: input.isolationScope,
          },
        },
      });
      if (!existing) throw err;
      return {
        ok: false,
        existing: {
          workerId: existing.id,
          runtimeInstanceId: existing.instanceId,
          status: existing.status,
        },
      };
    }
  }

  /** owner 仍在(fence 判死 / admin 手动停):物理删行,保留物理载体(容器/进程不受影响)。 */
  async markStoppedByOwner(
    runtimeType: string,
    isolationScope: string,
    ownerId: string
  ) {
    await this.prisma.worker.deleteMany({
      where: { runtimeType, isolationScope, ownerId },
    });
    this.logger.log(`worker stopped for owner ${ownerId}`);
  }

  /** 启动失败:物理删行。errorMessage 由调用方已经记过日志,这里不重复存储。 */
  async markErrorByOwner(
    runtimeType: string,
    isolationScope: string,
    ownerId: string
  ) {
    await this.prisma.worker.deleteMany({
      where: { runtimeType, isolationScope, ownerId },
    });
    this.logger.warn(`worker launch error for owner ${ownerId}`);
  }

  /**
   * 服务重启后的扫尾用:清空所有还卡在 starting 的行——这些行代表上一个(已经不在了的)
   * 进程没来得及确认完成的启动尝试,不可能再被确认,必须清空,否则并发防重唯一索引
   * 会把对应 owner 永久卡死。
   */
  async markAllStartingAsError(): Promise<void> {
    const { count } = await this.prisma.worker.deleteMany({
      where: { status: "starting" },
    });
    if (count > 0) {
      this.logger.warn(`cleared ${count} interrupted starting worker rows`);
    }
  }

  /** 按 runtimeType 查找所有 running 状态的行,供重启扫尾用。 */
  findRunningByRuntimeType(runtimeType: string) {
    return this.prisma.worker.findMany({
      where: { runtimeType, status: "running" },
    });
  }

  /** 查找所有 running 状态的 container(docker/opensandbox)行,供重启扫尾用。 */
  findRunningContainerRows() {
    return this.prisma.worker.findMany({
      where: {
        status: "running",
        runtimeType: { in: ["docker", "opensandbox"] },
      },
    });
  }

  async findActiveResourceByRuntimeId(
    runtimeType: string,
    runtimeInstanceId: string
  ) {
    const resource = await this.prisma.worker.findUnique({
      where: {
        runtimeType_instanceId: {
          runtimeType,
          instanceId: runtimeInstanceId,
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
    const binding = await this.prisma.workerWorkspaceBinding.findUnique({
      where: { workspaceId },
      include: { worker: true },
    });
    return (
      binding?.worker.runtimeType === runtimeType &&
      binding.worker.instanceId === runtimeInstanceId
    );
  }

  async deleteWorkspaceBinding(workspaceId: string) {
    await this.prisma.workerWorkspaceBinding.deleteMany({
      where: { workspaceId },
    });
  }

  countRunning(): Promise<number> {
    return this.prisma.worker.count({ where: { status: "running" } });
  }

  findByRuntimeId(runtimeType: string, runtimeInstanceId: string) {
    return this.prisma.worker.findUnique({
      where: {
        runtimeType_instanceId: { runtimeType, instanceId: runtimeInstanceId },
      },
    });
  }

  /** 管理端 run 详情用:运行实例视图 + 绑定的 workspace。 */
  findRunInstanceView(runtimeType: string, runtimeInstanceId: string) {
    return this.prisma.worker.findUnique({
      where: {
        runtimeType_instanceId: { runtimeType, instanceId: runtimeInstanceId },
      },
      select: {
        id: true,
        runtimeType: true,
        isolationScope: true,
        ownerId: true,
        instanceId: true,
        status: true,
        expiresAt: true,
        createdAt: true,
        updatedAt: true,
        bindings: {
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
      this.prisma.worker.findMany({
        where,
        include: { bindings: true },
        orderBy: { updatedAt: "desc" },
        take: opts.take,
        skip: opts.skip,
      }),
      this.prisma.worker.count({ where }),
    ]);
    return { items, total };
  }

  findById(id: string) {
    return this.prisma.worker.findUnique({ where: { id } });
  }

  /** 绑定 + 资源(不限状态),供生命周期清理判断隔离归属。 */
  findBindingWithResource(workspaceId: string) {
    return this.prisma.workerWorkspaceBinding.findUnique({
      where: { workspaceId },
      include: { worker: true },
    });
  }

  findWorkspaceIdsByUser(userId: string): Promise<{ id: string }[]> {
    return this.prisma.workspace.findMany({
      where: { userId, deletedAt: null },
      select: { id: true },
    });
  }

  findRunningByOwners(ownerIds: string[]) {
    return this.prisma.worker.findMany({
      where: { ownerId: { in: ownerIds }, status: "running" },
    });
  }

  /**
   * 按 workerId 查该 worker 当前活跃(starting/running)行,供端点鉴权(startToken)
   * 和 fence 复用。协议身份改 workerId 后(Ticket 03),这是协议层的权威查找入口。
   */
  findActiveByWorkerId(workerId: string) {
    return this.prisma.worker.findUnique({
      where: { id: workerId },
      select: {
        id: true,
        startToken: true,
        runtimeType: true,
        instanceId: true,
        isolationScope: true,
        ownerId: true,
        runtimeId: true,
      },
    });
  }

  /** 按 id 物理删行(owner 永久消失场景,如删 workspace/user)。 */
  async markStoppedById(resource: { id: string }, reason: string) {
    await this.prisma.worker.delete({ where: { id: resource.id } });
    this.logger.log(`worker ${resource.id} removed: ${reason}`);
  }
}
