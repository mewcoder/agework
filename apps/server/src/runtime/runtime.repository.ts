import { Injectable } from "@nestjs/common";
import { generateId } from "@agework/shared";
import type { RuntimeCapabilities } from "@agework/shared/protocol";
import { PrismaService } from "../prisma/prisma.service";

export type RuntimeRow = {
  id: string;
  name: string;
  kind: string;
  runtimeType: string | null;
  ownerId: string;
  status: string;
  lastHeartbeatAt: Date | null;
  createdAt: Date;
  capabilities: unknown;
};

/** Runtime 表(Registered 部署实例)的数据访问唯一入口。tokenHash 只进不出:
 *  按 hash 反查用于隧道鉴权,select 默认挡住该列。 */
@Injectable()
export class RuntimeRepository {
  constructor(private readonly prisma: PrismaService) {}

  private readonly rowSelect = {
    id: true,
    name: true,
    kind: true,
    runtimeType: true,
    ownerId: true,
    status: true,
    lastHeartbeatAt: true,
    createdAt: true,
    capabilities: true,
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

  listByOwner(ownerId: string): Promise<RuntimeRow[]> {
    return this.prisma.runtime.findMany({
      where: { ownerId },
      orderBy: { createdAt: "desc" },
      select: this.rowSelect,
    });
  }

  findByTokenHash(tokenHash: string): Promise<RuntimeRow | null> {
    return this.prisma.runtime.findUnique({
      where: { tokenHash },
      select: this.rowSelect,
    });
  }

  /** 按 owner 范围删除,返回是否真的删掉(false = 不存在或不属于该 owner)。 */
  async deleteByOwner(ownerId: string, id: string): Promise<boolean> {
    const { count } = await this.prisma.runtime.deleteMany({
      where: { id, ownerId },
    });
    return count > 0;
  }

  /** 注册成功:落 runtimeType/能力矩阵,置 online 并刷心跳。 */
  async markRegistered(
    id: string,
    runtimeType: string,
    capabilities: RuntimeCapabilities
  ): Promise<boolean> {
    const { count } = await this.prisma.runtime.updateMany({
      where: { id },
      data: {
        runtimeType,
        capabilities,
        status: "online",
        lastHeartbeatAt: new Date(),
      },
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
