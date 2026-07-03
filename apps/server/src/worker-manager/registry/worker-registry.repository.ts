import { Injectable } from "@nestjs/common";
import { generateId } from "@agework/shared";
import { PrismaService } from "../../prisma/prisma.service";
import {
  workerInstanceMetadataJson,
  runningInstanceMetadata,
  statusInstanceMetadata,
  stoppedInstanceMetadata,
} from "./worker-registry-metadata";

export type UpsertRunningInput = {
  runtimeType: string;
  isolationScope: string;
  workspaceId: string;
  ownerId: string;
};

export type InsertStartingResult =
  | { ok: true }
  | { ok: false; existing: { runtimeInstanceId: string; status: string } };

function ownerWhere(
  runtimeType: string,
  isolationScope: string,
  ownerId: string
) {
  return { runtimeType, isolationScope, ownerId };
}

function isPrismaUniqueError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "P2002"
  );
}

/**
 * WorkerRegistry 的 repository 层:维护 workspace -> runtime resource 的绑定关系,
 * 以及实例本身的生命周期数据。数据表是 WorkerInstance/WorkspaceWorkerBinding,
 * repository 归属从 runtime 模块搬到 worker-manager 模块——WorkerRegistry
 * 数据天然是 worker-manager 自注册/心跳端点要读写的东西,归 runtime 会导致 worker-manager
 * 反过来依赖 runtime,破坏 runtime 的零依赖身份。
 */
@Injectable()
export class WorkerRegistryRepository {
  constructor(private prisma: PrismaService) {}

  async findActiveByWorkspace(workspaceId: string) {
    const binding = await this.prisma.workspaceWorkerBinding.findUnique({
      where: { workspaceId },
      include: { workerInstance: true },
    });
    return binding?.workerInstance.status === "running" ? binding : null;
  }

