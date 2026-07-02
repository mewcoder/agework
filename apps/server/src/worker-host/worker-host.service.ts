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
import { WorkerEndpointHandler } from "./endpoint/worker-endpoint.handler";
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

  /** worker 长轮询拉取下行命令，按 ownerId + afterSeq 增量返回。 */
  async pollCommands(
    ownerId: string,
    query: { afterSeq?: number; waitMs?: number }
  ): Promise<{ messages: WorkerCommandRpcRequest[] }> {
    return this.endpointHandler.pollCommands(ownerId, query);
  }

  /** worker 启动后拉取本次 run 的 RunConfig。 */
  getRunConfig(runId: string): { config: RunConfig } {
    return this.endpointHandler.getRunConfig(runId);
  }

  /** 接收 worker 上报的上行事件（JSON-RPC notification / command-result），转发给 run 层。 */
  async postEvent(runId: string, body: unknown): Promise<{ ok: boolean }> {
    return this.endpointHandler.postEvent(runId, body);
  }

  /** 为一次 run 打开命令下行会话，按 owner 是否为 local channel 内部分流。 */
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

  /** 向 owner 下发一条命令，按 owner 是否为 local channel 内部分流。 */
  sendCommand(ownerId: string, runId: string, command: CommandPayload): void {
    if (this.localInstances.getChannel(ownerId)) {
      this.localInstances.sendCommand(ownerId, command);
      return;
    }
    this.commandDispatcher.sendCommand(ownerId, runId, command);
  }

  /** run 结束时清理该 run 在命令队列里的残留状态。 */
  cleanupRun(runId: string): void {
    this.commandDispatcher.cleanupRun(runId);
  }

  /** 按 ownerId 清理命令队列/会话状态。 */
  cleanupByOwnerId(ownerId: string): void {
    this.commandDispatcher.cleanupByOwnerId(ownerId);
  }

  /** 接线 `run` 模块实现的上行事件 Port，供上报事件时反向回流。 */
  setUpstreamPort(receiver: WorkerUpstreamPort): void {
    this.upstream.setUpstreamPort(receiver);
  }

  /** 从 run 输入解析出目标运行环境(纯计算,不启动 worker)。直通转发 runtime 模块。 */
  resolveRuntimeTarget(input: ResolveRuntimeTargetInput): RuntimeTarget {
    return this.runtimeService.resolveRuntimeTarget(input);
  }

  // ── WorkerRegistry 跨模块查询 ────────────────────────────────────────
  // WorkerRegistry 数据(RuntimeInstance/WorkspaceRuntimeInstance 表)归属 worker-host,
  // 这里是唯一对外入口;模块内部(lifecycle 等 internal provider)直接注入
  // WorkerRegistryRepository,不经根 Service 转发。

  /** 按 (runtimeType, runtimeInstanceId) 查找 runtime 资源行,供 run 恢复流程用。 */
  findRuntimeByRuntimeId(runtimeType: string, runtimeInstanceId: string) {
    return this.registry.findByRuntimeId(runtimeType, runtimeInstanceId);
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

  /** 管理端查询当前 runtime 资源策略（配额等）。 */
  getRuntimePolicy() {
    return this.runtimeService.getRuntimePolicy();
  }

  /** 管理端概览用：当前 running 状态的 runtime 资源数量。 */
  async getRuntimeStats() {
    return { activeRuntimes: await this.registry.countRunning() };
  }

  /** 管理端分页列出 runtime 资源，附带诊断信息。 */
  async listResources(query: {
    status?: string;
    pageNo?: number;
    pageSize?: number;
  }) {
    const { pageNo, pageSize, take, skip } = pageWindow(query);
    const { items, total } = await this.registry.listResourcesPage({
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
    const record = await this.registry.findRunInstanceView(
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

  /** 管理端手动停止一个 running 状态的 runtime 资源。 */
  async stopRuntimeInstance(id: string) {
    const resource = await this.registry.findById(id);
    if (!resource || resource.status !== "running") {
      throw new NotFoundException(
        `Runtime resource ${id} not found or not running`
      );
    }
    this.shutdownInstanceByOwnerId(resource.runtimeType, resource.ownerId);
    await this.registry.markStoppedById(resource, "manual_stop");
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
