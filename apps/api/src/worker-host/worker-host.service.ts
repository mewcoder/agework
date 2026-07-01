import { Injectable, NotFoundException } from "@nestjs/common";
import type {
  AcquireInstanceResult,
  CommandPayload,
  RunConfig,
  WorkerCommandRpcRequest,
  WorkerExecutionStartInput,
} from "@agework/shared/protocol";
import type { AdminRunRuntimeInstanceResponse } from "@agework/shared/api";
import { WorkerCommandDispatcher } from "./command/command-dispatcher.service";
import { WorkerUpstreamRegistry } from "./upstream/worker-upstream.registry";
import { WorkerEndpointHandler } from "./worker-endpoint.handler";
import type { WorkerUpstreamPort } from "./worker-host.types";
import { WorkerRegistryRepository } from "./registry/worker-registry.repository";
import { runtimeInstanceDiagnostics } from "./registry/worker-registry-metadata";
import { pageWindow } from "../common/dto/pagination-query.dto";
import { RuntimeService } from "../runtime/runtime.service";
import { SandboxInstanceExecutor } from "./sandbox/sandbox-instance.executor";

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

@Injectable()
export class WorkerHostService {
  constructor(
    private readonly endpointHandler: WorkerEndpointHandler,
    private readonly upstream: WorkerUpstreamRegistry,
    private readonly commandDispatcher: WorkerCommandDispatcher,
    private readonly registry: WorkerRegistryRepository,
    private readonly runtimeService: RuntimeService,
    private readonly sandboxInstances: SandboxInstanceExecutor
  ) {}

  async pollCommands(
    ownerId: string,
    query: { afterSeq?: number; waitMs?: number }
  ): Promise<{ messages: WorkerCommandRpcRequest[] }> {
    return this.endpointHandler.pollCommands(ownerId, query);
  }

  getRunConfig(runId: string): { config: RunConfig } {
    return this.endpointHandler.getRunConfig(runId);
  }

  async postEvent(runId: string, body: unknown): Promise<{ ok: boolean }> {
    return this.endpointHandler.postEvent(runId, body);
  }

  openSession(params: {
    runId: string;
    ownerId: string;
    runConfig: RunConfig;
  }): void {
    this.commandDispatcher.openSession(params);
  }

  sendCommand(ownerId: string, runId: string, command: CommandPayload): void {
    this.commandDispatcher.sendCommand(ownerId, runId, command);
  }

  cleanupRun(runId: string): void {
    this.commandDispatcher.cleanupRun(runId);
  }

  cleanupByOwnerId(ownerId: string): void {
    this.commandDispatcher.cleanupByOwnerId(ownerId);
  }

  setUpstreamPort(receiver: WorkerUpstreamPort): void {
    this.upstream.setUpstreamPort(receiver);
  }

  // ── WorkerRegistry 透传方法 ──────────────────────────────────────────
  // WorkerRegistry 数据(RuntimeInstance/WorkspaceRuntimeInstance 表)归属 worker-host,
  // 这里是唯一对外入口;这批方法目前是 1:1 透传原 repository 方法,是 Phase 1(纯粹的
  // 归属搬家)的产物——后续 resolveInstance() 落地后,部分方法可能会被更贴合业务语义
  // 的编排方法取代,不代表这是最终形态。

  /** 查询某个 workspace 当前绑定的活跃(running)runtime 资源。 */
  findActiveRuntimeByWorkspace(workspaceId: string) {
    return this.registry.findActiveByWorkspace(workspaceId);
  }

  /** 按 owner 把 runtime 资源标记为 error。 */
  markRuntimeErrorByOwner(
    runtimeType: string,
    isolationScope: string,
    ownerId: string,
    errorMessage: string
  ) {
    return this.registry.markErrorByOwner(
      runtimeType,
      isolationScope,
      ownerId,
      errorMessage
    );
  }

  /** 统计当前 running 状态的 runtime 资源数量,供 admin 概览用。 */
  countRunningRuntimes() {
    return this.registry.countRunning();
  }

  /** 按 (runtimeType, runtimeInstanceId) 查找 runtime 资源行。 */
  findRuntimeByRuntimeId(runtimeType: string, runtimeInstanceId: string) {
    return this.registry.findByRuntimeId(runtimeType, runtimeInstanceId);
  }

  /** 管理端 run 详情用:运行实例视图 + 绑定的 workspace 列表。 */
  findRuntimeInstanceView(runtimeType: string, runtimeInstanceId: string) {
    return this.registry.findRunInstanceView(runtimeType, runtimeInstanceId);
  }

  /** 管理端分页列出 runtime 资源。 */
  listRuntimeResourcesPage(opts: {
    status?: string;
    take: number;
    skip: number;
  }) {
    return this.registry.listResourcesPage(opts);
  }

  /** 按主键查找 runtime 资源行。 */
  findRuntimeById(id: string) {
    return this.registry.findById(id);
  }

