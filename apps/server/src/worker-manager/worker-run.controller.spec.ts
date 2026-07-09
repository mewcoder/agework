import { describe, it, expect, vi, afterEach } from "vitest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import type { RunConfig } from "@agework/shared/protocol";
import {
  WORKER_ID_HEADER,
  WORKER_TOKEN_HEADER,
} from "@agework/shared/protocol";
import { IS_PUBLIC_KEY } from "../auth/decorators/public.decorator";
import { WorkerRunController } from "./worker-run.controller";
import { WorkerManagerService } from "./worker-manager.service";
import { WorkerTokenGuard } from "./connection/worker-token.guard";
import { WorkerRegistryRepository } from "./registry/worker-registry.repository";

describe("WorkerRunController", () => {
  it("is marked @Public() so worker callbacks bypass the global JwtAuthGuard (auth is handled by WorkerAuthGuard)", () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, WorkerRunController)).toBe(true);
  });

  it("delegates getRunConfig to WorkerManagerService with runId", () => {
    const config = { runId: "run-1" } as unknown as RunConfig;
    const workerManager = {
      getRunConfig: vi.fn().mockReturnValue({ config }),
    };
    const controller = new WorkerRunController(
      workerManager as unknown as WorkerManagerService
    );

    expect(controller.getRunConfig({ runId: "run-1" })).toEqual({ config });
    expect(workerManager.getRunConfig).toHaveBeenCalledWith("run-1");
  });

  it("delegates postEvent to WorkerManagerService with runId and body", async () => {
    const workerManager = {
      postEvent: vi.fn().mockResolvedValue({ ok: true }),
    };
    const controller = new WorkerRunController(
      workerManager as unknown as WorkerManagerService
    );
    const body = { jsonrpc: "2.0", method: "run.status" };

    await expect(
      controller.postEvent({ runId: "run-1" }, body)
    ).resolves.toEqual({ ok: true });
    expect(workerManager.postEvent).toHaveBeenCalledWith("run-1", body);
  });
});

// 上面的用例直接手搓 controller 实例调用方法,完全绕过了 Nest 的 guard 执行管道
// (方法级 @UseGuards(WorkerTokenGuard) 不会跑)。下面起一个真正的 Nest app 通过
// HTTP 打 getRunConfig/postEvent,证明装饰器确实接线到了这两个方法上。这两个
// 端点 URL 里没有 workerId,鉴权全靠 WorkerTokenGuard 退回读
// x-agework-worker-id header —— 这条路径手搓 controller 调用测不到。
describe("WorkerRunController — guard wiring (real Nest pipeline)", () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function startApp(registry: {
    findActiveByWorkerId: ReturnType<typeof vi.fn>;
  }) {
    const workerManager = {
      getRunConfig: vi.fn().mockReturnValue({ config: { runId: "run-1" } }),
      postEvent: vi.fn().mockResolvedValue({ ok: true }),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [WorkerRunController],
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

  it("getRunConfig reaches the controller when the worker-id header token matches", async () => {
    const registry = {
      findActiveByWorkerId: vi.fn().mockResolvedValue({ startToken: "token-1" }),
    };
    const { baseUrl, workerManager } = await startApp(registry);

    const res = await fetch(`${baseUrl}/worker/runs/run-1`, {
      headers: {
        [WORKER_ID_HEADER]: "worker-1",
        [WORKER_TOKEN_HEADER]: "token-1",
      },
    });

    expect(res.status).toBe(200);
    expect(registry.findActiveByWorkerId).toHaveBeenCalledWith("worker-1");
    expect(workerManager.getRunConfig).toHaveBeenCalledWith("run-1");
  });

  it("getRunConfig returns 410 and never reaches the controller without the worker-id header", async () => {
    const registry = { findActiveByWorkerId: vi.fn() };
    const { baseUrl, workerManager } = await startApp(registry);

    const res = await fetch(`${baseUrl}/worker/runs/run-1`, {
      headers: { [WORKER_TOKEN_HEADER]: "token-1" },
    });

    expect(res.status).toBe(410);
    expect(workerManager.getRunConfig).not.toHaveBeenCalled();
  });

  it("postEvent returns 410 and never reaches the controller when the token mismatches", async () => {
    const registry = {
      findActiveByWorkerId: vi.fn().mockResolvedValue({ startToken: "token-1" }),
    };
    const { baseUrl, workerManager } = await startApp(registry);

    const res = await fetch(`${baseUrl}/worker/runs/run-1/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [WORKER_ID_HEADER]: "worker-1",
        [WORKER_TOKEN_HEADER]: "wrong-token",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "run.aguiEvent" }),
    });

    expect(res.status).toBe(410);
    expect(workerManager.postEvent).not.toHaveBeenCalled();
  });
});
