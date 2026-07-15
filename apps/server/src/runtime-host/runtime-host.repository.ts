import { Injectable } from "@nestjs/common";
import { generateId } from "@agework/shared";
import type { RuntimeCapabilities } from "@agework/shared/protocol";
import type {
  RuntimeEnvConfig,
  RuntimeHostEnvConfigOverride,
} from "@agework/shared/api";
import { PrismaService } from "../prisma/prisma.service";
import type { RuntimeHostRow } from "./runtime-host.types";

/** RuntimeHost 表(builtin + registered 部署实例)的数据访问唯一入口。tokenHash 只进不出:
 *  按 hash 反查用于隧道鉴权,select 默认挡住该列。 */
@Injectable()
export class RuntimeHostRepository {
  constructor(private readonly prisma: PrismaService) {}

  private readonly rowSelect = {
    id: true,
    name: true,
    source: true,
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
  }): Promise<RuntimeHostRow> {
    return this.prisma.runtimeHost.create({
      data: {
        id: generateId(),
        name: input.name,
        ownerId: input.ownerId,
        tokenHash: input.tokenHash,
      },
      select: this.rowSelect,
    });
  }

  /** builtin 行启动时 upsert:id 固定 "builtin",幂等落完整能力矩阵并置 online。
   *  builtin Host 在 server 进程内，不经隧道，因此 tokenHash 恒为 null。 */
  upsertBuiltin(input: {
    name: string;
    capabilities: RuntimeCapabilities;
    tokenHash: string | null;
  }): Promise<RuntimeHostRow> {
    const shared = {
      capabilities: input.capabilities,
      status: "online",
      tokenHash: input.tokenHash,
    };
    return this.prisma.runtimeHost.upsert({
      where: { id: "builtin" },
      create: {
        id: "builtin",
        name: input.name,
        source: "builtin",
        ownerId: null,
        ...shared,
      },
      update: shared,
      select: this.rowSelect,
    });
  }

  /** 我的（含未注销）+ 全局 builtin 行，供"我的运行环境"列表展示。 */
  listVisibleToOwner(ownerId: string): Promise<RuntimeHostRow[]> {
    return this.prisma.runtimeHost.findMany({
      where: { OR: [{ ownerId }, { ownerId: null }] },
      orderBy: { createdAt: "desc" },
      select: this.rowSelect,
    });
  }

  /** admin: 列出全部 RuntimeHost 行（builtin + 所有用户的 registered），不含已注销。 */
  listAll(): Promise<RuntimeHostRow[]> {
    return this.prisma.runtimeHost.findMany({
      where: { removedAt: null },
      orderBy: [{ source: "asc" }, { createdAt: "desc" }],
      select: this.rowSelect,
    });
  }

  findByTokenHash(tokenHash: string): Promise<RuntimeHostRow | null> {
    return this.prisma.runtimeHost.findUnique({
      where: { tokenHash },
      select: this.rowSelect,
    });
  }

  /** 按 id 查单条（不过滤 owner，admin 场景用）。 */
  findById(id: string): Promise<RuntimeHostRow | null> {
    return this.prisma.runtimeHost.findUnique({
      where: { id },
      select: this.rowSelect,
    });
  }

  /**
   * 按可见性查询单条：属于该 owner，或是全局 builtin 行；不存在/不可见/已注销时返回 null
   * (供上层收敛为 404)。供 workspace 创建时校验目标 RuntimeHost。
   */
  findVisibleToOwner(
    ownerId: string,
    id: string
  ): Promise<RuntimeHostRow | null> {
    return this.prisma.runtimeHost.findFirst({
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
    const { count } = await this.prisma.runtimeHost.updateMany({
      where: { id, ownerId, removedAt: null },
      data: { removedAt: new Date(), name: `${id}-removed` },
    });
    return count > 0;
  }

  /** 注册成功:落能力矩阵/envConfig,置 online 并刷心跳。 */
  async markRegistered(
    id: string,
    capabilities: RuntimeCapabilities,
    envConfig?: RuntimeEnvConfig
  ): Promise<boolean> {
    const { count } = await this.prisma.runtimeHost.updateMany({
      where: { id },
      data: {
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
    override: RuntimeHostEnvConfigOverride
  ): Promise<boolean> {
    const { count } = await this.prisma.runtimeHost.updateMany({
      where: { id },
      data: { envConfigOverride: override },
    });
    return count > 0;
  }

  /** admin 触发重检后，更新 runtimeHost 上报的 envConfig。 */
  async updateEnvConfig(
    id: string,
    envConfig: RuntimeEnvConfig
  ): Promise<boolean> {
    const { count } = await this.prisma.runtimeHost.updateMany({
      where: { id },
      data: { envConfig },
    });
    return count > 0;
  }

  /** 心跳:刷 lastHeartbeatAt。返回 false = 行已被删(撤 token),调用方应断连。 */
  async touchHeartbeat(id: string): Promise<boolean> {
    const { count } = await this.prisma.runtimeHost.updateMany({
      where: { id },
      data: { status: "online", lastHeartbeatAt: new Date() },
    });
    return count > 0;
  }

  async markOffline(id: string): Promise<void> {
    await this.prisma.runtimeHost.updateMany({
      where: { id },
      data: { status: "offline" },
    });
  }

  /** 判死:online 但心跳早于 cutoff 的行标记 offline,返回被判死的 id 列表
   *  (调用方据此回收内存里的半开隧道连接)。 */
  async markStaleOnlineAsOffline(cutoff: Date): Promise<string[]> {
    const stale = await this.prisma.runtimeHost.findMany({
      where: { status: "online", lastHeartbeatAt: { lt: cutoff } },
      select: { id: true },
    });
    if (stale.length === 0) return [];
    const ids = stale.map((row) => row.id);
    await this.prisma.runtimeHost.updateMany({
      // 仍带 stale 守卫:查询到更新之间若有心跳刷新,不误判活着的 runtime。
      where: { id: { in: ids }, status: "online", lastHeartbeatAt: { lt: cutoff } },
      data: { status: "offline" },
    });
    return ids;
  }
}
