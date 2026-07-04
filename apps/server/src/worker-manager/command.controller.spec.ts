import { describe, it, expect, vi, afterEach } from "vitest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { WORKER_TOKEN_HEADER } from "@agework/shared/protocol";
import { IS_PUBLIC_KEY } from "../auth/decorators/public.decorator";
import { WorkerCommandController } from "./command.controller";
import { WorkerManagerService } from "./worker-manager.service";
import { WorkerTokenGuard } from "./connection/worker-token.guard";
import { WorkerRegistryRepository } from "./registry/worker-registry.repository";

describe("WorkerCommandController", () => {
  it("is marked @Public() so worker callbacks bypass the global JwtAuthGuard (auth is handled by WorkerAuthGuard)", () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, WorkerCommandController)).toBe(
      true
    );
  });

  it("delegates pollCommands to WorkerManagerService with ownerId and query", async () => {
    const workerManager = {
      pollCommands: vi.fn().mockResolvedValue({ messages: [] }),
    };
    const controller = new WorkerCommandController(
      workerManager as unknown as WorkerManagerService
    );

    await controller.pollCommands(
      { ownerId: "owner-1" },
      { afterSeq: 3, waitMs: 25000 }
    );

    expect(workerManager.pollCommands).toHaveBeenCalledWith("owner-1", {
      afterSeq: 3,
      waitMs: 25000,
    });
  });

  it("delegates registerWorker to WorkerManagerService with ownerId and body", async () => {
    const workerManager = {
      registerWorker: vi.fn().mockResolvedValue({ ok: true }),
    };
    const controller = new WorkerCommandController(
      workerManager as unknown as WorkerManagerService
    );

    const body = { startToken: "token-1", pid: 4242 };
    await controller.registerWorker({ ownerId: "owner-1" }, body);

    expect(workerManager.registerWorker).toHaveBeenCalledWith("owner-1", body);
  });
});

// 上面的用例直接手搓 controller 实例调用方法,完全绕过了 Nest 的 guard 执行管道
// (方法级 @UseGuards(WorkerTokenGuard) 不会跑)。下面起一个真正的 Nest app 通过
// HTTP 打 pollCommands,证明装饰器确实接线到了这个方法上,而不是打错方法名。
describe("WorkerCommandController — pollCommands guard wiring (real Nest pipeline)", () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function startApp(registry: {
    findActiveByOwnerId: ReturnType<typeof vi.fn>;
  }) {
    const workerManager = {
      pollCommands: vi.fn().mockResolvedValue({ messages: [] }),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [WorkerCommandController],
      providers: [
        WorkerTokenGuard,
        { provide: WorkerManagerService, useValue: workerManager },
        { provide: WorkerRegistryRepository, useValue: registry },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0);
    const address = app.getHttpServer().address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    return { baseUrl, workerManager };
  }

  it("lets the request through and reaches the controller when the token matches", async () => {
    const registry = {
      findActiveByOwnerId: vi.fn().mockResolvedValue({ startToken: "token-1" }),
    };
    const { baseUrl, workerManager } = await startApp(registry);

    const res = await fetch(`${baseUrl}/worker/owners/owner-1/commands`, {
      headers: { [WORKER_TOKEN_HEADER]: "token-1" },
    });

    expect(res.status).toBe(200);
    expect(workerManager.pollCommands).toHaveBeenCalledTimes(1);
    expect(workerManager.pollCommands.mock.calls[0][0]).toBe("owner-1");
  });

  it("returns 410 and never reaches the controller when the token is missing", async () => {
    const registry = { findActiveByOwnerId: vi.fn() };
    const { baseUrl, workerManager } = await startApp(registry);

    const res = await fetch(`${baseUrl}/worker/owners/owner-1/commands`);

    expect(res.status).toBe(410);
    expect(workerManager.pollCommands).not.toHaveBeenCalled();
  });

  it("returns 410 and never reaches the controller when the token does not match", async () => {
    const registry = {
      findActiveByOwnerId: vi.fn().mockResolvedValue({ startToken: "token-1" }),
    };
    const { baseUrl, workerManager } = await startApp(registry);

    const res = await fetch(`${baseUrl}/worker/owners/owner-1/commands`, {
      headers: { [WORKER_TOKEN_HEADER]: "wrong-token" },
    });

    expect(res.status).toBe(410);
    expect(workerManager.pollCommands).not.toHaveBeenCalled();
  });
});