  /** 查找某个 workspace 的绑定关系 + 资源(不限状态),供生命周期清理用。 */
  findRuntimeBindingWithResource(workspaceId: string) {
    return this.registry.findBindingWithResource(workspaceId);
  }

  /** 查找某个用户名下所有(未删除)workspace 的 id 列表。 */
  findWorkspaceIdsByUser(userId: string) {
    return this.registry.findWorkspaceIdsByUser(userId);
  }

  /** 按 ownerId 列表查找当前 running 的 runtime 资源。 */
  findRunningRuntimesByOwners(ownerIds: string[]) {
    return this.registry.findRunningByOwners(ownerIds);
  }

  /** 按主键把 runtime 资源标记为 stopped 并写入停机原因。 */
  markRuntimeStoppedById(
    resource: {
      id: string;
      runtimeType: string;
      isolationScope: string;
      ownerId: string;
    },
    reason: string
  ) {
    return this.registry.markStoppedById(resource, reason);
  }

  /** 删除某个 workspace 的 runtime 绑定关系。 */
  deleteRuntimeWorkspaceBinding(workspaceId: string) {
    return this.registry.deleteWorkspaceBinding(workspaceId);
  }

  /** 把 RuntimeInstance 的 metadata JSON 转成结构化诊断信息,供 admin 展示用。 */
  buildRuntimeDiagnostics(metadata: unknown) {
    return runtimeInstanceDiagnostics(metadata);
  }

  // ── sandbox 实例编排(owner 复用/idle 决策在 worker-host,物理操作转发 runtime) ──
  // 原 RuntimeService.acquireInstanceForRun 等方法随 SandboxInstanceExecutor 一起
  // 搬过来:owner 是否已有活实例、要不要新建/复用/idle 回收,是 worker-host 自己的
  // WorkerRegistry 数据决定的编排决策,不应该反过来让 runtime 依赖 worker-host。

  /** 为一次 sandbox run 取得持久容器实例,ready/cancelledBeforeReady/error 一次性回传。 */
  acquireSandboxInstanceForRun(
    input: WorkerExecutionStartInput
  ): Promise<AcquireInstanceResult> {
    return this.sandboxInstances.acquireInstanceForRun(input);
  }

  /** 释放一次 run 对持久容器的引用(不停止可复用的 runtime 实例)。run 终态时调用。 */
  releaseSandboxInstanceForRun(runId: string): void {
    this.sandboxInstances.releaseInstanceForRun(runId);
  }

  /** 服务重启后清理中断执行残留的 sandbox runtime 实例。 */
  recoverOrphanSandboxInstance(runtimeInstanceId: string): Promise<void> {
    return this.sandboxInstances.recoverOrphan(runtimeInstanceId);
  }

  /** 停止并删除指定 owner 对应的持久容器/沙箱。 */
  shutdownSandboxInstanceByOwnerId(ownerId: string): void {
    this.sandboxInstances.shutdownRuntimeInstanceByOwnerId(ownerId);
  }

  /** 该 runtime instance 是否为 user 级共享隔离(决定中断 run 是否可清理底层资源)。 */
  async isRuntimeInstanceUserScoped(
    runtimeType: string,
    runtimeInstanceId: string
  ): Promise<boolean> {
    const resource = await this.findRuntimeByRuntimeId(
      runtimeType,
      runtimeInstanceId
    );
    return resource?.isolationScope === "user";
  }

  // ── admin:runtime policy / stats / resources(原 RuntimeService,随 WorkerRegistry
  // 数据搬迁——admin 查询本来就是读这份数据,归属 worker-host 更直接) ──

  getRuntimePolicy() {
    return this.runtimeService.getRuntimePolicy();
  }

  async getRuntimeStats() {
    return { activeRuntimes: await this.countRunningRuntimes() };
  }

  async listResources(query: {
    status?: string;
    pageNo?: number;
    pageSize?: number;
  }) {
    const { pageNo, pageSize, take, skip } = pageWindow(query);
    const { items, total } = await this.listRuntimeResourcesPage({
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
   * 管理端 run 详情用:按 run 持久化的 runtime handle 取运行实例视图。
   * runtime 资源归属本领域,run 层经此方法获取,不直接查 runtimeInstance 表。
   */
  async getRuntimeInstanceForAdmin(
    runtimeType: string,
    runtimeInstanceId: string
  ): Promise<AdminRunRuntimeInstanceResponse | null> {
    const record = await this.findRuntimeInstanceView(
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

  async stopRuntimeInstance(id: string) {
    const resource = await this.findRuntimeById(id);
    if (!resource || resource.status !== "running") {
      throw new NotFoundException(
        `Runtime resource ${id} not found or not running`
      );
    }
    if (resource.runtimeType === "sandbox") {
      this.shutdownSandboxInstanceByOwnerId(resource.ownerId);
    }
    await this.markRuntimeStoppedById(resource, "manual_stop");
    return { ok: true };
  }

  private toRuntimeInstanceResponse(resource: RuntimeInstanceRow) {
    const diagnostics = this.buildRuntimeDiagnostics(resource.metadata);
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
