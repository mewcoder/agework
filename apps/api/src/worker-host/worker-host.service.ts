import { Injectable } from "@nestjs/common";
import type {
  CommandPayload,
  RunConfig,
  SandboxRuntimePlacement,
  WorkerCommandRpcRequest,
} from "@agework/shared/protocol";
import { WorkerCommandDispatcher } from "./command/command-dispatcher.service";
import { WorkerUpstreamRegistry } from "./upstream/worker-upstream.registry";
import { WorkerEndpointHandler } from "./worker-endpoint.handler";
import type { WorkerUpstreamPort } from "./worker-host.types";
import { WorkerRegistryRepository } from "./registry/worker-registry.repository";
import { runtimeInstanceDiagnostics } from "./registry/worker-registry-metadata";

@Injectable()
export class WorkerHostService {
  constructor(
    private readonly endpointHandler: WorkerEndpointHandler,
    private readonly upstream: WorkerUpstreamRegistry,
    private readonly commandDispatcher: WorkerCommandDispatcher,
    private readonly registry: WorkerRegistryRepository
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

  /** 记录一个 runtime 实例进入 running 状态,不存在则创建、存在则更新。 */
  upsertRunningRuntime(
    placement: SandboxRuntimePlacement,
    ownerId: string,
    runtimeInstanceId: string,
    metadata?: object
  ) {
    return this.registry.upsertRunning(
      placement,
      ownerId,
      runtimeInstanceId,
      metadata
    );
  }

  /** 按 owner 把 runtime 资源标记为 stopped。 */
  markRuntimeStoppedByOwner(
    runtimeType: string,
    isolationScope: string,
    ownerId: string
  ) {
    return this.registry.markStoppedByOwner(
      runtimeType,
      isolationScope,
      ownerId
    );
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

  /** 校验某个 runtimeInstanceId 是否确实绑定到指定 workspace,防伪造/串扰。 */
  isRuntimeInstanceBoundToWorkspace(
    runtimeType: string,
    workspaceId: string,
    runtimeInstanceId: string
  ) {
    return this.registry.isRuntimeInstanceBoundToWorkspace(
      runtimeType,
      workspaceId,
      runtimeInstanceId
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
}
