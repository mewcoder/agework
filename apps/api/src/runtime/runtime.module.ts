import { Module, OnModuleInit } from "@nestjs/common";

// core
import { RunRepository } from "../runs/run.repository";
import { WorkspaceRuntimeRepository } from "./core/runtime-resources/workspace-runtime.repository";
import { RunActiveStore } from "../runs/execution/run-active.store";
import { RunEnvelopeProcessor } from "../runs/execution/run-envelope.processor";
import { RawEventLogWriter } from "../runs/events/raw-event-log.writer";
import {
  RunEventRecorder,
  RunEventStore,
} from "../runs/events/run-event-recorder";
import { RunEventQuery } from "../runs/events/run-event-query";
import { RunRecoveryUseCase } from "../runs/run-recovery.use-case";
import { RuntimePlacementPolicy } from "./core/runtime-resources/runtime-placement.policy";
import { RuntimeResourceLifecycleUseCase } from "./core/runtime-resources/runtime-resource-lifecycle.use-case";
import { RuntimeResourceLifecycleListener } from "./core/runtime-resources/runtime-resource-lifecycle.listener";
import { RunExecutionStatusHandler } from "../runs/execution/run-execution-status.handler";

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
import { RuntimeInternalController } from "./internal/runtime-internal.controller";
import { RuntimeWorkspaceController } from "./internal/runtime-workspace.controller";
import { RuntimeRuntimeController } from "./internal/runtime-runtime.controller";
import { RuntimeInternalAccessService } from "./internal/runtime-internal-access.service";
import { RuntimeInternalAuthGuard } from "./internal/runtime-internal-auth.guard";
import { RuntimeControlQueue } from "./internal/runtime-control-queue";

// runner
import { RunService } from "../runs/run.service";
import { RunConfigAssembler } from "../runs/run-config.assembler";
import { RunEventReceiverImpl } from "../runs/execution/run-event-receiver";
import { RuntimeService } from "./runtime.service";

// admin
import { AdminRunController } from "./admin/admin-run.controller";
import { AdminRuntimeController } from "./admin/admin-runtime.controller";

// external deps
import { ConversationModule } from "../conversations/conversation.module";
import { ModelProviderModule } from "../model-providers/model-provider.module";
import { ConfigService } from "../config/config.service";

@Module({
  imports: [ConversationModule, ModelProviderModule],
  controllers: [
    AdminRunController,
    AdminRuntimeController,
    RuntimeInternalController,
    RuntimeWorkspaceController,
    RuntimeRuntimeController,
  ],
  providers: [
    // core
    RunRepository,
    WorkspaceRuntimeRepository,
    RunActiveStore,
    RunEnvelopeProcessor,
    RawEventLogWriter,
    RunEventStore,
    RunEventRecorder,
    RunEventQuery,
    RunRecoveryUseCase,
    RuntimePlacementPolicy,
    RuntimeResourceLifecycleUseCase,
    RuntimeResourceLifecycleListener,
    RunExecutionStatusHandler,
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
    // runner
    RunService,
    RunConfigAssembler,
    RunEventReceiverImpl,
    RuntimeService,
  ],
  exports: [
    RunRepository,
    WorkspaceRuntimeRepository,
    RunService,
    RunConfigAssembler,
    RuntimeService,
    RuntimeProviderRegistry,
    RuntimePlacementPolicy,
    RuntimeResourceLifecycleUseCase,
  ],
})
export class RuntimeModule implements OnModuleInit {
  constructor(
    private readonly runRecovery: RunRecoveryUseCase,
    private readonly providerRegistry: RuntimeProviderRegistry,
    private readonly runEventReceiver: RunEventReceiverImpl
  ) {}

  async onModuleInit() {
    // run 层把事件 receiver 注入每个 runtime provider（provider 不直接依赖 run 实现）
    this.providerRegistry.setRunEventReceiver(this.runEventReceiver);
    await this.runRecovery.recoverOrphanRuns();
  }
}
