import { Injectable, NotFoundException } from "@nestjs/common";
import type {
  AcquireInstanceResult,
  CommandPayload,
  RunConfig,
  RuntimeTarget,
  WorkerCommandRpcRequest,
  WorkerExecutionStartInput,
} from "@agework/shared/protocol";
import type { AdminRunRuntimeInstanceResponse } from "@agework/shared/api";
import type { ResolveRuntimeTargetInput } from "../runtime/runtime.types";
import { WorkerCommandDispatcher } from "./command/command-dispatcher.service";
import { WorkerUpstreamRegistry } from "./upstream/worker-upstream.registry";
import { WorkerEndpointHandler } from "./worker-endpoint.handler";
import type { WorkerUpstreamPort } from "./worker-host.types";
import { WorkerRegistryRepository } from "./registry/worker-registry.repository";
import { runtimeInstanceDiagnostics } from "./registry/worker-registry-metadata";
import { pageWindow } from "../common/dto/pagination-query.dto";
import { RuntimeService } from "../runtime/runtime.service";
import { SandboxInstanceExecutor } from "./sandbox/sandbox-instance.executor";
import { LocalInstanceExecutor } from "./local/local-instance.executor";

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
    private readonly sandboxInstances: SandboxInstanceExecutor,
    private readonly localInstances: LocalInstanceExecutor
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
    if (this.localInstances.getChannel(params.ownerId)) {
      this.localInstances.openSession(params.ownerId, params.runConfig);
      return;
    }
    this.commandDispatcher.openSession(params);
  }

  sendCommand(ownerId: string, runId: string, command: CommandPayload): void {
    if (this.localInstances.getChannel(ownerId)) {
      this.localInstances.sendCommand(ownerId, command);
      return;
    }
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

  /** 从 run 输入解析出目标运行环境(纯计算,不启动 worker)。直通转发 runtime 模块。 */
  resolveRuntimeTarget(input: ResolveRuntimeTargetInput): RuntimeTarget {
    return this.runtimeService.resolveRuntimeTarget(input);
  }

  // ── WorkerRegistry 透传方法 ──────────────────────────────────────────
  // WorkerRegistry 数据(RuntimeInstance/WorkspaceRuntimeInstance 表)归属 worker-host,
  // 这里是唯一对外入口;这批方法是 Phase 1(纯粹的归属搬家)的产物,1:1 透传原
  // repository 方法。取得/释放/回收 runtime 实例本身的编排入口见下方
  // resolveInstance() 分组(Phase 4)。

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

  /** 服务重启后的扫尾用:把所有卡在 starting 的行标记为 error(仍待讨论第 13 条)。 */
  markAllStartingRuntimesAsError() {
    return this.registry.markAllStartingAsError();
  }

  /** 按 runtimeType 查找所有 running 状态的行,供重启扫尾用。 */
  findRunningRuntimesByType(runtimeType: string) {
    return this.registry.findRunningByRuntimeType(runtimeType);
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

  // ── 统一实例编排入口(resolveInstance 落地,替代按 runtimeType 分别调用 sandbox/local
  // 专属方法——runtimeType 判断收进这里,run 层不再需要认识 sandbox/local 的区别) ──

  /** 为一次 run 取得(创建/复用/attach)runtime 实例,按 runtimeType 内部分流。 */
  resolveInstance(
    input: WorkerExecutionStartInput
  ): Promise<AcquireInstanceResult> {
    if (input.runtimeTarget.runtimeType === "local") {
      return this.localInstances.acquireInstanceForRun(input);
    }
    return this.sandboxInstances.acquireInstanceForRun(input);
  }

  /** 释放一次 run 对 runtime 实例的引用,按 runtimeType 内部分流。 */
  releaseInstanceForRun(runtimeType: string, runId: string): void {
    if (runtimeType === "local") {
      this.localInstances.releaseInstanceForRun(runId);
      return;
    }
    this.sandboxInstances.releaseInstanceForRun(runId);
  }

  /** 终止并清理指定 owner 的 runtime 实例,按 runtimeType 内部分流。 */
  shutdownInstanceByOwnerId(runtimeType: string, ownerId: string): void {
    if (runtimeType === "local") {
      this.localInstances.shutdownRuntimeInstanceByOwnerId(ownerId);
      return;
    }
    this.sandboxInstances.shutdownRuntimeInstanceByOwnerId(ownerId);
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
    this.shutdownInstanceByOwnerId(resource.runtimeType, resource.ownerId);
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
