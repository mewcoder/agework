import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

export type SystemSettingRow = {
  key: string;
  value: string;
};

/**
 * 系统设置持久化边界：封装 systemSetting 表的 Prisma 访问。
 * ConfigService 经此读写 DB 设置项，不直接持有 PrismaService。
 */
@Injectable()
export class SystemSettingRepository {
  constructor(private prisma: PrismaService) {}

  loadAll(): Promise<SystemSettingRow[]> {
    return this.prisma.systemSetting.findMany();
  }

  findKey(key: string): Promise<{ key: string } | null> {
    return this.prisma.systemSetting.findUnique({
      where: { key },
      select: { key: true },
    });
  }

  async seedDefault(key: string, value: string): Promise<void> {
    await this.prisma.systemSetting.create({ data: { key, value } });
  }

  async upsert(key: string, value: string, updatedBy: string): Promise<void> {
    await this.prisma.systemSetting.upsert({
      where: { key },
      create: { key, value, updatedBy },
      update: { value, updatedBy },
    });
  }

  async deleteByKey(key: string): Promise<void> {
    await this.prisma.systemSetting.deleteMany({ where: { key } });
  }
}
