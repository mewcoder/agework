import { Body, Controller, Get, Post, Query, NotFoundException } from "@nestjs/common";
import { Roles } from "../../auth/roles.decorator";
import { ConfigService } from "../../config/config.service";
import { PrismaService } from "../../prisma/prisma.service";
import { RuntimeProviderRegistry } from "../providers/runtime-provider-registry";
import { RuntimeResourceIdDto } from "./dto/runtime-resource-id.dto";

@Controller("admin/runtime")
@Roles("admin")
export class AdminRuntimeController {
  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly runtimeProviderRegistry: RuntimeProviderRegistry,
  ) {}

  @Get("policy")
  getRuntimePolicy() {
    return {
      runtimeType: this.configService.getDefaultRuntimeType(),
      allowedRuntimeTypes: this.configService.getAllowedRuntimeTypes(),
      isolationScope: this.configService.getDefaultIsolationScope(),
      allowedIsolationScopes:
        this.configService.getAllowedIsolationScopes(),
      idleTimeoutSeconds: this.configService.getIdleTimeoutSeconds(),
    };
  }

  @Get("stats")
  async getRuntimeStats() {
    const activeResources = await this.prisma.runtimeResource.count({
      where: { status: "running" },
    });
    return { activeRuntimes: activeResources };
  }

  @Get("resources")
  async listResources(
    @Query("status") status?: string,
    @Query("pageNo") pageNo?: string,
    @Query("pageSize") pageSize?: string,
  ) {
    const take = Math.min(Math.max(Number(pageSize) || 10, 1), 100);
    const pageNum = Math.max(Number(pageNo) || 1, 1);
    const where = status ? { status } : {};
    const [items, total] = await Promise.all([
      this.prisma.runtimeResource.findMany({
        where,
        include: { workspaceRuntimes: true },
        orderBy: { updatedAt: "desc" },
        take,
        skip: (pageNum - 1) * take,
      }),
      this.prisma.runtimeResource.count({ where }),
    ]);
    return { list: items, total, pageNo: pageNum, pageSize: take };
  }

  @Post("resources/stop")
  async stopResource(@Body() body: RuntimeResourceIdDto) {
    const { id } = body;
    const resource = await this.prisma.runtimeResource.findUnique({ where: { id } });
    if (!resource || resource.status !== "running") {
      throw new NotFoundException(`Runtime resource ${id} not found or not running`);
    }
    const resourceKey = this.getResourceKey(resource);
    this.runtimeProviderRegistry
      .resolve(resource.runtimeType)
      .shutdownRuntimeResource?.(resourceKey);
    await this.prisma.runtimeResource.update({
      where: { id },
      data: { status: "stopped" },
    });
    return { ok: true };
  }

  private getResourceKey(resource: {
    isolationScope: string;
    ownerUserId: string;
    ownerWorkspaceId: string | null;
  }): string {
    if (resource.isolationScope === "user") {
      return resource.ownerUserId;
    }
    return resource.ownerWorkspaceId ?? resource.ownerUserId;
  }
}
