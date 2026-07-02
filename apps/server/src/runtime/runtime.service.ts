import { Inject, Injectable } from "@nestjs/common";
import type { RuntimeTarget } from "@agework/shared/protocol";
import { ConfigService } from "../config/config.service";
import {
  resolveRuntimeTarget,
  type ResolveRuntimeTargetInput,
  type RuntimeTargetDefaults,
} from "./placement/runtime-resource";
import { SANDBOX_ENGINES, type SandboxEngine } from "./sandbox/sandbox-engine";
import type {
  SandboxEngineType,
  SandboxRuntime,
  SandboxStartInput,
} from "./runtime.types";
import { LocalRuntimeProvider } from "./local/local-runtime.provider";
import type { LocalInstanceHandle, LocalLaunchInput } from "./runtime.types";

/**
 * Runtime 层对上层的门面:纯 Provider 引擎 + placement 计算。不认识 WorkerRegistry、
 * owner 复用规则、idle 决策——那些是 worker-host 的事(设计文档 1.1/3.6 节)。
 * `runtime` 因此是零依赖模块,唯一调用方是 `worker-host`。
 */
@Injectable()
export class RuntimeService {
  private readonly defaults: RuntimeTargetDefaults;
  private readonly sandboxEngines: Map<SandboxEngineType, SandboxEngine>;

  constructor(
    private readonly configService: ConfigService,
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

  /** 从 run 输入解析出目标运行环境(纯计算,不启动 worker)。 */
  resolveRuntimeTarget(input: ResolveRuntimeTargetInput): RuntimeTarget {
    return resolveRuntimeTarget(input, this.defaults);
  }

  /** 返回当前运行时策略配置(默认/可选 runtimeType、isolationScope、空闲超时秒数),供前端展示与校验用。 */
  getRuntimePolicy() {
    return {
      runtimeType: this.configService.getDefaultRuntimeType(),
      allowedRuntimeTypes: this.configService.getAllowedRuntimeTypes(),
      isolationScope: this.configService.getDefaultIsolationScope(),
      allowedIsolationScopes: this.configService.getAllowedIsolationScopes(),
      idleTimeoutSeconds: this.configService.getIdleTimeoutSeconds(),
    };
  }

  // ── sandbox engine 引擎面 ──────────────────────────────────────────

  /**
   * 取得(或复用)一个 sandbox 运行时并在其上拉起 worker,一步返回就绪实例。
   * getOrCreate + startWorker 的引擎时序收在 runtime 内,worker-host 只需调一次。
   */
  async startSandbox(
    engineType: SandboxEngineType,
    input: SandboxStartInput
  ): Promise<SandboxRuntime> {
    const engine = this.resolveSandboxEngine(engineType);
    const runtime = await engine.getOrCreate(input);
    await engine.startWorker(runtime, input);
    return runtime;
  }

  /**
   * 恢复一个此前被 stop() 的 sandbox 并重新拉起 worker。引擎不支持 resume(或 resume
   * 返回空)时返回 undefined,由调用方决定是否退回 startSandbox 全新创建。
   */
  async resumeSandbox(
    engineType: SandboxEngineType,
    runtimeInstanceId: string,
    input: SandboxStartInput
  ): Promise<SandboxRuntime | undefined> {
    const engine = this.resolveSandboxEngine(engineType);
    const runtime = await engine.resume?.(runtimeInstanceId, input);
    if (!runtime) return undefined;
    await engine.startWorker(runtime, input);
    return runtime;
  }

  /** 停止指定的 sandbox 运行时实例。 */
  stopSandbox(
    engineType: SandboxEngineType,
    runtimeInstanceId: string
  ): Promise<void> {
    return this.resolveSandboxEngine(engineType).stop(runtimeInstanceId);
  }

  private resolveSandboxEngine(engineType: SandboxEngineType): SandboxEngine {
    const engine = this.sandboxEngines.get(engineType);
    if (!engine) {
      throw new Error(`Unknown sandbox engine: ${engineType}`);
    }
    return engine;
  }

  // ── local Provider 门面 ────────────────────────────────────────────

  /** fork 一个本地 worker 子进程并返回其句柄。 */
  launchLocal(input: LocalLaunchInput): LocalInstanceHandle {
    return this.localProvider.launch(input);
  }

  /** 恢复(或按需终止)一个孤儿本地运行时实例;runtimeInstanceId 格式与本地进程标识一致。 */
  recoverOrphanLocal(runtimeInstanceId: string): Promise<void> {
    return this.localProvider.recoverOrphan(runtimeInstanceId);
  }
}
