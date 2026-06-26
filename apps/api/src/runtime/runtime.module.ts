import { Module } from "@nestjs/common";

// core
import { WorkspaceRuntimeInstanceRepository } from "./instances/workspace-runtime-instance.repository";
import { RuntimeInstanceLifecycleUseCase } from "./instances/lifecycle.use-case";
import { RuntimeInstanceLifecycleListener } from "./instances/lifecycle.listener";

// providers
import { LocalRuntimeProvider } from "./providers/local-provider";
import { DockerSandboxEngine } from "./sandbox/docker-engine";
import { OpenSandboxEngine } from "./sandbox/opensandbox-engine";
import { SandboxRuntimeProvider } from "./sandbox/sandbox-provider";
import { SandboxRuntimeInstanceService } from "./sandbox/sandbox-instance.service";
import {
  OpenSandboxClient,
  OPENSANDBOX_CLIENT,
} from "./sandbox/opensandbox-client";
import {
  RuntimeProviderRegistry,
  RUNTIME_PROVIDERS,
} from "./providers/provider-registry";
import { SANDBOX_ENGINES } from "./sandbox/sandbox-engine";
import type { RuntimeProvider } from "./providers/provider-contracts";
import type { SandboxEngine } from "./sandbox/sandbox-engine";

import { RuntimeService } from "./runtime.service";

// admin
import { AdminRuntimeController } from "./admin/admin-runtime.controller";

// external deps
import { ConfigService } from "../config/config.service";

/**
 * Runtime 领域：执行环境（provider / sandbox engine / placement）、workspace runtime
 * 资源生命周期。对 worker-host 零依赖：run 事件、命令通道、鉴权通道、心跳 sink 均
 * 为 runtime 定义的 port，由 run 层在启动时注入实现（见 RunsModule）。
 */
@Module({
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
export class RuntimeModule {}
