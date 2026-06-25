import { Body, Controller, Get, Post, Query, NotFoundException } from "@nestjs/common";
import { Roles } from "../../auth/roles.decorator";
import { ConfigService } from "../../config/config.service";
import { PrismaService } from "../../prisma/prisma.service";
import { RuntimeService } from "../runtime.service";
import { RuntimeResourceIdDto } from "./dto/runtime-resource-id.dto";
import {
  runtimeResourceDiagnostics,
  runtimeResourceMetadataJson,
  stoppedResourceMetadata,
} from "../resources/runtime-resource-metadata";
import { runtimeResourceKeyForOwner } from "../resources/runtime-resource";

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
    return {
      list: items.map((item) => this.toRuntimeResourceResponse(item)),
      total,
      pageNo: pageNum,
      pageSize: take,
    };
  }

  @Post("resources/stop")
  async stopResource(@Body() body: RuntimeResourceIdDto) {
    const { id } = body;
    const resource = await this.prisma.runtimeResource.findUnique({ where: { id } });
    if (!resource || resource.status !== "running") {
      throw new NotFoundException(`Runtime resource ${id} not found or not running`);
    }
    const resourceKey = this.getResourceKey(resource);
    this.runtimeService.shutdownRuntimeResource(
      resource.runtimeType,
      resourceKey
    );
    await this.prisma.runtimeResource.update({
      where: { id },
      data: {
        status: "stopped",
        metadata: runtimeResourceMetadataJson(
          stoppedResourceMetadata({
            runtimeType: resource.runtimeType,
            isolationScope: resource.isolationScope,
            resourceKey,
            reason: "manual_stop",
          })
        ),
      },
    });
    return { ok: true };
  }

  private toRuntimeResourceResponse(resource: {
    id: string;
    runtimeType: string;
    isolationScope: string;
    ownerUserId: string;
    ownerWorkspaceId: string | null;
    runtimeResourceId: string;
    status: string;
    expiresAt: Date | string | null;
    metadata: unknown;
    createdAt: Date | string;
    updatedAt: Date | string;
    workspaceRuntimes?: Array<{
      id: string;
      workspaceId: string;
      createdAt: Date | string;
      updatedAt: Date | string;
    }>;
  }) {
    const resourceKey = runtimeResourceKeyForOwner(resource);
    const diagnostics = runtimeResourceDiagnostics(resource.metadata);
    const workspaceRuntimes = resource.workspaceRuntimes?.map((binding) => ({
      id: binding.id,
      workspaceId: binding.workspaceId,
      createdAt: this.toIsoString(binding.createdAt),
      updatedAt: this.toIsoString(binding.updatedAt),
    }));

    return {
      id: resource.id,
      runtimeType: resource.runtimeType,
      isolationScope: resource.isolationScope,
      ownerUserId: resource.ownerUserId,
      ownerWorkspaceId: resource.ownerWorkspaceId,
      resourceKey,
      runtimeResourceId: resource.runtimeResourceId,
      status: resource.status,
      isReusable: resource.status === "running",
      workspaceCount: workspaceRuntimes?.length ?? 0,
      expiresAt: resource.expiresAt ? this.toIsoString(resource.expiresAt) : null,
      metadata: resource.metadata,
      diagnostics: {
        ...diagnostics,
        resourceKey: diagnostics.resourceKey ?? resourceKey,
        runtimeResourceId:
          diagnostics.runtimeResourceId ?? resource.runtimeResourceId,
      },
      createdAt: this.toIsoString(resource.createdAt),
      updatedAt: this.toIsoString(resource.updatedAt),
      workspaceRuntimes,
    };
  }

  private toIsoString(value: Date | string): string {
    return value instanceof Date ? value.toISOString() : value;
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
