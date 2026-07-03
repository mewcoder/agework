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
import { LocalRuntimeProvider } from "./local/local-runtime.provider";
import { DockerRuntimeProvider } from "./sandbox/docker-runtime.provider";
import { OpenSandboxRuntimeProvider } from "./sandbox/opensandbox-runtime.provider";
import { RuntimeService } from "./runtime.service";
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

  it("compiles with zero imports and resolves runtime provider tokens", async () => {
    testingModule = await createRuntimeTestingModule([RuntimeModule]);

    expect(testingModule.get(OPENSANDBOX_CLIENT)).toBeInstanceOf(
      OpenSandboxClient
    );
    expect(testingModule.get(LocalRuntimeProvider)).toBeInstanceOf(
      LocalRuntimeProvider
    );
    expect(testingModule.get(DockerRuntimeProvider)).toBeInstanceOf(
      DockerRuntimeProvider
    );
    expect(testingModule.get(OpenSandboxRuntimeProvider)).toBeInstanceOf(
      OpenSandboxRuntimeProvider
    );
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
