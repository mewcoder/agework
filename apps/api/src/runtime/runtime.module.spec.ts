import { Injectable, Module } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigModule } from "../config/config.module";
import { ConfigService } from "../config/config.service";
import { PrismaModule } from "../prisma/prisma.module";
import { PrismaService } from "../prisma/prisma.service";
import {
  OpenSandboxClient,
  OPENSANDBOX_CLIENT,
} from "./sandbox/opensandbox-client";
import { SANDBOX_ENGINES, type SandboxEngine } from "./sandbox/sandbox-engine";
import {
  RuntimeProviderRegistry,
  RUNTIME_PROVIDERS,
} from "./providers/provider-registry";
import type { RuntimeProvider } from "./providers/provider-contracts";
import { RuntimeService } from "./runtime.service";
import { SandboxRuntimeInstanceService } from "./sandbox/sandbox-instance.service";
import { RuntimeModule } from "./runtime.module";

@Injectable()
class DownstreamRuntimeConsumer {
  constructor(
    readonly runtimeService: RuntimeService,
    // 仍导出的边界欠债：run 的 SandboxRunExecutor 依赖此 internal provider。
    readonly sandboxInstances: SandboxRuntimeInstanceService
  ) {}
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

  it("compiles and resolves runtime provider tokens", async () => {
    testingModule = await createRuntimeTestingModule([RuntimeModule]);

    const engines = testingModule.get<SandboxEngine[]>(SANDBOX_ENGINES);
    expect(engines.map((engine) => engine.type).sort()).toEqual([
      "docker",
      "opensandbox",
    ]);

    const runtimeProviders =
      testingModule.get<RuntimeProvider[]>(RUNTIME_PROVIDERS);
    expect(runtimeProviders.map((provider) => provider.type)).toEqual([
      "sandbox",
    ]);

    expect(testingModule.get(OPENSANDBOX_CLIENT)).toBeInstanceOf(
      OpenSandboxClient
    );
    expect(testingModule.get(RuntimeService)).toBeInstanceOf(RuntimeService);

    const registry = testingModule.get(RuntimeProviderRegistry);
    expect(registry.resolve("sandbox")).toBe(runtimeProviders[0]);
    expect(registry.resolve("local").type).toBe("local");
  });

  it("exports runtime services to downstream modules", async () => {
    testingModule = await createRuntimeTestingModule([
      DownstreamRuntimeConsumerModule,
    ]);

    const consumer = testingModule.get(DownstreamRuntimeConsumer);
    expect(consumer.runtimeService).toBe(testingModule.get(RuntimeService));
    expect(consumer.sandboxInstances).toBe(
      testingModule.get(SandboxRuntimeInstanceService)
    );
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
    getSandboxEngine: vi.fn().mockReturnValue("docker"),
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
