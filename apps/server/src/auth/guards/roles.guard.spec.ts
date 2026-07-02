import { describe, it, expect, vi } from "vitest";
import { Reflector } from "@nestjs/core";
import { ForbiddenException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import { RolesGuard } from "./roles.guard";
import type { JwtUser } from "../decorators/current-user.decorator";

function makeContext(user?: JwtUser): ExecutionContext {
  const request = { user };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
    getHandler: () => vi.fn(),
    getClass: () => vi.fn(),
  } as unknown as ExecutionContext;
}

function makeGuard(roles?: string[]) {
  const reflector = new Reflector();
  vi.spyOn(reflector, "getAllAndOverride").mockReturnValue(roles ?? []);
  return new RolesGuard(reflector);
}

describe("RolesGuard", () => {
  it("allows access when no roles are required", () => {
    const guard = makeGuard(undefined);
    expect(guard.canActivate(makeContext())).toBe(true);
  });

  it("allows access when roles array is empty", () => {
    const guard = makeGuard([]);
    expect(guard.canActivate(makeContext())).toBe(true);
  });

  it("allows access when user has the required role", () => {
    const guard = makeGuard(["admin"]);
    const user: JwtUser = {
      userId: "1",
      username: "admin1",
      role: "admin",
      status: "active",
      mustChangePassword: false,
      sessionVersion: 1,
    };
    expect(guard.canActivate(makeContext(user))).toBe(true);
  });

  it("throws ForbiddenException when user lacks the required role", () => {
    const guard = makeGuard(["admin"]);
    const user: JwtUser = {
      userId: "1",
      username: "regular",
      role: "user",
      status: "active",
      mustChangePassword: false,
      sessionVersion: 1,
    };
    expect(() => guard.canActivate(makeContext(user))).toThrow(
      ForbiddenException
    );
  });

  it("allows super_admin to access admin-required routes", () => {
    const guard = makeGuard(["admin"]);
    const user: JwtUser = {
      userId: "1",
      username: "super",
      role: "super_admin",
      status: "active",
      mustChangePassword: false,
      sessionVersion: 1,
    };
    expect(guard.canActivate(makeContext(user))).toBe(true);
  });

  it("throws ForbiddenException when user is not present", () => {
    const guard = makeGuard(["admin"]);
    expect(() => guard.canActivate(makeContext(undefined))).toThrow(
      ForbiddenException
    );
  });

  it("allows access when user role is in the required roles list", () => {
    const guard = makeGuard(["admin", "user"]);
    const user: JwtUser = {
      userId: "1",
      username: "u",
      role: "user",
      status: "active",
      mustChangePassword: false,
      sessionVersion: 1,
    };
    expect(guard.canActivate(makeContext(user))).toBe(true);
  });
});
