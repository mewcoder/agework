import { Injectable } from "@nestjs/common";
import { generateId } from "@agework/shared";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class WorkspaceDirectoryService {
  constructor(private prisma: PrismaService) {}

  async create(workspaceId: string, rootPath: string) {
    return this.prisma.workspaceDirectory.create({
      data: {
        id: generateId(),
        workspaceId,
        rootPath,
        status: "ready",
        source: "managed",
        metadata: {},
      },
    });
  }
}
