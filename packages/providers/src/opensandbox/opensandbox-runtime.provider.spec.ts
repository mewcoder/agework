import { describe, it, expect, vi } from "vitest";
import { OpenSandboxRuntimeProvider } from "./opensandbox-runtime.provider";
import type {
  RuntimeConfig,
  RuntimeLaunchContext,
  RuntimeInstanceRef,
} from "../types";
import type {
  OpenSandboxClientLike,
  OpenSandboxSandboxLike,
} from "./opensandbox-client";

const RUNTIME_LOG_HOST = "/tmp/agework-logs/runtime";
const RUNTIME_LOG_MOUNT = "/home/agework/.agework/logs/runtime";

const CONFIG: RuntimeConfig = {
  workerImage: "agework/runtime:latest",
  runtimeLogHostPath: RUNTIME_LOG_HOST,
  serverBaseUrl: "http://127.0.0.1:3000/api/v1",
  local: {
    workerEntryPath: "/tmp/worker/index.js",
    tsxCliPath: "/tmp/tsx/cli.mjs",
  },
  openSandbox: {
    domain: "opensandbox.test",
    protocol: "https",
    apiKey: "test-key",
    useServerProxy: false,
  },
};

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

function makeClient(): OpenSandboxClientLike {
  let nextId = 0;
  return {
    createSandbox: vi
      .fn()
      .mockImplementation(async () => makeSandboxMock(`sandbox-${++nextId}`)),
    getSandbox: vi.fn().mockResolvedValue(null),
    pauseSandbox: vi.fn().mockResolvedValue(undefined),
    deleteSandbox: vi.fn().mockResolvedValue(undefined),
  };
}

function makeProvider(
  client: OpenSandboxClientLike
): OpenSandboxRuntimeProvider {
  return new OpenSandboxRuntimeProvider(CONFIG, client);
}

function makeCtx(
  overrides: Partial<RuntimeLaunchContext> = {}
): RuntimeLaunchContext {
  return {
    runtimeType: "opensandbox",
    ownerId: "ws-1",
    workspaceId: "ws-1",
    runId: "run-1",
    placement: {
      runtimeType: "opensandbox",
      userId: "u1",
      workspaceId: "ws-1",
      hostPath: "/tmp/workspace",
      runtimePath: "/workspace",
      runtimeLogDir: RUNTIME_LOG_MOUNT,
      sandbox: {
        scope: "workspace",
        mountTarget: "/workspace",
      },
    } as never,
    workerEnv: {},
    ...overrides,
  };
}

function makeRef(runtimeInstanceId = "sandbox-abc"): RuntimeInstanceRef {
  return {
    runtimeType: "opensandbox",
    ownerId: "ws-1",
    runtimeInstanceId,
    scope: "workspace",
  };
}

const createdSandbox = (client: OpenSandboxClientLike) =>
  (client.createSandbox as ReturnType<typeof vi.fn>).mock.results[0]
    .value as Promise<OpenSandboxSandboxLike>;

describe("OpenSandboxRuntimeProvider", () => {
  describe("start", () => {
    it("creates the sandbox then starts the worker, returning its id", async () => {
      const client = makeClient();

      const result = await makeProvider(client).start(makeCtx());

      expect(result.runtimeInstanceId).toMatch(/^sandbox-/);
      expect(client.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          image: "agework/runtime:latest",
          workspaceHostPath: "/tmp/workspace",
          workspaceMountPath: "/workspace",
          runtimeLogHostPath: RUNTIME_LOG_HOST,
          runtimeLogMountPath: RUNTIME_LOG_MOUNT,
        })
      );

      const sandbox = await createdSandbox(client);
      expect(sandbox.runCommand).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ background: true })
      );
    });

    it("passes workerEnv and ownership metadata into createSandbox", async () => {
      const client = makeClient();

      await makeProvider(client).start(
        makeCtx({ workerEnv: { AGEWORK_WORKER_OWNER_ID: "ws-1" } })
      );

      expect(client.createSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          env: expect.objectContaining({
            AGEWORK_WORKER_OWNER_ID: "ws-1",
          }),
          metadata: expect.objectContaining({
            "agework.io/runtime-owner-id": "ws-1",
          }),
        })
      );
    });

    it("starts the worker in the just-created sandbox with owner env", async () => {
      const client = makeClient();

      await makeProvider(client).start(
        makeCtx({ workerEnv: { AGEWORK_WORKER_OWNER_ID: "ws-1" } })
      );

      const sandbox = await createdSandbox(client);
      expect(sandbox.runCommand).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          envs: expect.objectContaining({ AGEWORK_WORKER_OWNER_ID: "ws-1" }),
        })
      );
    });
  });

  describe("stop", () => {
    it("pauses the sandbox via the client", async () => {
      const client = makeClient();
      await makeProvider(client).stop(makeRef());
      expect(client.pauseSandbox).toHaveBeenCalledWith("sandbox-abc");
      expect(client.deleteSandbox).not.toHaveBeenCalled();
    });
  });

  describe("destroy", () => {
    it("deletes the sandbox via the client", async () => {
      const client = makeClient();
      await makeProvider(client).destroy(makeRef());
      expect(client.deleteSandbox).toHaveBeenCalledWith("sandbox-abc");
      expect(client.pauseSandbox).not.toHaveBeenCalled();
    });
  });
});
