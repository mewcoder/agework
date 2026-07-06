import { Injectable } from "@nestjs/common";
import { generateId } from "@agework/shared";
import type { RuntimeCapabilities } from "@agework/shared/protocol";
import type { RuntimeEnvConfig, RuntimeEnvConfigOverride } from "@agework/shared/api";
import { PrismaService } from "../prisma/prisma.service";

export type RuntimeRow = {
  id: string;
  name: string;
  source: string;
  runtimeType: string | null;
  ownerId: string | null;
  status: string;
  lastHeartbeatAt: Date | null;
  createdAt: Date;
  capabilities: unknown;
  envConfig: unknown;
  envConfigOverride: unknown;
  removedAt: Date | null;
};

/** Runtime 表(builtin + Registered 部署实例)的数据访问唯一入口。tokenHash 只进不出:
 *  按 hash 反查用于隧道鉴权,select 默认挡住该列。 */
@Injectable()
export class RuntimeRepository {
  constructor(private readonly prisma: PrismaService) {}

  private readonly rowSelect = {
    id: true,
    name: true,
    source: true,
    runtimeType: true,
    ownerId: true,
    status: true,
    lastHeartbeatAt: true,
    createdAt: true,
    capabilities: true,
    envConfig: true,
    envConfigOverride: true,
    removedAt: true,
  } as const;

  create(input: {
    ownerId: string;
    name: string;
    tokenHash: string;
  }): Promise<RuntimeRow> {
    return this.prisma.runtime.create({
      data: {
        id: generateId(),
        name: input.name,
        ownerId: input.ownerId,
        tokenHash: input.tokenHash,
      },
      select: this.rowSelect,
    });
  }

  /** builtin 行启动时 upsert:id 固定,by-id 幂等落 runtimeType/capabilities/online。 */
  upsertBuiltin(input: {
    id: string;
    name: string;
    runtimeType: string;
    capabilities: RuntimeCapabilities;
  }): Promise<RuntimeRow> {
    const shared = {
      runtimeType: input.runtimeType,
      capabilities: input.capabilities,
      status: "online",
    };
    return this.prisma.runtime.upsert({
      where: { id: input.id },
      create: {
        id: input.id,
        name: input.name,
        source: "builtin",
        ownerId: null,
        tokenHash: null,
        ...shared,
      },
      update: shared,
      select: this.rowSelect,
    });
  }

  /** 我的（含未注销）+ 全局 builtin 行，供"我的运行环境"列表展示。 */
  listVisibleToOwner(ownerId: string): Promise<RuntimeRow[]> {
    return this.prisma.runtime.findMany({
      where: { OR: [{ ownerId }, { ownerId: null }] },
      orderBy: { createdAt: "desc" },
      select: this.rowSelect,
    });
  }

  /** admin: 列出全部 Runtime 行（builtin + 所有用户的 registered），不含已注销。 */
  listAll(): Promise<RuntimeRow[]> {
    return this.prisma.runtime.findMany({
      where: { removedAt: null },
      orderBy: [{ source: "asc" }, { createdAt: "desc" }],
      select: this.rowSelect,
    });
  }

  findByTokenHash(tokenHash: string): Promise<RuntimeRow | null> {
    return this.prisma.runtime.findUnique({
      where: { tokenHash },
      select: this.rowSelect,
    });
  }

  /** 按 id 查单条（不过滤 owner，admin 场景用）。 */
  findById(id: string): Promise<RuntimeRow | null> {
    return this.prisma.runtime.findUnique({
      where: { id },
      select: this.rowSelect,
    });
  }

  /**
   * 按可见性查询单条：属于该 owner，或是全局 builtin 行；不存在/不可见/已注销时返回 null
   * (供上层收敛为 404)。供 workspace 创建时校验目标 Runtime。
   */
  findVisibleToOwner(ownerId: string, id: string): Promise<RuntimeRow | null> {
    return this.prisma.runtime.findFirst({
      where: { id, OR: [{ ownerId }, { ownerId: null }], removedAt: null },
      select: this.rowSelect,
    });
  }

  /**
   * 注销（软删除）：只能注销属于该 owner 的行（builtin 行 ownerId=null，天然不会匹配
   * 任何真实 userId，无需额外判断）。name 打散腾出原名，行本身永久保留。
   * 返回是否真的注销了(false = 不存在/不属于该 owner/已经注销过)。
   */
  async revokeByOwner(ownerId: string, id: string): Promise<boolean> {
    const { count } = await this.prisma.runtime.updateMany({
      where: { id, ownerId, removedAt: null },
      data: { removedAt: new Date(), name: `${id}-removed` },
    });
    return count > 0;
  }

  /** 注册成功:落 runtimeType/能力矩阵/envConfig,置 online 并刷心跳。 */
  async markRegistered(
    id: string,
    runtimeType: string,
    capabilities: RuntimeCapabilities,
    envConfig?: RuntimeEnvConfig
  ): Promise<boolean> {
    const { count } = await this.prisma.runtime.updateMany({
      where: { id },
      data: {
        runtimeType,
        capabilities,
        ...(envConfig ? { envConfig } : {}),
        status: "online",
        lastHeartbeatAt: new Date(),
      },
    });
    return count > 0;
  }

  /** admin 覆盖 envConfig（per-agent 合并写入）。 */
  async updateEnvConfigOverride(
    id: string,
    override: RuntimeEnvConfigOverride
  ): Promise<boolean> {
    const { count } = await this.prisma.runtime.updateMany({
      where: { id },
      data: { envConfigOverride: override },
    });
    return count > 0;
  }

  /** admin 触发重检后，更新 runtime 上报的 envConfig。 */
  async updateEnvConfig(
    id: string,
    envConfig: RuntimeEnvConfig
  ): Promise<boolean> {
    const { count } = await this.prisma.runtime.updateMany({
      where: { id },
      data: { envConfig },
    });
    return count > 0;
  }

  /** 心跳:刷 lastHeartbeatAt。返回 false = 行已被删(撤 token),调用方应断连。 */
  async touchHeartbeat(id: string): Promise<boolean> {
    const { count } = await this.prisma.runtime.updateMany({
      where: { id },
      data: { status: "online", lastHeartbeatAt: new Date() },
    });
    return count > 0;
  }

  async markOffline(id: string): Promise<void> {
    await this.prisma.runtime.updateMany({
      where: { id },
      data: { status: "offline" },
    });
  }

  /** 判死:online 但心跳早于 cutoff 的行标记 offline,返回条数。 */
  async markStaleOnlineAsOffline(cutoff: Date): Promise<number> {
    const { count } = await this.prisma.runtime.updateMany({
      where: { status: "online", lastHeartbeatAt: { lt: cutoff } },
      data: { status: "offline" },
    });
    return count;
  }
}
