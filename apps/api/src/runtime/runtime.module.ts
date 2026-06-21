import { Module, OnModuleInit } from "@nestjs/common";

// core
import { RunRecordService } from "./core/run-record.service";
import { WorkspaceRuntimeService } from "./core/workspace-runtime.service";
import { RuntimeActiveStore } from "./core/runtime-active-store";
import { RuntimeEventProcessor } from "./core/runtime-event-processor";
import { AgentEventLogService } from "./core/agent-event-log.service";
import { RunEventRecordService } from "./core/run-event-record.service";
import { RunRecoveryService } from "./core/run-recovery.service";
import { RuntimePlacementService } from "./core/runtime-placement.service";
import { RuntimeLifecycleService } from "./core/runtime-lifecycle.service";

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
import { RuntimeRunner } from "./core/runtime-runner";

// admin
import { AdminRunController } from "./admin/admin-run.controller";
import { AdminRuntimeController } from "./admin/admin-runtime.controller";

// external deps
import { ConversationModule } from "../conversations/conversation.module";
import { ConfigService } from "../config/config.service";

@Module({
  imports: [ConversationModule],
  controllers: [
    AdminRunController,
    AdminRuntimeController,
    RuntimeInternalController,
    RuntimeWorkspaceController,
    RuntimeRuntimeController,
  ],
  providers: [
    // core
    RunRecordService,
    WorkspaceRuntimeService,
    RuntimeActiveStore,
    RuntimeEventProcessor,
    AgentEventLogService,
    RunEventRecordService,
    RunRecoveryService,
    RuntimePlacementService,
    RuntimeLifecycleService,
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
    RuntimeRunner,
  ],
  exports: [
    RunRecordService,
    WorkspaceRuntimeService,
    RuntimeRunner,
    RuntimeProviderRegistry,
    RuntimePlacementService,
    RuntimeLifecycleService,
  ],
})
export class RuntimeModule implements OnModuleInit {
  constructor(private readonly runRecovery: RunRecoveryService) {}

  async onModuleInit() {
    await this.runRecovery.recoverOrphanRuns();
  }
}
