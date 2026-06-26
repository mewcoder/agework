import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenSandboxEngine } from "./opensandbox-engine";
import type { SandboxStartInput, SandboxPlacement } from ".";
import type {
  OpenSandboxClientLike,
  OpenSandboxSandboxLike,
} from "../opensandbox-client";

function makeSandboxMock(id: string): OpenSandboxSandboxLike {
  const sandbox = {
    id,
    runCommand: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    renew: vi.fn().mockResolvedValue(undefined),
    isHealthy: vi.fn().mockResolvedValue(true),
    getEndpointUrl: vi.fn().mockResolvedValue("http://localhost:44772"),
  };
  (sandbox.resume as ReturnType<typeof vi.fn>).mockResolvedValue(sandbox);
  return sandbox;
}

function makePlacement(
  overrides?: Partial<SandboxPlacement>
): SandboxPlacement {
  return {
    isolationScope: "workspace",
    scopeKey: "ws-1",
    workspaceId: "ws-1",
    workspaceHostPath: "/tmp/workspace",
    workspaceMountPath: "/workspace",
    ...overrides,
  };
}

function makeInput(overrides?: Partial<SandboxStartInput>): SandboxStartInput {
  return {
    placement: makePlacement(),
    image: "agework/worker:latest",
    apiBaseUrl: "http://localhost:3000/api/v1",
    accessKey: "test-key",
    env: {},
    metadata: {},
    ...overrides,
  };
}

function makeClient(): OpenSandboxClientLike {
  let nextId = 0;
  return {
    createSandbox: vi.fn().mockImplementation(async () => {
      return makeSandboxMock(`sandbox-${++nextId}`);
    }),
    getSandbox: vi.fn().mockResolvedValue(null),
    pauseSandbox: vi.fn().mockResolvedValue(undefined),
    resumeSandbox: vi
      .fn()
      .mockImplementation(async (id: string) => makeSandboxMock(id)),
    deleteSandbox: vi.fn().mockResolvedValue(undefined),
  };
}

