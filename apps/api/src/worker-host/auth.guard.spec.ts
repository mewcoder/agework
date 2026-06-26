import { describe, it, expect, vi } from "vitest";
import { UnauthorizedException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import { RuntimeInternalAuthGuard } from "./auth.guard";
import type { RuntimeInternalAccessService } from "./access.service";

function makeGuard(access?: Partial<RuntimeInternalAccessService>) {
  const runtimeAccess = {
    verifyAccessKey: vi.fn().mockReturnValue(false),
    verifyWorkspaceKey: vi.fn().mockReturnValue(false),
    verifyRuntimeInstanceKey: vi.fn().mockReturnValue(false),
    diagnostics: vi.fn().mockReturnValue({}),
    ...access,
  };
  return {
    guard: new RuntimeInternalAuthGuard(
      runtimeAccess as unknown as RuntimeInternalAccessService
    ),
    runtimeAccess,
  };
}

function makeContext(params: Record<string, string>, authHeader?: string) {
  const request = {
    headers: authHeader ? { authorization: authHeader } : {},
    params,
    runId: undefined as string | undefined,
    workspaceId: undefined as string | undefined,
    runtimeInstanceId: undefined as string | undefined,
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

describe("RuntimeInternalAuthGuard", () => {
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

  it("verifies workspace key when workspaceId is in params", async () => {
    const { guard, runtimeAccess } = makeGuard({
      verifyWorkspaceKey: vi.fn().mockReturnValue(true),
    });
    const { context, request } = makeContext(
      { workspaceId: "ws-1" },
      "Bearer ws-key"
    );

    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(runtimeAccess.verifyWorkspaceKey).toHaveBeenCalledWith(
      "ws-1",
      "ws-key"
    );
    expect(request.workspaceId).toBe("ws-1");
  });

  it("verifies runtime instance key when runtimeInstanceId is in params", async () => {
    const { guard, runtimeAccess } = makeGuard({
      verifyRuntimeInstanceKey: vi.fn().mockReturnValue(true),
    });
    const { context, request } = makeContext(
      { runtimeInstanceId: "ri-1" },
      "Bearer ri-key"
    );

    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(runtimeAccess.verifyRuntimeInstanceKey).toHaveBeenCalledWith(
      "ri-1",
      "ri-key"
    );
    expect(request.runtimeInstanceId).toBe("ri-1");
  });

  it("rejects when no key matches", async () => {
    const { guard } = makeGuard();
    const { context } = makeContext({ runId: "run-1" }, "Bearer wrong-key");
    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException
    );
  });
});
