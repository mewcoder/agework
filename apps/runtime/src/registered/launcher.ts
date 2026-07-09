import {
  createRuntimeResolver,
  type RuntimeConfig,
  type RuntimeInstanceRef,
  type RuntimeLaunchContext,
  type RuntimeProvider,
} from "@agework/providers";
import type {
  RuntimeInstanceRefRpcParams,
  RuntimeLaunchRpcParams,
} from "@agework/shared/protocol";
import type { RegisteredRuntimeConfig, RuntimeType } from "../config.js";
import { LiveCarrierStore } from "./registry.js";

/**
 * 用 packages/providers 起/停/毁 worker。Registered Runtime 实例专一,只用自己
 * 配置的那一种 runtimeType;createRuntimeResolver 是包唯一的装配出口,仍会装配
 * 全部三种 provider,这里只取自己那一个用,其余两种的 config 字段允许是占位值。
 */
export class Launcher {
  private readonly resolveProvider: (type: RuntimeType) => RuntimeProvider;
  private readonly runtimeType: RuntimeType;

  constructor(
    config: RegisteredRuntimeConfig,
    private readonly registry: LiveCarrierStore
  ) {
    this.runtimeType = config.runtimeType;
    this.resolveProvider = createRuntimeResolver(toRuntimeConfig(config));
  }

  async launch(
    params: RuntimeLaunchRpcParams
  ): Promise<{ runtimeInstanceId: string }> {
    const ctx: RuntimeLaunchContext = {
      runtimeType: this.runtimeType,
      ownerId: params.ownerId,
      workspaceId: params.workspaceId,
      runId: params.runId,
      placement: params.placement,
      workerEnv: params.workerEnv,
      expectedRuntimeInstanceId: params.expectedRuntimeInstanceId,
    };
    const onExit = () => this.registry.remove(params.ownerId);
    const result = await this.provider().start(ctx, onExit);
    this.registry.record(params.ownerId, {
      runtimeInstanceId: result.runtimeInstanceId,
      isolationScope: isolationScopeOf(params),
    });
    return result;
  }

  async stop(params: RuntimeInstanceRefRpcParams): Promise<void> {
    await this.provider().stop(this.toRef(params));
    this.registry.remove(params.ownerId);
  }

  async destroy(params: RuntimeInstanceRefRpcParams): Promise<void> {
    await this.provider().destroy(this.toRef(params));
    this.registry.remove(params.ownerId);
  }

  private provider(): RuntimeProvider {
    return this.resolveProvider(this.runtimeType);
  }

  private toRef(params: RuntimeInstanceRefRpcParams): RuntimeInstanceRef {
    return {
      runtimeType: this.runtimeType,
      ownerId: params.ownerId,
      workerId: params.workerId,
      runtimeInstanceId: params.runtimeInstanceId,
      isolationScope: params.isolationScope,
    };
  }
}

/** native 无容器隔离语义,固定按 "workspace" 记账(与 server 侧 provisioner.identity() 同约定)。 */
function isolationScopeOf(params: RuntimeLaunchRpcParams): string {
  return params.placement.runtimeType === "native"
    ? "workspace"
    : params.placement.sandbox.isolationScope;
}

function toRuntimeConfig(config: RegisteredRuntimeConfig): RuntimeConfig {
  return {
    workerImage: config.workerImage ?? "",
    runtimeLogHostPath: config.runtimeLogHostPath,
    serverBaseUrl: config.serverBaseUrl,
    native: {
      // 默认 fork Registered Runtime 自身(同一产物,ROLE=worker 角色启动)——
      // Registered+native 场景下它与 worker 共用同一 bundle。
      runtimeEntryPath: config.runtimeEntryPath ?? process.argv[1] ?? "",
    },
    // 本 Registered Runtime 实例专一,不用 opensandbox 时这些字段是未用的占位值——
    // createRuntimeResolver 仍会装配 OpenSandboxRuntimeProvider(包的唯一装配
    // 出口),但只要 resolveProvider() 不取它,构造期不做校验,占位无害。
    openSandbox: {
      domain: "",
      protocol: "https",
      apiKey: undefined,
      useServerProxy: false,
    },
  };
}