describe("OpenSandboxEngine", () => {
  it("getOrCreate creates a sandbox without starting worker, returns SandboxRuntime", async () => {
    const client = makeClient();
    const engine = new OpenSandboxEngine(client);

    const result = await engine.getOrCreate(makeInput());

    expect(result.engineType).toBe("opensandbox");
    expect(result.runtimeInstanceId).toMatch(/^sandbox-/);
    expect(client.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        image: "agework/worker:latest",
        workspaceMountPath: "/workspace",
      })
    );

    const createdSandbox = await (
      client.createSandbox as ReturnType<typeof vi.fn>
    ).mock.results[0].value;
    expect(createdSandbox.runCommand).not.toHaveBeenCalled();

    await engine.startWorker(result, makeInput());

    expect(createdSandbox.runCommand).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        background: true,
      })
    );
  });

  it("getOrCreate passes env and metadata to createSandbox", async () => {
    const client = makeClient();
    const engine = new OpenSandboxEngine(client);

    await engine.getOrCreate(
      makeInput({
        env: {
          AGEWORK_WORKER_CHANNEL: "http",
          AGEWORK_WORKER_WORKSPACE_ID: "ws-1",
        },
        metadata: {
          "agework.io/workspace-id": "ws-1",
        },
      })
    );

    expect(client.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          AGEWORK_WORKER_CHANNEL: "http",
          AGEWORK_WORKER_WORKSPACE_ID: "ws-1",
        }),
        metadata: expect.objectContaining({
          "agework.io/workspace-id": "ws-1",
        }),
      })
    );
  });

  it("getOrCreate includes workspace volume when hostPath is set", async () => {
    const client = makeClient();
    const engine = new OpenSandboxEngine(client);

    await engine.getOrCreate(
      makeInput({
        placement: makePlacement({
          workspaceHostPath: "/tmp/workspace",
          workspaceMountPath: "/workspace",
        }),
      })
    );

    expect(client.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceHostPath: "/tmp/workspace",
        workspaceMountPath: "/workspace",
      })
    );
  });

  it("getOrCreate includes runtime log volume when provided", async () => {
    const client = makeClient();
    const engine = new OpenSandboxEngine(client);

    await engine.getOrCreate(
      makeInput({
        runtimeLogHostPath: "/tmp/agework-logs/runtime",
        runtimeLogMountPath: "/home/agework/.agework/logs/runtime",
      })
    );

    expect(client.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeLogHostPath: "/tmp/agework-logs/runtime",
        runtimeLogMountPath: "/home/agework/.agework/logs/runtime",
      })
    );
  });

  it("startWorker starts worker with correct env vars", async () => {
    const client = makeClient();
    const engine = new OpenSandboxEngine(client);

    const input = makeInput({
      env: {
        AGEWORK_WORKER_RUNTIME_SCOPE_KEY: "ws-1",
      },
    });
    const runtime = await engine.getOrCreate(input);
    await engine.startWorker(runtime, input);

    const createdSandbox = await (
      client.createSandbox as ReturnType<typeof vi.fn>
    ).mock.results[0].value;
    expect(createdSandbox.runCommand).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        envs: expect.objectContaining({
          AGEWORK_WORKER_RUNTIME_SCOPE_KEY: "ws-1",
        }),
      })
    );
  });

  it("startWorker passes sandbox id as runtime resource id", async () => {
    const client = makeClient();
    const engine = new OpenSandboxEngine(client);

    const input = makeInput();
    const runtime = await engine.getOrCreate(input);
    await engine.startWorker(runtime, input);

    const createdSandbox = await (
      client.createSandbox as ReturnType<typeof vi.fn>
    ).mock.results[0].value;
    expect(createdSandbox.runCommand).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        envs: expect.objectContaining({
          AGEWORK_WORKER_RUNTIME_INSTANCE_ID: "sandbox-1",
        }),
      })
    );
  });

  it("startWorker starts the cached sandbox", async () => {
    const client = makeClient();
    const engine = new OpenSandboxEngine(client);

    const input = makeInput();
    const runtime = await engine.getOrCreate(input);
    const runCommandCallsBefore = await (
      client.createSandbox as ReturnType<typeof vi.fn>
    ).mock.results[0].value.then(
      (s: OpenSandboxSandboxLike) =>
        (s.runCommand as ReturnType<typeof vi.fn>).mock.calls.length
    );

    await engine.startWorker(runtime, input);

    const runCommandCallsAfter = await (
      client.createSandbox as ReturnType<typeof vi.fn>
    ).mock.results[0].value.then(
      (s: OpenSandboxSandboxLike) =>
        (s.runCommand as ReturnType<typeof vi.fn>).mock.calls.length
    );
    expect(runCommandCallsBefore).toBe(0);
    expect(runCommandCallsAfter).toBe(1);
  });

  it("stop pauses the sandbox via client", async () => {
    const client = makeClient();
    const engine = new OpenSandboxEngine(client);

    await engine.stop("sandbox-abc");

    expect(client.pauseSandbox).toHaveBeenCalledWith("sandbox-abc");
  });

  it("resume resumes the sandbox and returns the runtime", async () => {
    const client = makeClient();
    const engine = new OpenSandboxEngine(client);

    const runtime = await engine.resume("sandbox-abc", makeInput());

    expect(client.resumeSandbox).toHaveBeenCalledWith("sandbox-abc");
    expect(runtime).toEqual({
      engineType: "opensandbox",
      runtimeInstanceId: "sandbox-abc",
      workspaceMountPath: "/workspace",
    });
  });

  it("recoverOrphan deletes the sandbox by id", async () => {
    const client = makeClient();
    const engine = new OpenSandboxEngine(client);

    await engine.recoverOrphan("sandbox-orphan");

    expect(client.deleteSandbox).toHaveBeenCalledWith("sandbox-orphan");
  });

  it("recoverOrphan is a no-op if sandbox does not exist", async () => {
    const client = makeClient();
    (client.getSandbox as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const engine = new OpenSandboxEngine(client);

    // 不应抛错
    await engine.recoverOrphan("sandbox-nonexistent");
  });

  it("isHealthy returns true when sandbox is healthy", async () => {
    const client = makeClient();
    const sandbox = makeSandboxMock("sandbox-1");
    (client.getSandbox as ReturnType<typeof vi.fn>).mockResolvedValue(sandbox);
    const engine = new OpenSandboxEngine(client);

    const healthy = await engine.isHealthy("sandbox-1");
    expect(healthy).toBe(true);
  });

  it("isHealthy returns false when sandbox not found", async () => {
    const client = makeClient();
    (client.getSandbox as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const engine = new OpenSandboxEngine(client);

    const healthy = await engine.isHealthy("sandbox-gone");
    expect(healthy).toBe(false);
  });
});
