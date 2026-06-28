import { Module } from "@nestjs/common";

// core
import { WorkspaceRuntimeInstanceRepository } from "./instances/workspace-runtime-instance.repository";
import { RuntimeInstanceLifecycleUseCase } from "./instances/lifecycle.use-case";
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

import { RuntimeService } from "./runtime.service";

// admin
import { AdminRuntimeController } from "./admin/admin-runtime.controller";

// external deps
import { ConfigService } from "../config/config.service";

/**
 * Runtime 领域：运行环境 placement、sandbox engine、workspace runtime resource
 * 生命周期。它不启动 worker、不处理 run command；per-run execution 在 runs 模块。
 */
@Module({
  controllers: [AdminRuntimeController],
  providers: [
    // core
    WorkspaceRuntimeInstanceRepository,
    RuntimeInstanceLifecycleUseCase,
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
    RuntimeService,
  ],
  exports: [
    // 公开面：根 Service 是 runtime 唯一稳定对外入口。
    RuntimeService,
    // 边界欠债（非公开面）：run 模块的 SandboxRunExecutor 与 RunModule 直接依赖下面两个
    // internal provider。这是 run<->runtime 的深耦合，按 docs/todo/
    // agent-run-runtime-layering-review.md 的分层迁移由 RuntimeService 门面收口后移除。
    // common/module-boundary.spec.ts 已把这两条登记为 KNOWN_BOUNDARY_DEBT，禁止再扩散。
    SandboxRuntimeInstanceService,
    RuntimeProviderRegistry,
  ],
})
export class RuntimeModule {}
