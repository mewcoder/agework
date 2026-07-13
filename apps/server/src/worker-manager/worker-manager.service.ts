import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import type {
  AcquireInstanceResult,
  CommandPayload,
  RunConfig,
  RuntimeSpec,
  WorkerCommandRpcRequest,
  WorkerExecutionStartInput,
} from "@agework/shared/protocol";
import type { AdminRunWorkerInstanceResponse } from "@agework/shared/api";
import {
  isRuntimeType,
  type RuntimeSpecInput,
  type RuntimeInstanceRef,
} from "@agework/providers";
import { WorkerCommandDispatcher } from "./connection/command-dispatcher";
import { WorkerEndpointHandler } from "./connection/worker-endpoint.handler";
import type { WorkerUpstreamPort } from "./worker-manager.types";
import { WorkerRegistryRepository } from "./registry/worker-registry.repository";
import { workerInstanceDiagnostics } from "./registry/worker-registry-metadata";
import { pageWindow } from "../common/dto/pagination-query.dto";
import { RuntimeService } from "../runtime/runtime.service";
import { WorkerProvisioner } from "./instance/worker.provisioner";
import type { RegisterWorkerDto } from "./dto/register-worker.dto";
import { OwnerRunStore } from "./instance/owner-run.store";
import { AGEWORK_VERSION } from "@agework/shared";
import { commandMessageToRpcRequest } from "@agework/shared/protocol/rpc";
import type { RuntimeHost } from "@agework/runtime/host";
import { MANAGED_RUNTIME_HOST } from "./contract/managed-runtime-host";

/**
 * native 和 sandbox 现在走同一条 HTTP 长轮询通道收发命令/事件,命令路由不再按
 * runtimeType 分流,统一经 `commandDispatcher` 下发——native 与 sandbox 的差异
 * 只剩"怎么把进程弄起来"(fork vs 起容器),归 `WorkerProvisioner` 统一编排,
 * 物理动作再转发给 `RuntimeService` 按 runtimeType 分发给对应 provider。
 */
@Injectable()
export class WorkerManagerService {
  private readonly logger = new Logger(WorkerManagerService.name);

  constructor(
    private readonly endpointHandler: WorkerEndpointHandler,
    private readonly commandDispatcher: WorkerCommandDispatcher,
    private readonly registry: WorkerRegistryRepository,
    private readonly runtimeService: RuntimeService,
    private readonly provisioner: WorkerProvisioner,
    private readonly ownerRunStore: OwnerRunStore,
    @Inject(MANAGED_RUNTIME_HOST)
    private readonly managedHost: RuntimeHost
  ) {}

  // ── worker 数据面(Phase 2:委托进程内 RuntimeHost) ─────────────────
  //
  // /worker/* 旧端点只服务 managed-native 的 worker(managed 容器型 + registered
  // 的 worker 连各自 Host 的 WorkerHttpServer)。这些方法委托进程内 RuntimeHost,
  // 响应形状与 Host 侧 WorkerHttpServer 同构,WorkerHttpTransport 无感。

  /**
   * worker 长轮询拉取下行命令，按 workerId + afterSeq 增量返回。长轮询本身就是心跳
   * 信号,不加独立心跳 RPC——poll 在 Host 内会 touch 该 worker 的 fence 心跳。
   */
  async pollCommands(
    workerId: string,
    query: { afterSeq?: number; waitMs?: number }
  ): Promise<{
    messages: WorkerCommandRpcRequest[];
    queueEpoch: number;
  }> {
    const result = await this.managedHost.pollCommands(workerId, query);
    return {
      messages: result.commands.map(commandMessageToRpcRequest),
      queueEpoch: result.queueEpoch,
    };
  }

  /** worker 启动后拉取本次 run 的 RunConfig。 */
  getRunConfig(runId: string): { config: RunConfig } {
    const config = this.managedHost.getRunConfig(runId);
    if (!config) {
      throw new NotFoundException(`Run config not found: ${runId}`);
    }
    return { config };
  }

