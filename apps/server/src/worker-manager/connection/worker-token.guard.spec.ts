import { describe, it, expect, vi } from "vitest";
import { HttpException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import {
  WORKER_ID_HEADER,
  WORKER_TOKEN_HEADER,
} from "@agework/shared/protocol";
import type { RuntimeHost } from "@agework/runtime/host";
import { WorkerTokenGuard } from "./worker-token.guard";

function makeContext(
  params: Record<string, string> | undefined,
  headers: Record<string, string | undefined>
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ params, headers }),
    }),
  } as unknown as ExecutionContext;
}

function makeHost(valid: boolean) {
  return {
    validateWorkerToken: vi.fn().mockReturnValue(valid),
  };
}

function makeGuard(host: ReturnType<typeof makeHost>) {
  return new WorkerTokenGuard(host as unknown as RuntimeHost);
}

describe("WorkerTokenGuard", () => {
  it("allows the request through when the token matches the worker's pool entry", () => {
    const host = makeHost(true);
    const guard = makeGuard(host);

    const context = makeContext(
      { workerId: "worker-1" },
      { [WORKER_TOKEN_HEADER]: "token-1" }
    );

    expect(guard.canActivate(context)).toBe(true);
    expect(host.validateWorkerToken).toHaveBeenCalledWith(
      "worker-1",
      "token-1"
    );
  });

  it("rejects with 410 when the token does not match (孤儿 worker 自清路径)", () => {
    const host = makeHost(false);
    const guard = makeGuard(host);

    const context = makeContext(
      { workerId: "worker-1" },
      { [WORKER_TOKEN_HEADER]: "wrong-token" }
    );

    expect(() => guard.canActivate(context)).toThrow(
      expect.objectContaining({ status: 410 })
    );
  });

  it("rejects with 410 when the token header is missing", () => {
    const host = makeHost(true);
    const guard = makeGuard(host);

    const context = makeContext({ workerId: "worker-1" }, {});

    expect(() => guard.canActivate(context)).toThrow(
      expect.objectContaining({ status: 410 })
    );
    expect(host.validateWorkerToken).not.toHaveBeenCalled();
  });

  it("rejects with 410 when neither a route param nor a header provides workerId", () => {
    const host = makeHost(true);
    const guard = makeGuard(host);

    const context = makeContext(undefined, {
      [WORKER_TOKEN_HEADER]: "token-1",
    });

    expect(() => guard.canActivate(context)).toThrow(
      expect.objectContaining({ status: 410 })
    );
    expect(host.validateWorkerToken).not.toHaveBeenCalled();
  });

  it("prefers the route param workerId over the header when both are present", () => {
    const host = makeHost(true);
    const guard = makeGuard(host);

    const context = makeContext(
      { workerId: "worker-from-param" },
      {
        [WORKER_ID_HEADER]: "worker-from-header",
        [WORKER_TOKEN_HEADER]: "token-1",
      }
    );

    expect(guard.canActivate(context)).toBe(true);
    expect(host.validateWorkerToken).toHaveBeenCalledWith(
      "worker-from-param",
      "token-1"
    );
  });

  it("falls back to the worker-id header when there is no route param (runs endpoints)", () => {
    const host = makeHost(true);
    const guard = makeGuard(host);

    const context = makeContext(undefined, {
      [WORKER_ID_HEADER]: "worker-from-header",
      [WORKER_TOKEN_HEADER]: "token-1",
    });

    expect(guard.canActivate(context)).toBe(true);
    expect(host.validateWorkerToken).toHaveBeenCalledWith(
      "worker-from-header",
      "token-1"
    );
  });

  it("does not leak the raw token value into the rejection message", () => {
    const host = makeHost(false);
    const guard = makeGuard(host);

    const context = makeContext(
      { workerId: "worker-1" },
      { [WORKER_TOKEN_HEADER]: "super-secret-value" }
    );

    try {
      guard.canActivate(context);
      throw new Error("expected canActivate to throw");
    } catch (err) {
      const message = (err as HttpException).message;
      expect(message).not.toContain("super-secret-value");
    }
  });
});
