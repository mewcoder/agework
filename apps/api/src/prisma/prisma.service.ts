import { Injectable, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { PrismaClient } from "../../generated/prisma/client.js";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

// 切换到 PostgreSQL 时：
// 1. 将 schema.prisma 中 datasource.provider 改为 "postgresql"
// 2. 将此文件中的 adapter 替换为：
//    import { PrismaPg } from '@prisma/adapter-pg';
//    const adapter = new PrismaPg({ connectionString: process.env.AGEWORK_PRIVATE_DATABASE_URL });

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    const adapter = new PrismaBetterSqlite3({
      url: process.env.AGEWORK_PRIVATE_DATABASE_URL || "file:./dev.db",
    });
    super({ adapter });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
