import { Inject, Injectable, Module } from "@nestjs/common";
import { EventEmitterModule } from "@nestjs/event-emitter";
import { Test, type TestingModule } from "@nestjs/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigModule } from "../config/config.module";
import { ConfigService } from "../config/config.service";
import { PrismaModule } from "../prisma/prisma.module";
import { PrismaService } from "../prisma/prisma.service";
import { RuntimeHostService } from "./runtime-host.service";
import { RuntimeHostModule } from "./runtime-host.module";
import { BUILTIN_RUNTIME_HOST } from "./contract/builtin-runtime-host";
import type {
  RuntimeHostEnvironment,
  RuntimeHostWorkspaceData,
} from "@agework/shared/protocol";
import {
  RUNTIME_HOST_ENVIRONMENT,
  RUNTIME_HOST_OWNER_RECONCILIATION,
  RUNTIME_HOST_WORKSPACE_DATA,
  type RuntimeHostOwnerReconciliation,
} from "./runtime-host.types";

@Injectable()
class DownstreamRuntimeConsumer {
  constructor(
    readonly runtimeHostService: RuntimeHostService,
    @Inject(RUNTIME_HOST_OWNER_RECONCILIATION)
    readonly ownerReconciliation: RuntimeHostOwnerReconciliation,
    @Inject(RUNTIME_HOST_ENVIRONMENT)
    readonly environment: RuntimeHostEnvironment,
    @Inject(RUNTIME_HOST_WORKSPACE_DATA)
    readonly workspaceData: RuntimeHostWorkspaceData
  ) {}
}

@Module({
  imports: [RuntimeHostModule],
  providers: [DownstreamRuntimeConsumer],
})
class DownstreamRuntimeConsumerModule {}

describe("RuntimeHostModule wiring", () => {
  let testingModule: TestingModule | undefined;

  afterEach(async () => {
    await testingModule?.close();
    testingModule = undefined;
    vi.restoreAllMocks();
  });

  it("assembles the Runtime Host module and resolves RuntimeHostService", async () => {
    testingModule = await createRuntimeTestingModule([RuntimeHostModule]);

    expect(testingModule.get(RuntimeHostService)).toBeInstanceOf(
      RuntimeHostService
    );
  });

  it("exports the root Service and narrow role ports to downstream modules", async () => {
    testingModule = await createRuntimeTestingModule([
      DownstreamRuntimeConsumerModule,
    ]);

    const consumer = testingModule.get(DownstreamRuntimeConsumer);
    expect(consumer.runtimeHostService).toBe(
      testingModule.get(RuntimeHostService)
    );
    expect(consumer.ownerReconciliation).toBeDefined();
    expect(consumer.environment).toBeDefined();
    expect(consumer.workspaceData).toBeDefined();
  });
});

async function createRuntimeTestingModule(
  runtimeImports: Parameters<typeof Test.createTestingModule>[0]["imports"]
): Promise<TestingModule> {
  return (
    Test.createTestingModule({
      // EventEmitterModule 在 app 根是全局注册,测试装配里手动补上
      imports: [
        ConfigModule,
        PrismaModule,
        EventEmitterModule.forRoot(),
        ...(runtimeImports ?? []),
      ],
    })
      .overrideProvider(ConfigService)
      .useValue(createConfigServiceMock())
      .overrideProvider(PrismaService)
      .useValue({})
      // builtin Host 工厂会装配 WorkerHttpServer,模块装配测试不需要真实例
      .overrideProvider(BUILTIN_RUNTIME_HOST)
      .useValue({})
      .compile()
  );
}

function createConfigServiceMock(): Partial<ConfigService> {
  return {
    getDefaultRuntimeType: vi.fn().mockReturnValue("native"),
    getApiBasePath: vi.fn().mockReturnValue("/api/v1"),
    getDefaultWorkerScope: vi.fn().mockReturnValue("workspace"),
    getRuntimeLogDir: vi.fn().mockReturnValue("/tmp/agework-runtime-logs"),
    getIdleTimeoutSeconds: vi.fn().mockReturnValue(600),
    getOpenSandboxConfig: vi.fn().mockReturnValue({
      domain: "opensandbox.test",
      protocol: "https",
      apiKey: "test-key",
      image: "agework-worker:test",
      timeoutSeconds: 300,
      useServerProxy: false,
    }),
  };
}
