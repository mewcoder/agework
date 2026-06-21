import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class WorkspaceDirectoryService {
  constructor(private prisma: PrismaService) {}

  async create(workspaceId: string, rootPath: string) {
    return this.prisma.workspaceDirectory.create({
      data: {
        workspaceId,
        rootPath,
        status: "ready",
        source: "managed",
        metadata: {},
      },
    });
  }
}
