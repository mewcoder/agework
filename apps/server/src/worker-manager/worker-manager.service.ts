import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
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
import type { WorkerUpstreamPort } from "./worker-manager.types";
import { WorkerRegistryRepository } from "./registry/worker-registry.repository";
import {
  toAdminRuntimeInstanceResponse,
  toRuntimeInstanceResponse,
} from "./registry/worker-instance-view";
import { pageWindow } from "../common/dto/pagination-query.dto";
import { RuntimeService } from "../runtime/runtime.service";
import { SandboxInstanceExecutor } from "./sandbox-instance/sandbox-instance.executor";
import { LocalInstanceExecutor } from "./local-instance/local-instance.executor";
import { WorkerHandshakeStore } from "./handshake/worker-handshake.store";
import type { RegisterWorkerDto } from "./dto/register-worker.dto";
import { WorkerLivenessStore } from "./liveness/worker-liveness.store";
import { safeLogJson } from "../common/logging";
import { swallow } from "../common/swallow";

/**
 * local 和 sandbox 现在走同一条 HTTP 长轮询通道收发命令/事件,命令路由不再按
 * runtimeType 分流,统一经 `commandDispatcher` 下发——local 与 sandbox 的差异
 * 只剩"怎么把进程弄起来"(fork vs 起容器),归 LocalInstanceExecutor / SandboxInstanceExecutor
 * 各自负责。
 */
@Injectable()
export class WorkerManagerService {
  private readonly logger = new Logger(WorkerManagerService.name);

  // owner → 其名下 in-flight runId 的索引,供 fenceOwner 终结用。必须放在这个
  // facade 层而不是 local/sandbox 各自的 executor 里:releaseInstanceForRun 统一
  // 路由到 sandboxInstances,local 的释放路径本来就是 no-op,索引放 executor 层
  // 会让 local run 在这里"泄漏"、永远不被摘除。resolveInstance/releaseInstanceForRun/
  // cleanupRun 是 local 与 sandbox 两条路径都会经过的地方,索引维护收在这里。
  private readonly ownerRunIds = new Map<string, Set<string>>();
  private readonly runOwner = new Map<string, string>();

  constructor(
    private readonly endpointHandler: WorkerEndpointHandler,
    private readonly upstream: WorkerUpstreamRegistry,
    private readonly commandDispatcher: WorkerCommandDispatcher,
    private readonly registry: WorkerRegistryRepository,
    private readonly runtimeService: RuntimeService,
    private readonly sandboxInstances: SandboxInstanceExecutor,
    private readonly localInstances: LocalInstanceExecutor,
    private readonly handshakeStore: WorkerHandshakeStore,
    private readonly livenessStore: WorkerLivenessStore
  ) {}

