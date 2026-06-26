import { Body, Controller, Get, Post, Query, NotFoundException } from "@nestjs/common";
import { Roles } from "../../auth/roles.decorator";
import { ConfigService } from "../../config/config.service";
import { PrismaService } from "../../prisma/prisma.service";
import { RuntimeService } from "../runtime.service";
import { RuntimeInstanceIdDto } from "./dto/runtime-instance-id.dto";
import {
  runtimeInstanceDiagnostics,
  runtimeInstanceMetadataJson,
  stoppedInstanceMetadata,
} from "../resources/runtime-instance-metadata";

@Controller("admin/runtime")
@Roles("admin")
export class AdminRuntimeController {
  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly runtimeService: RuntimeService,
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
    const activeResources = await this.prisma.runtimeInstance.count({
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
      this.prisma.runtimeInstance.findMany({
        where,
        include: { workspaceRuntimeInstances: true },
        orderBy: { updatedAt: "desc" },
        take,
        skip: (pageNum - 1) * take,
      }),
      this.prisma.runtimeInstance.count({ where }),
    ]);
    return {
      list: items.map((item) => this.toRuntimeInstanceResponse(item)),
      total,
      pageNo: pageNum,
      pageSize: take,
    };
  }

  @Post("resources/stop")
  async stopResource(@Body() body: RuntimeInstanceIdDto) {
    const { id } = body;
    const resource = await this.prisma.runtimeInstance.findUnique({ where: { id } });
    if (!resource || resource.status !== "running") {
      throw new NotFoundException(`Runtime resource ${id} not found or not running`);
    }
    this.runtimeService.shutdownRuntimeInstance(
      resource.runtimeType,
      resource.ownerId
    );
    await this.prisma.runtimeInstance.update({
      where: { id },
      data: {
        status: "stopped",
        metadata: runtimeInstanceMetadataJson(
          stoppedInstanceMetadata({
            runtimeType: resource.runtimeType,
            isolationScope: resource.isolationScope,
            ownerId: resource.ownerId,
            reason: "manual_stop",
          })
        ),
      },
    });
    return { ok: true };
  }

  private toRuntimeInstanceResponse(resource: {
    id: string;
    runtimeType: string;
    isolationScope: string;
    ownerId: string;
    runtimeInstanceId: string;
    status: string;
    expiresAt: Date | string | null;
    metadata: unknown;
    createdAt: Date | string;
    updatedAt: Date | string;
    workspaceRuntimeInstances?: Array<{
      id: string;
      workspaceId: string;
      createdAt: Date | string;
      updatedAt: Date | string;
    }>;
  }) {
    const diagnostics = runtimeInstanceDiagnostics(resource.metadata);
    const workspaceRuntimes = resource.workspaceRuntimeInstances?.map((binding) => ({
      id: binding.id,
      workspaceId: binding.workspaceId,
      createdAt: this.toIsoString(binding.createdAt),
      updatedAt: this.toIsoString(binding.updatedAt),
    }));

    return {
      id: resource.id,
      runtimeType: resource.runtimeType,
      isolationScope: resource.isolationScope,
      ownerId: resource.ownerId,
      runtimeInstanceId: resource.runtimeInstanceId,
      status: resource.status,
      isReusable: resource.status === "running",
      workspaceCount: workspaceRuntimes?.length ?? 0,
      expiresAt: resource.expiresAt ? this.toIsoString(resource.expiresAt) : null,
      metadata: resource.metadata,
      diagnostics: {
        ...diagnostics,
        ownerId: diagnostics.ownerId ?? resource.ownerId,
        runtimeInstanceId:
          diagnostics.runtimeInstanceId ?? resource.runtimeInstanceId,
      },
      createdAt: this.toIsoString(resource.createdAt),
      updatedAt: this.toIsoString(resource.updatedAt),
      workspaceRuntimes,
    };
  }

  private toIsoString(value: Date | string): string {
    return value instanceof Date ? value.toISOString() : value;
  }
}
