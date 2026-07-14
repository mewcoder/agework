import { Injectable, Module, type Type } from "@nestjs/common";
import { EventEmitterModule } from "@nestjs/event-emitter";
import { APP_GUARD } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { getOptionsToken, getStorageToken } from "@nestjs/throttler";
import { Test, type TestingModule } from "@nestjs/testing";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { ConfigModule } from "../config/config.module";
import { ConfigService } from "../config/config.service";
import { PrismaModule } from "../prisma/prisma.module";
import { PrismaService } from "../prisma/prisma.service";
import { BUILTIN_RUNTIME_HOST } from "../runtime-host/contract/builtin-runtime-host";
const previousJwtSecret = vi.hoisted(() => {
  const previousSecret = process.env.AGEWORK_PRIVATE_JWT_SECRET;
  process.env.AGEWORK_PRIVATE_JWT_SECRET = "auth-module-wiring-secret";
  return previousSecret;
});

import { AuthService } from "./auth.service";
import { AuthModule } from "./auth.module";
import { AUTH_THROTTLERS } from "./guards/auth-throttler";
import { JwtAuthGuard } from "./guards/jwt-auth.guard";
import { RolesGuard } from "./guards/roles.guard";

@Injectable()
class DownstreamAuthConsumer {
  constructor(readonly authService: AuthService) {}
}

describe("AuthModule wiring", () => {
  let testingModule: TestingModule | undefined;

  afterAll(() => {
    if (previousJwtSecret === undefined) {
      delete process.env.AGEWORK_PRIVATE_JWT_SECRET;
    } else {
      process.env.AGEWORK_PRIVATE_JWT_SECRET = previousJwtSecret;
    }
  });

  afterEach(async () => {
    await testingModule?.close();
    testingModule = undefined;
    vi.restoreAllMocks();
  });

  it("compiles global guards with JwtModule and ThrottlerModule providers", async () => {
    testingModule = await createAuthTestingModule([AuthModule]);

    const guardMetatypes = getAppGuardMetatypes(testingModule);
    expect(guardMetatypes).toHaveLength(2);
    expect(guardMetatypes).toEqual(
      expect.arrayContaining([JwtAuthGuard, RolesGuard])
    );

    const jwtService = testingModule.get(JwtService);
    const token = jwtService.sign({ sub: "user-1" });
    expect(jwtService.verify(token)).toMatchObject({ sub: "user-1" });

    expect(testingModule.get(getOptionsToken())).toBe(AUTH_THROTTLERS);
    expect(testingModule.get(getStorageToken())).toBeDefined();
  });

  it("exports AuthService to downstream modules", async () => {
    testingModule = await createAuthTestingModule([
      makeDownstreamAuthConsumerModule(AuthModule),
    ]);

    const consumer = testingModule.get(DownstreamAuthConsumer);
    expect(consumer.authService).toBe(testingModule.get(AuthService));
  });
});

function makeDownstreamAuthConsumerModule(AuthModule: Type<unknown>) {
  @Module({
    imports: [AuthModule],
    providers: [DownstreamAuthConsumer],
  })
  class DownstreamAuthConsumerModule {}

  return DownstreamAuthConsumerModule;
}

async function createAuthTestingModule(
  authImports: Parameters<typeof Test.createTestingModule>[0]["imports"]
): Promise<TestingModule> {
  return (
    Test.createTestingModule({
      imports: [
        EventEmitterModule.forRoot(),
        ConfigModule,
        PrismaModule,
        ...(authImports ?? []),
      ],
    })
      .overrideProvider(ConfigService)
      .useValue(createConfigServiceMock())
      .overrideProvider(PrismaService)
      .useValue({})
      // UserModule → RuntimeHostModule 会装配 builtin Host,测试不需要真实例
      .overrideProvider(BUILTIN_RUNTIME_HOST)
      .useValue({})
      .compile()
  );
}

function createConfigServiceMock(): Partial<ConfigService> {
  return {
    isDevAuthDisabled: vi.fn().mockReturnValue(false),
    getAppName: vi.fn().mockReturnValue("AgeWork"),
    requiresAdminInitKey: vi.fn().mockReturnValue(false),
    getAdminInitKey: vi.fn().mockReturnValue(undefined),
    isProduction: vi.fn().mockReturnValue(false),
    getApiBasePath: vi.fn().mockReturnValue("/api/v1"),
    getRuntimeLogDir: vi.fn().mockReturnValue("/tmp/agework-runtime-logs"),
  };
}

function getAppGuardMetatypes(testingModule: TestingModule): unknown[] {
  const container = (
    testingModule as unknown as {
      container: { getModules(): Map<unknown, NestModuleRef> };
    }
  ).container;
  const authModule = [...container.getModules().values()].find(
    (moduleRef) => moduleRef.metatype?.name === "AuthModule"
  );
  if (!authModule) return [];

  return [...authModule.providers.values()]
    .filter(
      (wrapper) =>
        typeof wrapper.token === "string" &&
        wrapper.token.startsWith(`${APP_GUARD} (UUID: `)
    )
    .map((wrapper) => wrapper.metatype);
}

type NestModuleRef = {
  metatype?: { name?: string };
  providers: Map<unknown, { token: unknown; metatype?: unknown }>;
};
