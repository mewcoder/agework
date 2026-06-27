import { describe, it, expect } from "vitest";
import type { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import {
  ThrottlerGuard,
  ThrottlerStorageService,
  ThrottlerException,
} from "@nestjs/throttler";
import {
  AUTH_THROTTLERS,
  AUTH_THROTTLER_IP,
  AUTH_THROTTLER_IP_USERNAME,
} from "./auth-throttler";

const ipThrottler = AUTH_THROTTLERS.find((t) => t.name === AUTH_THROTTLER_IP)!;
const ipUserThrottler = AUTH_THROTTLERS.find(
  (t) => t.name === AUTH_THROTTLER_IP_USERNAME
)!;

// generateKey 用 class.name + handler.name 组键，跨调用必须用同一引用才能命中同一桶。
const handler = function login() {};
class AuthController {}

function contextFor(req: Record<string, unknown>): ExecutionContext {
  const res = { header: () => {} };
  return {
    getHandler: () => handler,
    getClass: () => AuthController,
    getType: () => "http",
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
}

async function makeGuard() {
  const guard = new ThrottlerGuard(
    AUTH_THROTTLERS,
    new ThrottlerStorageService(),
    new Reflector()
  );
  await guard.onModuleInit();
  return guard;
}

describe("auth throttler trackers", () => {
  const ctx = contextFor({});

  it("ip bucket keys on source ip", async () => {
    expect(await ipThrottler.getTracker!({ ip: "1.2.3.4" }, ctx)).toBe(
      "1.2.3.4"
    );
  });

  it("ip-username bucket keys on ip + normalized username", async () => {
    expect(
      await ipUserThrottler.getTracker!(
        { ip: "1.2.3.4", body: { username: "  Alice " } },
        ctx
      )
    ).toBe("1.2.3.4:alice");
  });

  it("ip-username bucket falls back to ip when username is absent", async () => {
    expect(
      await ipUserThrottler.getTracker!({ ip: "1.2.3.4", body: {} }, ctx)
    ).toBe("1.2.3.4:");
  });
});

describe("auth throttler enforcement", () => {
  it("blocks after exceeding the per-username limit", async () => {
    const guard = await makeGuard();
    const req = { ip: "9.9.9.9", body: { username: "alice" } };
    const limit = ipUserThrottler.limit as number;

    for (let i = 0; i < limit; i += 1) {
      await expect(guard.canActivate(contextFor(req))).resolves.toBe(true);
    }
    await expect(guard.canActivate(contextFor(req))).rejects.toBeInstanceOf(
      ThrottlerException
    );
  });

  it("throttles unknown usernames too (counted at guard layer, before any user lookup)", async () => {
    const guard = await makeGuard();
    const req = { ip: "8.8.8.8", body: { username: "ghost-never-created" } };
    const limit = ipUserThrottler.limit as number;

    for (let i = 0; i < limit; i += 1) {
      await guard.canActivate(contextFor(req));
    }
    await expect(guard.canActivate(contextFor(req))).rejects.toBeInstanceOf(
      ThrottlerException
    );
  });
});
