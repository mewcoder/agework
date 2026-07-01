import { Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type {
  AcquireInstanceResult,
  RuntimeTarget,
  WorkerExecutionStartInput,
} from "@agework/shared/protocol";
import type { AdminRunRuntimeInstanceResponse } from "@agework/shared/api";
import { ConfigService } from "../config/config.service";
import { pageWindow } from "../common/dto/pagination-query.dto";
import {
  resolveRuntimeTarget,
  type ResolveRuntimeTargetInput,
  type RuntimeTargetDefaults,
} from "./placement/runtime-resource";
import { RuntimeProviderRegistry } from "./providers/provider-registry";
import { SandboxRuntimeInstanceService } from "./sandbox/sandbox-instance.service";
import { WorkerHostService } from "../worker-host/worker-host.service";
import { SANDBOX_ENGINES, type SandboxEngine } from "./sandbox/sandbox-engine";
import { LocalRuntimeProvider } from "./local/local-runtime.provider";
import type {
  SandboxEngineType,
  SandboxRuntime,
  SandboxStartInput,
  LocalInstanceHandle,
  LocalLaunchInput,
} from "./runtime.types";
import { swallow } from "../common/swallow";

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
  private readonly sandboxEngines: Map<SandboxEngineType, SandboxEngine>;

  constructor(
    private readonly configService: ConfigService,
    private readonly providerRegistry: RuntimeProviderRegistry,
    private readonly workerHost: WorkerHostService,
    private readonly sandboxInstances: SandboxRuntimeInstanceService,
    @Inject(SANDBOX_ENGINES) engines: SandboxEngine[],
    private readonly localProvider: LocalRuntimeProvider
  ) {
    this.defaults = {
      runtimeType: configService.getDefaultRuntimeType(),
      isolationScope: configService.getDefaultIsolationScope(),
      sandboxEngine: configService.getSandboxEngine(),
    };
    this.sandboxEngines = new Map(engines.map((e) => [e.type, e]));
  }

  /** 从 run 输入解析出目标运行环境（纯计算，不启动 worker）。 */
  resolveRuntimeTarget(input: ResolveRuntimeTargetInput): RuntimeTarget {
    return resolveRuntimeTarget(input, this.defaults);
  }

  // ── sandbox engine 引擎面(worker-host 的 SandboxInstanceExecutor 经此驱动物理
  // sandbox 操作;runtime 只知道怎么调 engine,不认识 owner 复用/idle 决策) ──

  /** 获取或创建一个 sandbox 运行环境(docker/opensandbox 由 engineType 决定)。 */
  getOrCreateSandbox(
    engineType: SandboxEngineType,
    input: SandboxStartInput
  ): Promise<SandboxRuntime> {
    return this.resolveSandboxEngine(engineType).getOrCreate(input);
  }

  /** 恢复一个此前被 stop() 的 sandbox 运行环境;engine 不支持 resume 时返回 undefined。 */
  resumeSandbox(
    engineType: SandboxEngineType,
    runtimeInstanceId: string,
    input: SandboxStartInput
  ): Promise<SandboxRuntime> | undefined {
    return this.resolveSandboxEngine(engineType).resume?.(
      runtimeInstanceId,
      input
    );
  }

  /** 在已有 sandbox 运行环境中启动 worker 进程。 */
  startSandboxWorker(
    engineType: SandboxEngineType,
    runtime: SandboxRuntime,
    input: SandboxStartInput
  ): Promise<void> {
    return this.resolveSandboxEngine(engineType).startWorker(runtime, input);
  }

  /** 停止(不销毁)一个 sandbox 运行环境。 */
  stopSandbox(
    engineType: SandboxEngineType,
    runtimeInstanceId: string
  ): Promise<void> {
    return this.resolveSandboxEngine(engineType).stop(runtimeInstanceId);
  }

  /** 服务重启后清理中断执行残留的 sandbox 资源,遍历所有已注册 engine(不知道具体是哪个)。 */
  async recoverOrphanSandbox(runtimeInstanceId: string): Promise<void> {
    for (const engine of this.sandboxEngines.values()) {
      await engine
        .recoverOrphan(runtimeInstanceId)
        .catch(
          swallow(this.logger, `recover orphan via ${engine.type} engine`)
        );
    }
  }

  // ── local Provider 门面(run 模块的 LocalRunExecutor 经此拿到 fork 出的进程) ──

  /** fork 一个本地 worker 子进程,返回逻辑实例标识与 IPC channel。 */
  launchLocal(input: LocalLaunchInput): LocalInstanceHandle {
    return this.localProvider.launch(input);
  }

  /** 服务重启后清理中断执行残留的 local 进程。 */
  recoverOrphanLocal(runtimeInstanceId: string): Promise<void> {
    return this.localProvider.recoverOrphan(runtimeInstanceId);
  }

  private resolveSandboxEngine(engineType: SandboxEngineType): SandboxEngine {
    const engine = this.sandboxEngines.get(engineType);
    if (!engine) {
      throw new Error(`Unknown sandbox engine: ${engineType}`);
    }
    return engine;
  }

  // ── sandbox per-run 资源门面 ──────────────────────────────────────────
  // run 层的 SandboxRunExecutor 经下列方法为一次 run 取得/释放持久容器实例；
  // worker session 的 openSession / 命令下发由 run 直接对 worker-host 完成，
  // runtime 不再触碰 per-run 执行。

  /**
   * 为一次 sandbox run 取得持久容器实例，把就绪结果（ready/cancelledBeforeReady/error）
   * 一次性回传给 run 层执行编排。ready 附带 runtimeInstanceId 与 owner accessKey。
   */
  acquireInstanceForRun(
    input: WorkerExecutionStartInput
  ): Promise<AcquireInstanceResult> {
    return this.sandboxInstances.acquireInstanceForRun(input);
  }

  /** 释放一次 run 对持久容器的引用（不停止可复用的 runtime 实例）。run 终态时调用。 */
  releaseInstanceForRun(runId: string): void {
    this.sandboxInstances.releaseInstanceForRun(runId);
  }

  /** 服务重启后清理中断执行残留的 sandbox runtime 实例。 */
  recoverOrphanInstance(runtimeInstanceId: string): Promise<void> {
    return this.sandboxInstances.recoverOrphan(runtimeInstanceId);
  }

  /** 停止并删除指定 owner 对应的持久容器/沙箱。 */
  shutdownRuntimeInstanceByOwnerId(runtimeType: string, ownerId: string): void {
    this.providerRegistry
      .resolve(runtimeType)
      .shutdownRuntimeInstanceByOwnerId?.(ownerId);
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
    return { activeRuntimes: await this.workerHost.countRunningRuntimes() };
  }

  async listResources(query: {
    status?: string;
    pageNo?: number;
    pageSize?: number;
  }) {
    const { pageNo, pageSize, take, skip } = pageWindow(query);
    const { items, total } = await this.workerHost.listRuntimeResourcesPage({
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
  async getRuntimeInstanceForAdmin(
    runtimeType: string,
    runtimeInstanceId: string
  ): Promise<AdminRunRuntimeInstanceResponse | null> {
    const record = await this.workerHost.findRuntimeInstanceView(
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
    const resource = await this.workerHost.findRuntimeByRuntimeId(
      runtimeType,
      runtimeInstanceId
    );
    return resource?.isolationScope === "user";
  }

  async stopRuntimeInstance(id: string) {
    const resource = await this.workerHost.findRuntimeById(id);
    if (!resource || resource.status !== "running") {
      throw new NotFoundException(
        `Runtime resource ${id} not found or not running`
      );
    }
    this.shutdownRuntimeInstanceByOwnerId(
      resource.runtimeType,
      resource.ownerId
    );
    await this.workerHost.markRuntimeStoppedById(resource, "manual_stop");
    return { ok: true };
  }

  private toRuntimeInstanceResponse(resource: RuntimeInstanceRow) {
    const diagnostics = this.workerHost.buildRuntimeDiagnostics(
      resource.metadata
    );
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
