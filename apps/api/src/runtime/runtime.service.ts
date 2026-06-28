import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import type {
  CommandPayload,
  RuntimeTarget,
  WorkerExecutionHandle,
  WorkerExecutionStartInput,
} from "@agework/shared/protocol";
import type { AdminRunRuntimeInstanceResponse } from "@agework/shared/api";
import { ConfigService } from "../config/config.service";
import { pageWindow } from "../common/dto/pagination-query.dto";
import { swallow } from "../common/swallow";
import {
  resolveRuntimeTarget,
  type ResolveRuntimeTargetInput,
  type RuntimeTargetDefaults,
} from "./placement/runtime-resource";
import { RuntimeProviderRegistry } from "./providers/provider-registry";
import type { RuntimeOwnerSessionCleanup } from "./providers/provider-contracts";
import {
  SandboxWorkerExecutor,
  type SandboxWorkerEventSink,
} from "./sandbox/sandbox-worker.executor";
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
  private readonly logger = new Logger(RuntimeService.name);
  private readonly defaults: RuntimeTargetDefaults;

  constructor(
    private readonly configService: ConfigService,
    private readonly providerRegistry: RuntimeProviderRegistry,
    private readonly repository: WorkspaceRuntimeInstanceRepository,
    private readonly sandboxWorker: SandboxWorkerExecutor
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

  /**
   * 注册 sandbox runtime owner 会话清理回调：runtime owner 资源释放时，
   * 上层（worker-host）据此清理该 owner 的 worker command session。
   * 由 run 启动期一次性接线；run 层经此门面接入，不直接持有 provider registry。
   */
  setSandboxOwnerSessionCleanup(cleanup: RuntimeOwnerSessionCleanup): void {
    this.providerRegistry.resolve("sandbox").setOwnerSessionCleanup?.(cleanup);
  }

  // ── sandbox per-run 执行门面 ──────────────────────────────────────────
  // run 层的 SandboxRunExecutor 只经下列方法驱动 sandbox 执行，不直接持有
  // SandboxWorkerExecutor / SandboxRuntimeInstanceService 等 runtime 内部 provider。

  /** 注入 sandbox 执行回流端口（run 的 RunEventReceiver 结构上满足）。 */
  setSandboxWorkerEventSink(sink: SandboxWorkerEventSink): void {
    this.sandboxWorker.setEventSink(sink);
  }

  /** 启动一次 sandbox run：绑定 runtime owner、打开 worker session、attach/start 实例。 */
  startSandboxWorker(input: WorkerExecutionStartInput): WorkerExecutionHandle {
    return this.sandboxWorker.start(input);
  }

  /** 向 sandbox run 下发命令。 */
  sendSandboxCommand(
    handle: WorkerExecutionHandle,
    command: CommandPayload
  ): void {
    this.sandboxWorker.sendCommand(handle, command);
  }

  /** 取消 sandbox run（不停止可复用的 runtime 实例）。 */
  cancelSandboxRun(handle: WorkerExecutionHandle): void {
    this.sandboxWorker.cancel(handle);
  }

  /** 强制终止 sandbox run 执行会话。 */
  terminateSandboxRun(runId: string, reason: string): void {
    this.sandboxWorker.terminateExecution(runId, reason);
  }

  /** 清理 sandbox run 级资源（不停止 runtime 实例）。 */
  cleanupSandboxRun(runId: string): void {
    this.sandboxWorker.cleanup(runId);
  }

  /** 服务重启后清理中断 sandbox 执行的残留 runtime 实例。 */
  recoverSandboxOrphan(runtimeInstanceId: string): Promise<void> {
    return this.sandboxWorker.cleanupInterruptedExecution(runtimeInstanceId);
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

  /**
   * 管理端 run 详情用：按 run 持久化的 runtime handle 取运行实例视图。
   * runtime 资源归属本领域，run 层经此方法获取，不直接查 runtimeInstance 表。
   */
  async getRunInstanceView(
    runtimeType: string,
    runtimeInstanceId: string
  ): Promise<AdminRunRuntimeInstanceResponse | null> {
    const record = await this.repository.findRunInstanceView(
      runtimeType,
      runtimeInstanceId
    );
    if (!record) return null;
    const { workspaceRuntimeInstances, ...resource } = record;
    return {
      ...resource,
      expiresAt: resource.expiresAt
        ? this.toIsoString(resource.expiresAt)
        : null,
      createdAt: this.toIsoString(resource.createdAt),
      updatedAt: this.toIsoString(resource.updatedAt),
      workspaceRuntimes: workspaceRuntimeInstances.map((binding) => ({
        id: binding.id,
        workspaceId: binding.workspaceId,
        createdAt: this.toIsoString(binding.createdAt),
        updatedAt: this.toIsoString(binding.updatedAt),
      })),
    };
  }

  /** 该 runtime instance 是否为 user 级共享隔离（决定中断 run 是否可清理底层资源）。 */
  async isRuntimeInstanceUserScoped(
    runtimeType: string,
    runtimeInstanceId: string
  ): Promise<boolean> {
    const resource = await this.repository.findByRuntimeId(
      runtimeType,
      runtimeInstanceId
    );
    return resource?.isolationScope === "user";
  }

  /**
   * 服务重启后内存 scope 状态已丢失：把仍标记 running 的资源视为孤儿并停止底层容器/沙箱。
   * user 级资源在属主用户仍存在时保留，用户已删除的一并清理；清理后标记 stopped。
   */
  async recoverOrphanRuntimeInstances(): Promise<void> {
    try {
      const running = await this.repository.findAllRunning();
      if (running.length === 0) {
        this.logger.log("No orphan runtime resources found.");
        return;
      }
      this.logger.warn(
        `Found ${running.length} orphan runtime resource(s) — stopping them`
      );

      for (const resource of running) {
        if (resource.isolationScope === "user") {
          const ownerExists = await this.repository.userExists(
            resource.ownerId
          );
          if (ownerExists) {
            this.logger.log(
              `Skipping recoverOrphan for user-scope runtime resource ${resource.runtimeInstanceId} (user ${resource.ownerId} still exists)`
            );
            continue;
          }
          this.logger.log(
            `User ${resource.ownerId} no longer exists — cleaning up orphan user-scope resource ${resource.runtimeInstanceId}`
          );
        }

        const provider = this.providerRegistry.resolve(resource.runtimeType);
        await provider
          .recoverOrphan(resource.runtimeInstanceId)
          .catch(
            swallow(
              this.logger,
              `cleanup interrupted runtime resource ${resource.runtimeInstanceId}`
            )
          );
        await this.repository.markStoppedById(resource, "orphan_recovered");
      }
    } catch (err) {
      this.logger.warn(
        `Failed to recover orphan containers: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /** 清理已明确标记为 stale 的 runtime 资源（running 资源可能仍在外部存活，不在此清理）。 */
  async cleanupStaleRuntimeInstances(): Promise<void> {
    try {
      const result = await this.repository.deleteStaleResources();
      if (result.count > 0) {
        this.logger.log(`Deleted ${result.count} stale runtime resource(s)`);
      }
    } catch (err) {
      this.logger.warn(
        `Failed to cleanup stale runtime resources: ${err instanceof Error ? err.message : String(err)}`
      );
    }
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
      expiresAt: resource.expiresAt
        ? this.toIsoString(resource.expiresAt)
        : null,
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
