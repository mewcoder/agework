import { Injectable, Module } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeProvider, RuntimeType } from "@agework/runtime";
import { ConfigModule } from "../config/config.module";
import { ConfigService } from "../config/config.service";
import { PrismaModule } from "../prisma/prisma.module";
import { PrismaService } from "../prisma/prisma.service";
import { RuntimeService, RUNTIME_PROVIDERS } from "./runtime.service";
import { RuntimeModule } from "./runtime.module";

@Injectable()
class DownstreamRuntimeConsumer {
  constructor(readonly runtimeService: RuntimeService) {}
}

@Module({
  imports: [RuntimeModule],
  providers: [DownstreamRuntimeConsumer],
})
class DownstreamRuntimeConsumerModule {}

describe("RuntimeModule wiring", () => {
  let testingModule: TestingModule | undefined;

  afterEach(async () => {
    await testingModule?.close();
    testingModule = undefined;
    vi.restoreAllMocks();
  });

  it("assembles the provider registry (local/docker/opensandbox) from config and resolves RuntimeService", async () => {
    testingModule = await createRuntimeTestingModule([RuntimeModule]);

    const providers =
      testingModule.get<Map<RuntimeType, RuntimeProvider>>(RUNTIME_PROVIDERS);
    expect([...providers.keys()].sort()).toEqual([
      "docker",
      "local",
      "opensandbox",
    ]);
    expect(providers.get("docker")?.type).toBe("docker");
    expect(testingModule.get(RuntimeService)).toBeInstanceOf(RuntimeService);
  });

  it("exports only RuntimeService to downstream modules", async () => {
    testingModule = await createRuntimeTestingModule([
      DownstreamRuntimeConsumerModule,
    ]);

    const consumer = testingModule.get(DownstreamRuntimeConsumer);
    expect(consumer.runtimeService).toBe(testingModule.get(RuntimeService));
  });
});

async function createRuntimeTestingModule(
  runtimeImports: Parameters<typeof Test.createTestingModule>[0]["imports"]
): Promise<TestingModule> {
  return Test.createTestingModule({
    imports: [ConfigModule, PrismaModule, ...(runtimeImports ?? [])],
  })
    .overrideProvider(ConfigService)
    .useValue(createConfigServiceMock())
    .overrideProvider(PrismaService)
    .useValue({})
    .compile();
}

function createConfigServiceMock(): Partial<ConfigService> {
  return {
    getDefaultRuntimeType: vi.fn().mockReturnValue("local"),
    getDefaultIsolationScope: vi.fn().mockReturnValue("workspace"),
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
