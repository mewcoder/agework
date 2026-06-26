import { Module, OnModuleInit } from "@nestjs/common";

// core
import { WorkspaceRuntimeInstanceRepository } from "./resources/workspace-runtime-instance.repository";
import { RuntimeInstanceLifecycleUseCase } from "./resources/lifecycle.use-case";
import { RuntimeInstanceLifecycleListener } from "./resources/lifecycle.listener";

// providers
import { LocalRuntimeProvider } from "./providers/local-provider";
import { DockerSandboxEngine } from "./providers/sandbox/engine/docker-engine";
import { OpenSandboxEngine } from "./providers/sandbox/engine/opensandbox-engine";
import { SandboxRuntimeProvider } from "./providers/sandbox/runtime-provider";
import { SandboxRuntimeInstanceService } from "./providers/sandbox/runtime-instance.service";
import { OpenSandboxClient } from "./providers/sandbox/opensandbox-client";
import { OPENSANDBOX_CLIENT } from "./providers/sandbox/opensandbox-client.token";
import { RuntimeProviderRegistry } from "./providers/provider-registry";
import { RUNTIME_PROVIDERS } from "./providers/provider.token";
import { SANDBOX_ENGINES } from "./providers/sandbox/engine";
import type { RuntimeProvider } from "./providers/provider-contracts";
import type { SandboxEngine } from "./providers/sandbox/engine";

import { RuntimeService } from "./runtime.service";

// admin
import { AdminRuntimeController } from "./admin/admin-runtime.controller";

// worker 通信基础设施（平级模块，runtime → worker-host）
import { WorkerHostModule } from "../worker-host/worker-host.module";
import { RuntimeHeartbeatRegistry } from "../worker-host/runtime-heartbeat.registry";

// external deps
import { ConfigService } from "../config/config.service";

/**
 * Runtime 领域：执行环境（provider / sandbox engine / placement）、workspace runtime
 * 资源生命周期、以及 worker 面向的 internal 控制面。对 run 层零依赖；run 事件经
 * RunEventReceiver 接口由 run 层在启动时注入（见 RunsModule）。
 */
@Module({
  imports: [WorkerHostModule],
  controllers: [AdminRuntimeController],
  providers: [
    // core
    WorkspaceRuntimeInstanceRepository,
    RuntimeInstanceLifecycleUseCase,
    RuntimeInstanceLifecycleListener,
    // providers
    LocalRuntimeProvider,
    DockerSandboxEngine,
    {
      provide: OPENSANDBOX_CLIENT,
      useFactory: (configService: ConfigService) =>
        new OpenSandboxClient(configService),
      inject: [ConfigService],
    },
    OpenSandboxEngine,
    {
      provide: SANDBOX_ENGINES,
      useFactory: (...engines: SandboxEngine[]) => engines,
      inject: [DockerSandboxEngine, OpenSandboxEngine],
    },
    SandboxRuntimeInstanceService,
    SandboxRuntimeProvider,
    {
      provide: RUNTIME_PROVIDERS,
      useFactory: (...providers: RuntimeProvider[]) => providers,
      inject: [LocalRuntimeProvider, SandboxRuntimeProvider],
    },
    RuntimeProviderRegistry,
    RuntimeService,
  ],
  exports: [
    WorkspaceRuntimeInstanceRepository,
    RuntimeService,
    RuntimeProviderRegistry,
    RuntimeInstanceLifecycleUseCase,
  ],
})
export class RuntimeModule implements OnModuleInit {
  constructor(
    private readonly heartbeatRegistry: RuntimeHeartbeatRegistry,
    private readonly runtimeService: RuntimeService
  ) {}

  onModuleInit(): void {
    // worker 经 worker-host 控制器上报的 runtime 实例心跳转发给 RuntimeService
    // （worker-host 只认 RuntimeInstanceHeartbeatSink 接口，不依赖 runtime 实现）。
    this.heartbeatRegistry.setSink(this.runtimeService);
  }
}
