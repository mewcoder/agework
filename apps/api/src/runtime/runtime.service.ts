import { Injectable, NotFoundException } from "@nestjs/common";
import type { RuntimeTarget } from "@agework/shared/protocol";
import { ConfigService } from "../config/config.service";
import { pageWindow } from "../common/dto/pagination-query.dto";
import {
  resolveRuntimeTarget,
  type ResolveRuntimeTargetInput,
  type RuntimeTargetDefaults,
} from "./placement/runtime-resource";
import { RuntimeProviderRegistry } from "./providers/provider-registry";
import { WorkspaceRuntimeInstanceRepository } from "./instances/workspace-runtime-instance.repository";
import { runtimeInstanceDiagnostics } from "./instances/runtime-instance-metadata";

type RuntimeInstanceRow = {
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
};

/**
 * Runtime 层对上层的门面：只负责运行环境——解析 runtime resource、管理 resource 生命周期
 * （shutdown），以及管理端的运行环境视图（policy / stats / resources）。它不拥有「执行」：
 * run execution 的启动与 per-run control 由 runs 层的 ExecutionService 分发给 run executor。
 */
@Injectable()
export class RuntimeService {
  private readonly defaults: RuntimeTargetDefaults;

  constructor(
    private readonly configService: ConfigService,
    private readonly providerRegistry: RuntimeProviderRegistry,
    private readonly repository: WorkspaceRuntimeInstanceRepository
  ) {
    this.defaults = {
      runtimeType: configService.getDefaultRuntimeType(),
      isolationScope: configService.getDefaultIsolationScope(),
      sandboxEngine: configService.getSandboxEngine(),
    };
  }

  /** 从 run 输入解析出目标运行环境（纯计算，不启动 worker）。 */
  resolveRuntimeTarget(input: ResolveRuntimeTargetInput): RuntimeTarget {
    return resolveRuntimeTarget(input, this.defaults);
  }

  /** 停止并删除指定 owner 对应的持久容器/沙箱。 */
  shutdownRuntimeInstance(runtimeType: string, ownerId: string): void {
    this.providerRegistry
      .resolve(runtimeType)
      .shutdownRuntimeInstance?.(ownerId);
  }

  getRuntimePolicy() {
    return {
      runtimeType: this.configService.getDefaultRuntimeType(),
      allowedRuntimeTypes: this.configService.getAllowedRuntimeTypes(),
      isolationScope: this.configService.getDefaultIsolationScope(),
      allowedIsolationScopes: this.configService.getAllowedIsolationScopes(),
      idleTimeoutSeconds: this.configService.getIdleTimeoutSeconds(),
    };
  }

  async getRuntimeStats() {
    return { activeRuntimes: await this.repository.countRunning() };
  }

  async listRuntimeResources(query: {
    status?: string;
    pageNo?: number;
    pageSize?: number;
  }) {
    const { pageNo, pageSize, take, skip } = pageWindow(query);
    const { items, total } = await this.repository.listResourcesPage({
      status: query.status,
      take,
      skip,
    });
    return {
      list: items.map((item) => this.toRuntimeInstanceResponse(item)),
      total,
      pageNo,
      pageSize,
    };
  }

  async stopRuntimeInstance(id: string) {
    const resource = await this.repository.findById(id);
    if (!resource || resource.status !== "running") {
      throw new NotFoundException(
        `Runtime resource ${id} not found or not running`
      );
    }
    this.shutdownRuntimeInstance(resource.runtimeType, resource.ownerId);
    await this.repository.markStoppedById(resource, "manual_stop");
    return { ok: true };
  }

  private toRuntimeInstanceResponse(resource: RuntimeInstanceRow) {
    const diagnostics = runtimeInstanceDiagnostics(resource.metadata);
    const workspaceRuntimes = resource.workspaceRuntimeInstances?.map(
      (binding) => ({
        id: binding.id,
        workspaceId: binding.workspaceId,
        createdAt: this.toIsoString(binding.createdAt),
        updatedAt: this.toIsoString(binding.updatedAt),
      })
    );

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
