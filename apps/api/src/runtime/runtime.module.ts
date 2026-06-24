import { Module } from "@nestjs/common";

// core
import { WorkspaceRuntimeRepository } from "./core/runtime-resources/workspace-runtime.repository";
import { RuntimePlacementPolicy } from "./core/runtime-resources/runtime-placement.policy";
import { RuntimeResourceLifecycleUseCase } from "./core/runtime-resources/runtime-resource-lifecycle.use-case";
import { RuntimeResourceLifecycleListener } from "./core/runtime-resources/runtime-resource-lifecycle.listener";

// providers
import { RuntimeConfigStore } from "./internal/runtime-config-store";
import { LocalRuntimeProvider } from "./providers/local-runtime-provider";
import { DockerSandboxEngine } from "./providers/sandbox-engine/docker-sandbox-engine";
import { OpenSandboxEngine } from "./providers/sandbox-engine/opensandbox-sandbox-engine";
import { SandboxRuntimeProvider } from "./providers/sandbox-runtime-provider";
import { OpenSandboxClient } from "./providers/opensandbox-client";
import { OPENSANDBOX_CLIENT } from "./providers/opensandbox-client.token";
import { RuntimeProviderRegistry } from "./providers/runtime-provider-registry";
import { RUNTIME_PROVIDERS } from "./providers/runtime-provider.token";
import { SANDBOX_ENGINES } from "./providers/sandbox-engine";
import type { RuntimeProvider } from "@agework/shared/protocol";
import type { SandboxEngine } from "./providers/sandbox-engine";

// internal
import { RuntimeWorkspaceController } from "./internal/runtime-workspace.controller";
import { RuntimeRuntimeController } from "./internal/runtime-runtime.controller";
import { RuntimeInternalAccessService } from "./internal/runtime-internal-access.service";
import { RuntimeInternalAuthGuard } from "./internal/runtime-internal-auth.guard";
import { RuntimeControlQueue } from "./internal/runtime-control-queue";

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
