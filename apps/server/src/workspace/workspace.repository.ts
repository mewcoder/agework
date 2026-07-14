import { Injectable } from "@nestjs/common";
import { generateId } from "@agework/shared";
import { Prisma } from "../../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service";

const WORKSPACE_INCLUDE = {
  directory: true,
  runtimeHost: { select: { source: true } },
} as const;

const WORKSPACE_META_INCLUDE = {
  user: { select: { username: true } },
  _count: { select: { conversations: { where: { deletedAt: null } } } },
  directory: true,
  runtimeHost: { select: { source: true } },
} as const;

export type WorkspaceRow = Prisma.WorkspaceGetPayload<{
  include: typeof WORKSPACE_INCLUDE;
}>;

export type WorkspaceMetaRow = Prisma.WorkspaceGetPayload<{
  include: typeof WORKSPACE_META_INCLUDE;
}>;

export type WorkspaceCreateInput = {
  id: string;
  name: string;
  gitUrl?: string;
  gitBranch?: string;
  description: string | null;
  userId: string;
  scope: string;
  /** 执行方式(native/docker/opensandbox),创建时快照写入(Phase 2 expand 列)。 */
  runtimeType: string;
  rootPath: string;
  directorySource: string;
  /** 绑定的 Runtime Host（builtin 或 registered），必填。 */
  runtimeHostId: string;
};

export type WorkspacePatch = {
  name: string;
  description?: string | null;
};

/**
 * Workspace 领域持久化边界：封装 workspace / workspaceDirectory 的 Prisma 访问
 * 与事务。目录绑定唯一性、用户名等关联读取在此集中，避免 Service 注入 Prisma。
 */
@Injectable()
export class WorkspaceRepository {
  constructor(private prisma: PrismaService) {}

  async listAllWithMeta(pagination?: {
    take: number;
    skip: number;
  }): Promise<{ list: WorkspaceMetaRow[]; total: number }> {
    const where = { deletedAt: null };
    if (pagination) {
      const [list, total] = await Promise.all([
        this.prisma.workspace.findMany({
          where,
          include: WORKSPACE_META_INCLUDE,
          orderBy: { createdAt: "desc" },
          take: pagination.take,
          skip: pagination.skip,
        }),
        this.prisma.workspace.count({ where }),
      ]);
      return { list, total };
    }
    const list = await this.prisma.workspace.findMany({
      where,
      include: WORKSPACE_META_INCLUDE,
      orderBy: { createdAt: "desc" },
    });
    return { list, total: list.length };
  }

  listByOwner(userId: string): Promise<WorkspaceRow[]> {
    return this.prisma.workspace.findMany({
      where: { userId, deletedAt: null },
      include: WORKSPACE_INCLUDE,
      orderBy: { createdAt: "desc" },
    });
  }

  createWithDirectory(input: WorkspaceCreateInput): Promise<WorkspaceRow> {
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.workspace.create({
        data: {
          id: input.id,
          name: input.name,
          gitUrl: input.gitUrl,
          gitBranch: input.gitBranch,
          description: input.description,
          userId: input.userId,
          scope: input.scope,
          runtimeType: input.runtimeType,
          runtimeHostId: input.runtimeHostId,
        },
      });
      await tx.workspaceDirectory.create({
        data: {
          id: generateId(),
          workspaceId: created.id,
          rootPath: input.rootPath,
          status: "ready",
          source: input.directorySource,
          metadata: {},
        },
      });
      // 重新查一遍带上 include(directory/runtimeHost),换一次多余往返换回类型一致的
      // WorkspaceRow,不在这里手工拼凑关联字段。
      const row = await tx.workspace.findUniqueOrThrow({
        where: { id: created.id },
        include: WORKSPACE_INCLUDE,
      });
      return row;
    });
  }

  /** 按属主原子更新；不属于该用户或已删除时返回 null，由调用方收敛为 404。 */
  updateOwned(
    userId: string,
    id: string,
    patch: WorkspacePatch
  ): Promise<WorkspaceRow | null> {
    return this.updateWhere({ id, userId, deletedAt: null }, patch);
  }

  /** 管理路径：忽略属主原子更新；不存在或已删除时返回 null。 */
  updateById(id: string, patch: WorkspacePatch): Promise<WorkspaceRow | null> {
    return this.updateWhere({ id, deletedAt: null }, patch);
  }

  private updateWhere(
    where: Prisma.WorkspaceWhereInput & { id: string },
    patch: WorkspacePatch
  ): Promise<WorkspaceRow | null> {
    return this.prisma.$transaction(async (tx) => {
      const workspace = await tx.workspace.findFirst({ where });
      if (!workspace) return null;
      return tx.workspace.update({
        where: { id: where.id },
        data: { name: patch.name, description: patch.description },
        include: WORKSPACE_INCLUDE,
      });
    });
  }

  getOwnedId(userId: string, id: string): Promise<{ id: string } | null> {
    return this.prisma.workspace.findFirst({
      where: { id, userId, deletedAt: null },
      select: { id: true },
    });
  }

  /** run 启动视图：目录 + runtimeHost 配置 + 属主用户名。 */
  findRunView(id: string) {
    return this.prisma.workspace.findFirst({
      where: { id, deletedAt: null },
      include: {
        directory: true,
        user: { select: { username: true } },
        runtimeHost: { select: { source: true } },
      },
    });
  }

  async softDelete(id: string, deletedAt: Date): Promise<void> {
    await this.prisma.workspace.update({ where: { id }, data: { deletedAt } });
  }

  findDirectoryByRootPath(
    rootPath: string
  ): Promise<{ workspaceId: string } | null> {
    return this.prisma.workspaceDirectory.findFirst({
      where: { rootPath },
      select: { workspaceId: true },
    });
  }

  async findUsername(userId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { username: true },
    });
    return user?.username ?? null;
  }
}
