import { Injectable } from "@nestjs/common";
import { generateId } from "@agework/shared";
import { PrismaService } from "../../prisma/prisma.service";
import {
  runtimeInstanceMetadataJson,
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
 * 以及实例本身的生命周期数据。数据表继续叫 RuntimeInstance/WorkspaceRuntimeInstance
 * (不改名),只是 repository 归属从 runtime 模块搬到 worker-manager 模块——WorkerRegistry
 * 数据天然是 worker-manager 自注册/心跳端点要读写的东西,归 runtime 会导致 worker-manager
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
      const existing = await tx.runtimeInstance.findFirst({ where });
      const data = {
        runtimeInstanceId,
        transport,
        status: "running",
        expiresAt: null,
        metadata: runtimeInstanceMetadataJson(
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
          where: { workspaceId: input.workspaceId },
          create: {
            id: generateId(),
            workspaceId: input.workspaceId,
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

  /**
   * 冷启动前插入一条 starting 记录,靠 Phase 1 建好的 partial unique index
   * (runtime_instance_active_owner_idx,ON ownerId WHERE status IN
   * ('starting','running'))做并发防重。撞见冲突时返回已存在的活跃行,由
   * 调用方决定是复用还是报错(sandbox/local 的策略不同,不在这一层判断)。
   * 插入前先删掉该 owner 名下的历史终态行(stopped/error),避免它们跟新插入的
   * starting 行同时存在导致 upsertRunning 后续的 findFirst(无 orderBy)有概率
   * 选中旧行,把 starting 行晾成孤儿。
   */
  async insertStarting(
    input: UpsertRunningInput,
    runtimeInstanceId: string,
    transport: string
  ): Promise<InsertStartingResult> {
    const where = ownerWhere(
      input.runtimeType,
      input.isolationScope,
      input.ownerId
    );
    await this.prisma.runtimeInstance.deleteMany({
      where: { ...where, status: { in: ["stopped", "error"] } },
    });
    try {
      await this.prisma.runtimeInstance.create({
        data: {
          id: generateId(),
          ...where,
          runtimeInstanceId,
          transport,
          status: "starting",
          metadata: runtimeInstanceMetadataJson(
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
      const existing = await this.prisma.runtimeInstance.findFirst({
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

  /**
   * 服务重启后的扫尾用:把所有还卡在 starting 的行标记为 error——这些行代表
   * 上一个(已经不在了的)进程没来得及确认完成的启动尝试,不可能再被确认,
   * 必须清空,否则并发防重唯一索引会把对应 owner 永久卡死(仍待讨论第 13 条)。
   * 不区分 runtimeType:starting 行本身的语义跟放置方式无关。
   */
  async markAllStartingAsError(): Promise<void> {
    await this.prisma.runtimeInstance.updateMany({
      where: { status: "starting" },
      data: {
        status: "error",
        metadata: runtimeInstanceMetadataJson(
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
    return this.prisma.runtimeInstance.findMany({
      where: { runtimeType, status: "running" },
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
