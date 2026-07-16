import { Injectable } from "@nestjs/common";
import { Prisma } from "../../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service";

/**
 * ModelProvider 领域持久化边界：封装 modelProvider 表的 Prisma 访问。
 *
 * 注意：apiKey 是该领域的核心数据，admin 路径需原样回显，因此不在 Repository 做
 * select 脱敏；脱敏由 Service 的响应序列化按访问者决定。
 */
@Injectable()
export class ModelProviderRepository {
  constructor(private prisma: PrismaService) {}

  findById(id: string) {
    return this.prisma.modelProvider.findUnique({ where: { id } });
  }

  findEnabled(id: string) {
    return this.prisma.modelProvider.findFirst({
      where: { id, isEnabled: true },
    });
  }

  /** 按 API 格式集合查(调用方传入某 agent 声明消费的格式集合)。 */
  findManyByApiFormats(apiFormats: string[], includeDisabled: boolean) {
    return this.prisma.modelProvider.findMany({
      where: {
        apiFormat: { in: apiFormats },
        ...(includeDisabled ? {} : { isEnabled: true }),
      },
      orderBy: { createdAt: "asc" },
    });
  }

  findAll() {
    return this.prisma.modelProvider.findMany({
      orderBy: { createdAt: "asc" },
    });
  }

  findIdByName(opts: {
    scope: string;
    userId: string | null;
    name: string;
    excludeId?: string;
  }): Promise<{ id: string } | null> {
    return this.prisma.modelProvider.findFirst({
      where: {
        scope: opts.scope,
        userId: opts.userId,
        name: opts.name,
        ...(opts.excludeId ? { id: { not: opts.excludeId } } : {}),
      },
      select: { id: true },
    });
  }

  create(data: Prisma.ModelProviderUncheckedCreateInput) {
    return this.prisma.modelProvider.create({ data });
  }

  update(id: string, data: Prisma.ModelProviderUncheckedUpdateInput) {
    return this.prisma.modelProvider.update({ where: { id }, data });
  }

  async delete(id: string): Promise<void> {
    await this.prisma.modelProvider.delete({ where: { id } });
  }
}