  /**
   * worker 长轮询拉取下行命令，按 ownerId + afterSeq 增量返回。长轮询本身就是心跳
   * 信号,不加独立心跳 RPC——这里是 local/sandbox 唯一共用的 poll 入口,touch 记
   * 一次该 owner 最后被看见的时间。
   */
  async pollCommands(
    ownerId: string,
    query: { afterSeq?: number; waitMs?: number }
  ): Promise<{ messages: WorkerCommandRpcRequest[] }> {
    this.livenessStore.touch(ownerId);
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

  /**
   * worker 进程启动后主动回连注册，携带 launch 时下发的 startToken。
   * token 匹配则 resolve 对应 executor 里挂起的 launch 等待（见 WorkerHandshakeStore），
   * 不匹配或没有 pending 握手（迟到的/伪造的回连）一律 400。
   */
  // async 是有意的：把下面的同步 BadRequestException throw 转成 rejected Promise，
  // 与这个门面上其它 async 方法的调用约定保持一致。
  // eslint-disable-next-line @typescript-eslint/require-await
  async registerWorker(
    ownerId: string,
    body: RegisterWorkerDto
  ): Promise<{ ok: boolean }> {
    const accepted = this.handshakeStore.registerWorker(
      ownerId,
      body.startToken,
      { pid: body.pid }
    );
    if (!accepted) {
      throw new BadRequestException(
        `no pending launch handshake for owner ${ownerId}, or token mismatch`
      );
    }
    return { ok: true };
  }

  /** 为一次 run 打开命令下行会话。 */
  openSession(params: {
    runId: string;
    ownerId: string;
    runConfig: RunConfig;
  }): void {
    this.commandDispatcher.openSession(params);
  }

  /** 向 owner 下发一条命令。 */
  sendCommand(ownerId: string, runId: string, command: CommandPayload): void {
    this.commandDispatcher.sendCommand(ownerId, runId, command);
  }

  /** run 结束时清理该 run 在命令队列里的残留状态。 */
  cleanupRun(runId: string): void {
    this.unregisterRun(runId);
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
  // WorkerRegistry 数据(WorkerInstance/WorkspaceWorkerBinding 表)归属 worker-manager,
  // 这里是唯一对外入口;模块内部(lifecycle 等 internal provider)直接注入
  // WorkerRegistryRepository,不经根 Service 转发。

  /** 按 (runtimeType, runtimeInstanceId) 查找 runtime 资源行,供 run 恢复流程用。 */
  findRuntimeByRuntimeId(runtimeType: string, runtimeInstanceId: string) {
    return this.registry.findByRuntimeId(runtimeType, runtimeInstanceId);
  }

  // ── 统一实例编排入口(resolveInstance 落地,替代按 runtimeType 分别调用 sandbox/local
  // 专属方法——runtimeType 判断收进这里,run 层不再需要认识 sandbox/local 的区别) ──

  /**
   * 为一次 run 取得(创建/复用/attach)runtime 实例,按 runtimeType 内部分流。
   * 调用 executor 之前先登记 runId → ownerId,不等待 acquire 结果——早登记的
   * 坏处最多是索引里多留了几毫秒一个"还没成功"的条目,releaseInstanceForRun/
   * cleanupRun 迟早会清掉它,不会造成持久污染。
   */
  resolveInstance(
    input: WorkerExecutionStartInput
  ): Promise<AcquireInstanceResult> {
    this.registerRun(input.runConfig.runId, input.runtimeTarget.ownerId);
    if (input.runtimeTarget.runtimeType === "local") {
      return this.localInstances.acquireInstanceForRun(input);
    }
    return this.sandboxInstances.acquireInstanceForRun(input);
  }

  /**
   * 释放一次 run 对 runtime 实例的引用。local 没有 per-run 引用计数(worker 常驻,
   * 只随 owner 关闭/进程 exit 整体释放),sandbox 侧对未知 runId 幂等 no-op,
   * 因此统一走 sandbox 执行器,调用方不传 runtimeType。先清 owner→runId 索引,
   * 再转发给下游执行器——顺序不能反,防止 watchdog 在两步之间读到脏索引。
   */
  releaseInstanceForRun(runId: string): void {
    this.unregisterRun(runId);
    this.sandboxInstances.releaseInstanceForRun(runId);
  }

  /**
   * 终止并清理指定 owner 的 runtime 实例。runtimeType 由 admin / 生命周期路径从 DB 取出后
   * 传入(权威来源),故这里按参数分流。
   */
  shutdownInstanceByOwnerId(runtimeType: string, ownerId: string): void {
    if (runtimeType === "local") {
      this.localInstances.shutdownRuntimeInstanceByOwnerId(ownerId);
    } else {
      this.sandboxInstances.shutdownRuntimeInstanceByOwnerId(ownerId);
    }
  }

  // ── 心跳 fence:watchdog 判定某 owner 超时未见心跳后调用的唯一入口 ──────────

  /**
   * fence 一个 unhealthy 的 owner:超时即判死,不做"确认死亡"(卡死但进程没退出
   * 正是本机制要抓的场景)。物理停止载体是幂等操作,对已经死透的容器/进程重复
   * 调用无害。找不到活跃行说明该 owner 已经被别的路径清理过,直接 return。
   */
  async fenceOwner(ownerId: string, reason: string): Promise<void> {
    const active = await this.registry.findActiveByOwnerId(ownerId);
    if (!active) return;

    const runIds = this.runIdsForOwner(ownerId);
    for (const runId of runIds) {
      await this.upstream
        .notifyWorkerLost(runId, reason)
        .catch(swallow(this.logger, `notify worker lost for run ${runId}`));
    }

    this.shutdownInstanceByOwnerId(active.runtimeType, ownerId);
    this.commandDispatcher.cleanupByOwnerId(ownerId);
    this.livenessStore.remove(ownerId);

    this.logger.warn(
      `fenced unhealthy owner ${safeLogJson({
        ownerId,
        reason,
        terminatedRuns: runIds.length,
      })}`
    );
  }

  private registerRun(runId: string, ownerId: string): void {
    this.runOwner.set(runId, ownerId);
    let runIds = this.ownerRunIds.get(ownerId);
    if (!runIds) {
      runIds = new Set();
      this.ownerRunIds.set(ownerId, runIds);
    }
    runIds.add(runId);
  }

  private unregisterRun(runId: string): void {
    const ownerId = this.runOwner.get(runId);
    if (!ownerId) return;
    this.runOwner.delete(runId);
    const runIds = this.ownerRunIds.get(ownerId);
    if (!runIds) return;
    runIds.delete(runId);
    if (runIds.size === 0) {
      this.ownerRunIds.delete(ownerId);
    }
  }

  private runIdsForOwner(ownerId: string): string[] {
    return Array.from(this.ownerRunIds.get(ownerId) ?? []);
  }

  // ── admin:runtime policy / stats / resources(原 RuntimeService,随 WorkerRegistry
  // 数据搬迁——admin 查询本来就是读这份数据,归属 worker-manager 更直接) ──

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
      list: items.map(toRuntimeInstanceResponse),
      total,
      pageNo,
      pageSize,
    };
  }

  /**
   * 管理端 run 详情用:按 run 持久化的 runtime handle 取运行实例视图。
   * runtime 资源归属本领域,run 层经此方法获取,不直接查 workerInstance 表。
   */
  async getRuntimeInstanceForAdmin(
    runtimeType: string,
    runtimeInstanceId: string
  ): Promise<AdminRunRuntimeInstanceResponse | null> {
    const record = await this.registry.findRunInstanceView(
      runtimeType,
      runtimeInstanceId
    );
    return record ? toAdminRuntimeInstanceResponse(record) : null;
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
}
