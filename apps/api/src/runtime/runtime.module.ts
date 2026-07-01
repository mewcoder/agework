import { Module } from "@nestjs/common";

// core
import { RuntimeInstanceLifecycleService } from "./instances/lifecycle.service";
import { RuntimeInstanceLifecycleListener } from "./instances/lifecycle.listener";

import { DockerSandboxEngine } from "./sandbox/docker-engine";
import { OpenSandboxEngine } from "./sandbox/opensandbox-engine";
import { SandboxRuntimeInstanceManager } from "./sandbox/sandbox-runtime-instance.manager";
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

import { LocalRuntimeProvider } from "./local/local-runtime.provider";
import { RuntimeService } from "./runtime.service";

// admin
import { AdminRuntimeController } from "./admin/admin-runtime.controller";

// external deps
import { ConfigService } from "../config/config.service";
import { WorkerHostModule } from "../worker-host/worker-host.module";

/**
 * Runtime 领域：运行环境 placement、sandbox engine、workspace runtime resource
 * 生命周期。它不启动 worker、不处理 run command；per-run execution 在 runs 模块。
 */
@Module({
  imports: [WorkerHostModule],
  controllers: [AdminRuntimeController],
  providers: [
    // core
    RuntimeInstanceLifecycleService,
    RuntimeInstanceLifecycleListener,
    // providers
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
    SandboxRuntimeInstanceManager,
    {
      provide: RUNTIME_PROVIDERS,
      useFactory: (...providers: RuntimeProvider[]) => providers,
      inject: [SandboxRuntimeInstanceManager],
    },
    RuntimeProviderRegistry,
    LocalRuntimeProvider,
    RuntimeService,
  ],
  exports: [
    // 公开面：根 Service 是 runtime 唯一稳定对外入口。
    RuntimeService,
  ],
})
export class RuntimeModule {}
