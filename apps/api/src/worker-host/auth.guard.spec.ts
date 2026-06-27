import { describe, it, expect, vi } from "vitest";
import { UnauthorizedException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import { WorkerAuthGuard } from "./auth.guard";
import type { WorkerAccessService } from "./access.service";

function makeGuard(access?: Partial<WorkerAccessService>) {
  const runtimeAccess = {
    verifyAccessKey: vi.fn().mockReturnValue(false),
    verifyOwnerKey: vi.fn().mockReturnValue(false),
    diagnostics: vi.fn().mockReturnValue({}),
    ...access,
  };
  return {
    guard: new WorkerAuthGuard(
      runtimeAccess as unknown as WorkerAccessService
    ),
    runtimeAccess,
  };
}

function makeContext(params: Record<string, string>, authHeader?: string) {
  const request = {
    headers: authHeader ? { authorization: authHeader } : {},
    params,
    runId: undefined as string | undefined,
    ownerId: undefined as string | undefined,
  };
  return {
    context: {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as unknown as ExecutionContext,
    request,
  };
}

describe("WorkerAuthGuard", () => {
  it("rejects when no bearer token is provided", async () => {
    const { guard } = makeGuard();
    const { context } = makeContext({ runId: "run-1" });
    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException
    );
  });

  it("verifies run access key when runId is in params", async () => {
    const { guard, runtimeAccess } = makeGuard({
      verifyAccessKey: vi.fn().mockReturnValue(true),
    });
    const { context, request } = makeContext(
      { runId: "run-1" },
      "Bearer key-123"
    );

    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(runtimeAccess.verifyAccessKey).toHaveBeenCalledWith(
      "run-1",
      "key-123"
    );
    expect(request.runId).toBe("run-1");
  });

  it("verifies owner key when ownerId is in params", async () => {
    const { guard, runtimeAccess } = makeGuard({
      verifyOwnerKey: vi.fn().mockReturnValue(true),
    });
    const { context, request } = makeContext(
      { ownerId: "owner-1" },
      "Bearer owner-key"
    );

    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(runtimeAccess.verifyOwnerKey).toHaveBeenCalledWith(
      "owner-1",
      "owner-key"
    );
    expect(request.ownerId).toBe("owner-1");
  });

  it("rejects when no key matches", async () => {
    const { guard } = makeGuard();
    const { context } = makeContext({ runId: "run-1" }, "Bearer wrong-key");
    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException
    );
  });
});