  /**
   * 接收 worker 上报的上行事件（JSON-RPC notification / command-result），转发给 run 层。
   * 事件上报本身也是"worker 活着"的证据,Host 内会顺带 touch 心跳。
   */
  async postEvent(runId: string, body: unknown): Promise<{ ok: boolean }> {
    try {
      return await this.managedHost.postEvent(runId, body);
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  /**
   * worker 进程启动后主动回连注册，携带 launch 时下发的 startToken。
   * token 匹配则 resolve Host 里挂起的 launch 等待（见 HandshakeStore），
   * 不匹配或没有 pending 握手（迟到的/伪造的回连）一律 400。
   */
  // async 是有意的：把下面的同步 BadRequestException throw 转成 rejected Promise，
  // 与这个门面上其它 async 方法的调用约定保持一致。
  // eslint-disable-next-line @typescript-eslint/require-await
  async registerWorker(
    workerId: string,
    body: RegisterWorkerDto
  ): Promise<{ ok: boolean }> {
    const accepted = this.managedHost.registerWorker(
      workerId,
      body.startToken,
      { pid: body.pid }
    );
    if (!accepted) {
      throw new BadRequestException(
        `no pending launch handshake for worker ${workerId}, or token mismatch`
      );
    }
    if (body.version && body.version !== AGEWORK_VERSION) {
      this.logger.warn(
        `worker version mismatch for worker ${workerId}: worker=${body.version} server=${AGEWORK_VERSION} (允许接入,注意 Registered 远程 manager 单独构建后的漂移)`
      );
    }
    return { ok: true };
  }

  /** worker 数据面 token 校验(WorkerTokenGuard 用):对进程内 Host 的池比对 startToken。 */
  validateWorkerToken(workerId: string, token: string): boolean {
    return this.managedHost.validateWorkerToken(workerId, token);
  }

  /** 为一次 run 打开命令下行会话。 */
  openSession(params: {
    runId: string;
    workerId: string;
    runConfig: RunConfig;
  }): void {
    this.commandDispatcher.openSession(params);
  }

  /** 向 worker 下发一条命令。 */
  sendCommand(workerId: string, runId: string, command: CommandPayload): void {
    this.commandDispatcher.sendCommand(workerId, runId, command);
  }

  /** 按 workspaceId 查找 running 状态的常驻 worker(薄方法,直通 registry). */
  findActiveWorkerByWorkspace(workspaceId: string) {
    return this.registry.findActiveByWorkspace(workspaceId);
  }

  /** run 结束时清理该 run 在命令队列里的残留状态。 */
  cleanupRun(runId: string): void {
    this.ownerRunStore.unregisterRun(runId);
    this.commandDispatcher.cleanupRun(runId);
  }

  /** 按 workerId 清理命令队列/会话状态。 */
  cleanupByWorkerId(workerId: string): void {
    this.commandDispatcher.cleanupByWorkerId(workerId);
  }

  /** 接线 `run` 模块实现的上行事件 Port，供上报事件时反向回流。 */
  setUpstreamPort(receiver: WorkerUpstreamPort): void {
    this.endpointHandler.setUpstreamPort(receiver);
  }

  /** 从 run 输入解析出目标运行环境(纯计算,不启动 worker)。直通转发 runtime 模块。 */
  resolveRuntimeSpec(input: RuntimeSpecInput): RuntimeSpec {
    return this.runtimeService.resolveRuntimeSpec(input);
  }

  // ── WorkerRegistry 跨模块查询 ────────────────────────────────────────
  // WorkerRegistry 数据(WorkerInstance/WorkspaceWorkerBinding 表)归属 worker-manager,
  // 这里是唯一对外入口;模块内部(lifecycle 等 internal provider)直接注入
  // WorkerRegistryRepository,不经根 Service 转发。

  /** 按 (runtimeType, runtimeInstanceId) 查找 runtime 资源行,供 run 恢复流程用。 */
  findRuntimeByRuntimeId(runtimeType: string, runtimeInstanceId: string) {
    return this.registry.findByRuntimeId(runtimeType, runtimeInstanceId);
  }

  // ── 统一实例编排入口(resolveInstance 落地,替代按 runtimeType 分别调用 sandbox/native
  // 专属方法——runtimeType 判断收在 provisioner/RuntimeService 内部,run 层不再
  // 需要认识 sandbox/native 的区别) ──

  /**
   * 为一次 run 取得(创建/复用/attach)worker 载体,交给 provisioner 统一编排
   * (runtimeType 分流收在 provisioner/RuntimeService 内部)。provisioner 返回后
   * 登记 runId → workerId(协议身份),供 postEvent 的心跳 touch 和 fence 的
   * run 终结反查。早登记的取舍不变——最多多留几毫秒一个"还没成功"的条目,
   * releaseInstanceForRun/cleanupRun 迟早会清掉它。
   */
  async resolveInstance(
    input: WorkerExecutionStartInput
  ): Promise<AcquireInstanceResult> {
    const result = await this.provisioner.acquireInstanceForRun(input);
    if (result.outcome === "ready") {
      this.ownerRunStore.registerRun(input.runConfig.runId, result.workerId);
    }
    return result;
  }

  /**
   * 释放一次 run 对 worker 载体的引用。回收(引用计数/idle/settle)已经砍掉,
   * 这里只清 owner→runId 的 fence 索引,不再触发任何实例侧动作。
   */
  releaseInstanceForRun(runId: string): void {
    this.ownerRunStore.unregisterRun(runId);
  }

  // ── admin:runtime policy / stats / resources(原 RuntimeService,随 WorkerRegistry
  // 数据搬迁——admin 查询本来就是读这份数据,归属 worker-manager 更直接) ──

  /** 管理端查询当前 runtime 资源策略（配额等）。 */
  getRuntimePolicy() {
    return this.runtimeService.getRuntimePolicy();
  }

  /** 管理端概览用：当前 running 状态的 runtime 资源数量。 */
  async getWorkerStats() {
    return { activeWorkers: await this.registry.countRunning() };
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
      list: items.map(toWorkerInstanceResponse),
      total,
      pageNo,
      pageSize,
    };
  }

  /**
   * 管理端 run 详情用:按 run 持久化的 runtime handle 取运行实例视图。
   * runtime 资源归属本领域,run 层经此方法获取,不直接查 workerInstance 表。
   */
  async getWorkerInstanceForAdmin(
    runtimeType: string,
    runtimeInstanceId: string
  ): Promise<AdminRunWorkerInstanceResponse | null> {
    const record = await this.registry.findRunInstanceView(
      runtimeType,
      runtimeInstanceId
    );
    return record ? toAdminWorkerInstanceResponse(record) : null;
  }

  /** 管理端手动停止一个 running 状态的 runtime 资源。 */
  async stopWorkerInstance(id: string) {
    const resource = await this.registry.findById(id);
    if (!resource || resource.status !== "running") {
      throw new NotFoundException(
        `Runtime resource ${id} not found or not running`
      );
    }
    if (!isRuntimeType(resource.runtimeType)) {
      throw new NotFoundException(
        `Runtime resource ${id} has unknown runtimeType ${resource.runtimeType}`
      );
    }
    const ref: RuntimeInstanceRef = {
      runtimeType: resource.runtimeType,
      ownerId: resource.ownerId,
      workerId: resource.id,
      runtimeInstanceId: resource.instanceId,
      isolationScope: resource.isolationScope,
      targetRuntimeId: resource.runtimeId,
    };
    await this.provisioner.stop(ref);
    await this.registry.markStoppedById(resource, "manual_stop");
    return { ok: true };
  }
}

// ── admin 响应组装(纯函数)。行形状由 WorkerRegistryRepository 的查询 select
//    决定,这里只消费。单一使用、无独立测试,按响应形状就近内联的约定放在门面同文件。──

type WorkerWorkspaceBindingRow = {
  id: string;
  workspaceId: string;
  createdAt: Date | string;
  updatedAt: Date | string;
};

type WorkerRow = {
  id: string;
  runtimeType: string;
  isolationScope: string;
  ownerId: string;
  instanceId: string;
  status: string;
  expiresAt: Date | string | null;
  metadata: unknown;
  createdAt: Date | string;
  updatedAt: Date | string;
  bindings?: WorkerWorkspaceBindingRow[];
};

/** 管理端 runtime 资源列表行:附 isReusable / workspaceCount / diagnostics 汇总。 */
function toWorkerInstanceResponse(resource: WorkerRow) {
  const diagnostics = workerInstanceDiagnostics(resource.metadata);
  const workspaceBindings = resource.bindings?.map(toWorkspaceBinding);

  return {
    id: resource.id,
    runtimeType: resource.runtimeType,
    isolationScope: resource.isolationScope,
    ownerId: resource.ownerId,
    runtimeInstanceId: resource.instanceId,
    status: resource.status,
    isReusable: resource.status === "running",
    workspaceCount: workspaceBindings?.length ?? 0,
    expiresAt: resource.expiresAt ? toIsoString(resource.expiresAt) : null,
    metadata: resource.metadata,
    diagnostics: {
      ...diagnostics,
      ownerId: diagnostics.ownerId ?? resource.ownerId,
      runtimeInstanceId: diagnostics.runtimeInstanceId ?? resource.instanceId,
    },
    createdAt: toIsoString(resource.createdAt),
    updatedAt: toIsoString(resource.updatedAt),
    workspaceBindings,
  };
}

/** 管理端 run 详情里的 runtime 实例视图(findRunInstanceView 的行,不含 metadata)。 */
function toAdminWorkerInstanceResponse(
  record: Omit<WorkerRow, "metadata" | "bindings"> & {
    bindings: WorkerWorkspaceBindingRow[];
  }
): AdminRunWorkerInstanceResponse {
  const { bindings, instanceId, ...resource } = record;
  return {
    ...resource,
    runtimeInstanceId: instanceId,
    expiresAt: resource.expiresAt ? toIsoString(resource.expiresAt) : null,
    createdAt: toIsoString(resource.createdAt),
    updatedAt: toIsoString(resource.updatedAt),
    workspaceBindings: bindings.map(toWorkspaceBinding),
  };
}

function toWorkspaceBinding(binding: WorkerWorkspaceBindingRow) {
  return {
    id: binding.id,
    workspaceId: binding.workspaceId,
    createdAt: toIsoString(binding.createdAt),
    updatedAt: toIsoString(binding.updatedAt),
  };
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