  async upsertRunning(
    input: UpsertRunningInput,
    runtimeInstanceId: string,
    transport: string,
    metadata?: object
  ) {
    const where = ownerWhere(
      input.runtimeType,
      input.isolationScope,
      input.ownerId
    );
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.workerInstance.findFirst({ where });
      const data = {
        runtimeInstanceId,
        transport,
        status: "running",
        activeOwnerKey: input.ownerId,
        expiresAt: null,
        metadata: workerInstanceMetadataJson(
          runningInstanceMetadata({
            workspaceId: input.workspaceId,
            ownerId: input.ownerId,
            runtimeInstanceId,
            existing: existing?.metadata,
            metadata,
          })
        ),
      };
      const resource = existing
        ? await tx.workerInstance.update({
            where: { id: existing.id },
            data,
          })
        : await tx.workerInstance.create({
            data: {
              id: generateId(),
              ...where,
              ...data,
            },
          });
      const workspaceWorkerBinding = await tx.workspaceWorkerBinding.upsert({
        where: { workspaceId: input.workspaceId },
        create: {
          id: generateId(),
          workspaceId: input.workspaceId,
          workerInstanceId: resource.id,
        },
        update: {
          workerInstanceId: resource.id,
        },
      });
      return { resource, workspaceWorkerBinding };
    });
  }

  /**
   * 冷启动前插入一条 starting 记录,靠 WorkerInstance.activeOwnerKey 列的
   * @@unique 约束做并发防重:行处于 starting/running 时 activeOwnerKey =
   * ownerId,终态(stopped/error)时置 null,SQLite 把多个 NULL 视为互不冲突,
   * 于是"同一 ownerId 同时只能有一条活跃行"由 DB 唯一约束原生保证。撞见冲突时
   * 返回已存在的活跃行,由调用方决定是复用还是报错(sandbox/local 的策略不同,
   * 不在这一层判断)。
   * 插入前先删掉该 owner 名下的历史终态行(stopped/error),避免它们跟新插入的
   * starting 行同时存在导致 upsertRunning 后续的 findFirst(无 orderBy)有概率
   * 选中旧行,把 starting 行晾成孤儿。
   */
  async insertStarting(
    input: UpsertRunningInput,
    runtimeInstanceId: string,
    transport: string,
    startToken: string
  ): Promise<InsertStartingResult> {
    const where = ownerWhere(
      input.runtimeType,
      input.isolationScope,
      input.ownerId
    );
    await this.prisma.workerInstance.deleteMany({
      where: { ...where, status: { in: ["stopped", "error"] } },
    });
    try {
      await this.prisma.workerInstance.create({
        data: {
          id: generateId(),
          ...where,
          runtimeInstanceId,
          transport,
          startToken,
          status: "starting",
          activeOwnerKey: input.ownerId,
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
      return { ok: true };
    } catch (err) {
      if (!isPrismaUniqueError(err)) throw err;
      const existing = await this.prisma.workerInstance.findFirst({
        where: {
          ownerId: input.ownerId,
          status: { in: ["starting", "running"] },
        },
      });
      if (!existing) throw err;
      return {
        ok: false,
        existing: {
          runtimeInstanceId: existing.runtimeInstanceId,
          status: existing.status,
        },
      };
    }
  }

  async markStoppedByOwner(
    runtimeType: string,
    isolationScope: string,
    ownerId: string
  ) {
    await this.prisma.workerInstance.updateMany({
      where: ownerWhere(runtimeType, isolationScope, ownerId),
      data: {
        status: "stopped",
        activeOwnerKey: null,
        metadata: workerInstanceMetadataJson(
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
    await this.prisma.workerInstance.updateMany({
      where: ownerWhere(runtimeType, isolationScope, ownerId),
      data: {
        status: "error",
        activeOwnerKey: null,
        metadata: workerInstanceMetadataJson(
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

  /**
   * 服务重启后的扫尾用:把所有还卡在 starting 的行标记为 error——这些行代表
   * 上一个(已经不在了的)进程没来得及确认完成的启动尝试,不可能再被确认,
   * 必须清空,否则并发防重唯一索引会把对应 owner 永久卡死(仍待讨论第 13 条)。
   * 不区分 runtimeType:starting 行本身的语义跟放置方式无关。
   */
  async markAllStartingAsError(): Promise<void> {
    await this.prisma.workerInstance.updateMany({
      where: { status: "starting" },
      data: {
        status: "error",
        activeOwnerKey: null,
        metadata: workerInstanceMetadataJson(
          statusInstanceMetadata({
            runtimeType: "",
            isolationScope: "",
            ownerId: "",
            reason: "interrupted_by_restart",
          })
        ),
      },
    });
  }

  /** 按 runtimeType 查找所有 running 状态的行,供重启扫尾用。 */
  findRunningByRuntimeType(runtimeType: string) {
    return this.prisma.workerInstance.findMany({
      where: { runtimeType, status: "running" },
    });
  }

  async findActiveResourceByRuntimeId(
    runtimeType: string,
    runtimeInstanceId: string
  ) {
    const resource = await this.prisma.workerInstance.findUnique({
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
    const binding = await this.prisma.workspaceWorkerBinding.findUnique({
      where: { workspaceId },
      include: { workerInstance: true },
    });
    return (
      binding?.workerInstance.runtimeType === runtimeType &&
      binding.workerInstance.runtimeInstanceId === runtimeInstanceId
    );
  }

  async deleteWorkspaceBinding(workspaceId: string) {
    await this.prisma.workspaceWorkerBinding.deleteMany({
      where: { workspaceId },
    });
  }

  countRunning(): Promise<number> {
    return this.prisma.workerInstance.count({ where: { status: "running" } });
  }

  findByRuntimeId(runtimeType: string, runtimeInstanceId: string) {
    return this.prisma.workerInstance.findUnique({
      where: {
        runtimeType_runtimeInstanceId: { runtimeType, runtimeInstanceId },
      },
    });
  }

  /** 管理端 run 详情用:运行实例视图 + 绑定的 workspace。 */
  findRunInstanceView(runtimeType: string, runtimeInstanceId: string) {
    return this.prisma.workerInstance.findUnique({
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
        workspaceWorkerBindings: {
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
      this.prisma.workerInstance.findMany({
        where,
        include: { workspaceWorkerBindings: true },
        orderBy: { updatedAt: "desc" },
        take: opts.take,
        skip: opts.skip,
      }),
      this.prisma.workerInstance.count({ where }),
    ]);
    return { items, total };
  }

  findById(id: string) {
    return this.prisma.workerInstance.findUnique({ where: { id } });
  }

  /** 绑定 + 资源(不限状态),供生命周期清理判断隔离归属。 */
  findBindingWithResource(workspaceId: string) {
    return this.prisma.workspaceWorkerBinding.findUnique({
      where: { workspaceId },
      include: { workerInstance: true },
    });
  }

  findWorkspaceIdsByUser(userId: string): Promise<{ id: string }[]> {
    return this.prisma.workspace.findMany({
      where: { userId, deletedAt: null },
      select: { id: true },
    });
  }

  findRunningByOwners(ownerIds: string[]) {
    return this.prisma.workerInstance.findMany({
      where: { ownerId: { in: ownerIds }, status: "running" },
    });
  }

  /**
   * 按 activeOwnerKey 查该 owner 当前唯一活跃(starting/running)行,供端点鉴权
   * (startToken)和 fence(runtimeType,判断走 local 还是 sandbox 的物理停止路径)复用。
   */
  findActiveByOwnerId(ownerId: string) {
    return this.prisma.workerInstance.findUnique({
      where: { activeOwnerKey: ownerId },
      select: { startToken: true, runtimeType: true },
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
    await this.prisma.workerInstance.update({
      where: { id: resource.id },
      data: {
        status: "stopped",
        activeOwnerKey: null,
        metadata: workerInstanceMetadataJson(
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
