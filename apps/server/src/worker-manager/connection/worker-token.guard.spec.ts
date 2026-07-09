import { describe, it, expect, vi } from "vitest";
import { HttpException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import {
  WORKER_ID_HEADER,
  WORKER_TOKEN_HEADER,
} from "@agework/shared/protocol";
import { WorkerTokenGuard } from "./worker-token.guard";
import { WorkerRegistryRepository } from "../registry/worker-registry.repository";

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

describe("WorkerTokenGuard", () => {
  it("allows the request through when the token matches the worker's active row", async () => {
    const registry = {
      findActiveByWorkerId: vi.fn().mockResolvedValue({ startToken: "token-1" }),
    };
    const guard = new WorkerTokenGuard(
      registry as unknown as WorkerRegistryRepository
    );

    const context = makeContext(
      { workerId: "worker-1" },
      { [WORKER_TOKEN_HEADER]: "token-1" }
    );

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(registry.findActiveByWorkerId).toHaveBeenCalledWith("worker-1");
  });

  it("rejects with 410 when the token does not match the worker's active row", async () => {
    const registry = {
      findActiveByWorkerId: vi.fn().mockResolvedValue({ startToken: "token-1" }),
    };
    const guard = new WorkerTokenGuard(
      registry as unknown as WorkerRegistryRepository
    );

    const context = makeContext(
      { workerId: "worker-1" },
      { [WORKER_TOKEN_HEADER]: "wrong-token" }
    );

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: 410,
    });
  });

  it("rejects with 410 when there is no active row for the worker", async () => {
    const registry = {
      findActiveByWorkerId: vi.fn().mockResolvedValue(null),
    };
    const guard = new WorkerTokenGuard(
      registry as unknown as WorkerRegistryRepository
    );

    const context = makeContext(
      { workerId: "worker-1" },
      { [WORKER_TOKEN_HEADER]: "token-1" }
    );

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: 410,
    });
    expect(registry.findActiveByWorkerId).toHaveBeenCalledTimes(1);
  });

  it("rejects with 410 when the token header is missing", async () => {
    const registry = {
      findActiveByWorkerId: vi.fn(),
    };
    const guard = new WorkerTokenGuard(
      registry as unknown as WorkerRegistryRepository
    );

    const context = makeContext({ workerId: "worker-1" }, {});

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: 410,
    });
    expect(registry.findActiveByWorkerId).not.toHaveBeenCalled();
  });

  it("rejects with 410 when neither a route param nor a header provides workerId", async () => {
    const registry = {
      findActiveByWorkerId: vi.fn(),
    };
    const guard = new WorkerTokenGuard(
      registry as unknown as WorkerRegistryRepository
    );

    const context = makeContext(undefined, {
      [WORKER_TOKEN_HEADER]: "token-1",
    });

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: 410,
    });
    expect(registry.findActiveByWorkerId).not.toHaveBeenCalled();
  });

  it("prefers the route param workerId over the header when both are present", async () => {
    const registry = {
      findActiveByWorkerId: vi.fn().mockResolvedValue({ startToken: "token-1" }),
    };
    const guard = new WorkerTokenGuard(
      registry as unknown as WorkerRegistryRepository
    );

    const context = makeContext(
      { workerId: "worker-from-param" },
      {
        [WORKER_ID_HEADER]: "worker-from-header",
        [WORKER_TOKEN_HEADER]: "token-1",
      }
    );

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(registry.findActiveByWorkerId).toHaveBeenCalledWith(
      "worker-from-param"
    );
    expect(registry.findActiveByWorkerId).not.toHaveBeenCalledWith(
      "worker-from-header"
    );
  });

  it("falls back to the worker-id header when there is no route param (runs endpoints)", async () => {
    const registry = {
      findActiveByWorkerId: vi.fn().mockResolvedValue({ startToken: "token-1" }),
    };
    const guard = new WorkerTokenGuard(
      registry as unknown as WorkerRegistryRepository
    );

    const context = makeContext(undefined, {
      [WORKER_ID_HEADER]: "worker-from-header",
      [WORKER_TOKEN_HEADER]: "token-1",
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(registry.findActiveByWorkerId).toHaveBeenCalledWith(
      "worker-from-header"
    );
  });

  it("does not leak the raw token value into the rejection message", async () => {
    const registry = {
      findActiveByWorkerId: vi.fn().mockResolvedValue({ startToken: "token-1" }),
    };
    const guard = new WorkerTokenGuard(
      registry as unknown as WorkerRegistryRepository
    );

    const context = makeContext(
      { workerId: "worker-1" },
      { [WORKER_TOKEN_HEADER]: "super-secret-value" }
    );

    try {
      await guard.canActivate(context);
      throw new Error("expected canActivate to reject");
    } catch (err) {
      const message = (err as HttpException).message;
      expect(message).not.toContain("super-secret-value");
    }
  });
});
