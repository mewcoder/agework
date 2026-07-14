import { Injectable, Module } from "@nestjs/common";
import { EventEmitterModule } from "@nestjs/event-emitter";
import { Test, type TestingModule } from "@nestjs/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigModule } from "../config/config.module";
import { ConfigService } from "../config/config.service";
import { PrismaModule } from "../prisma/prisma.module";
import { PrismaService } from "../prisma/prisma.service";
import { RuntimeHostService } from "./runtime-host.service";
import { RuntimeHostModule } from "./runtime-host.module";

@Injectable()
class DownstreamRuntimeConsumer {
  constructor(readonly runtimeService: RuntimeHostService) {}
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

  it("assembles the runtime module and resolves RuntimeHostService", async () => {
    testingModule = await createRuntimeTestingModule([RuntimeHostModule]);

    expect(testingModule.get(RuntimeHostService)).toBeInstanceOf(
      RuntimeHostService
    );
  });

  it("exports only RuntimeHostService to downstream modules", async () => {
    testingModule = await createRuntimeTestingModule([
      DownstreamRuntimeConsumerModule,
    ]);

    const consumer = testingModule.get(DownstreamRuntimeConsumer);
    expect(consumer.runtimeService).toBe(testingModule.get(RuntimeHostService));
  });
});

async function createRuntimeTestingModule(
  runtimeImports: Parameters<typeof Test.createTestingModule>[0]["imports"]
): Promise<TestingModule> {
  return Test.createTestingModule({
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
    .compile();
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
