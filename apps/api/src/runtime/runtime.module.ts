import { Module } from "@nestjs/common";

// core
import { WorkspaceRuntimeRepository } from "./resources/workspace-runtime.repository";
import { RuntimePlacementPolicy } from "./resources/placement.policy";
import { RuntimeResourceLifecycleUseCase } from "./resources/lifecycle.use-case";
import { RuntimeResourceLifecycleListener } from "./resources/lifecycle.listener";

// providers
import { RuntimeConfigStore } from "./internal/config-store";
import { LocalRuntimeProvider } from "./providers/local-provider";
import { DockerSandboxEngine } from "./providers/sandbox/engine/docker-engine";
import { OpenSandboxEngine } from "./providers/sandbox/engine/opensandbox-engine";
import { SandboxRuntimeProvider } from "./providers/sandbox/runtime-provider";
import { SandboxRuntimeResourceService } from "./providers/sandbox/runtime-resource.service";
import { SandboxWorkerSessionService } from "./providers/sandbox/worker-session.service";
import { OpenSandboxClient } from "./providers/sandbox/opensandbox-client";
import { OPENSANDBOX_CLIENT } from "./providers/sandbox/opensandbox-client.token";
import { RuntimeProviderRegistry } from "./providers/provider-registry";
import { RUNTIME_PROVIDERS } from "./providers/provider.token";
import { SANDBOX_ENGINES } from "./providers/sandbox/engine";
import type { RuntimeProvider } from "./providers/provider-contracts";
import type { SandboxEngine } from "./providers/sandbox/engine";

// internal
import { RuntimeWorkspaceController } from "./internal/workspace.controller";
import { RuntimeRuntimeController } from "./internal/runtime.controller";
import { RuntimeInternalAccessService } from "./internal/access.service";
import { RuntimeInternalAuthGuard } from "./internal/auth.guard";
import { RuntimeControlQueue } from "./internal/control-queue";

import { RuntimeService } from "./runtime.service";

// admin
import { AdminRuntimeController } from "./admin/admin-runtime.controller";

// external deps
import { ConfigService } from "../config/config.service";

/**
 * Runtime 领域：执行环境（provider / sandbox engine / placement）、workspace runtime
 * 资源生命周期、以及 worker 面向的 internal 控制面。对 run 层零依赖；run 事件经
 * RunEventReceiver 接口由 run 层在启动时注入（见 RunsModule）。
 */
@Module({
  controllers: [
    AdminRuntimeController,
    RuntimeWorkspaceController,
    RuntimeRuntimeController,
  ],
  providers: [
    // core
    WorkspaceRuntimeRepository,
    RuntimePlacementPolicy,
    RuntimeResourceLifecycleUseCase,
    RuntimeResourceLifecycleListener,
    // providers
    RuntimeConfigStore,
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
    SandboxRuntimeResourceService,
    SandboxWorkerSessionService,
    SandboxRuntimeProvider,
    {
      provide: RUNTIME_PROVIDERS,
      useFactory: (...providers: RuntimeProvider[]) => providers,
      inject: [LocalRuntimeProvider, SandboxRuntimeProvider],
    },
    RuntimeProviderRegistry,
    // internal
    RuntimeInternalAccessService,
    RuntimeInternalAuthGuard,
    RuntimeControlQueue,
    RuntimeService,
  ],
  exports: [
    WorkspaceRuntimeRepository,
    RuntimeService,
    RuntimeProviderRegistry,
    RuntimePlacementPolicy,
    RuntimeResourceLifecycleUseCase,
    // 供 RunsModule 的 run-internal controller 与 receiver 注入使用
    RuntimeControlQueue,
    RuntimeConfigStore,
    RuntimeInternalAuthGuard,
    RuntimeInternalAccessService,
  ],
})
export class RuntimeModule {}
