import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFile } from "node:child_process";
import { DockerRuntimeProvider } from "./docker-runtime.provider";
import type {
  RuntimeConfig,
  RuntimeLaunchContext,
  RuntimeInstanceRef,
} from "../types";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

const mockExecFile = vi.mocked(execFile);

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

const makeProvider = () => new DockerRuntimeProvider(CONFIG);

function makeCtx(
  overrides: Partial<RuntimeLaunchContext> = {}
): RuntimeLaunchContext {
  return {
    runtimeType: "docker",
    ownerId: "ws-1",
    workspaceId: "ws-1",
    runId: "run-1",
    placement: {
      runtimeType: "docker",
      userId: "u1",
      workspaceId: "ws-1",
      hostPath: "/tmp/workspace",
      runtimePath: "/workspace",
      runtimeLogDir: RUNTIME_LOG_MOUNT,
      sandbox: {
        isolationScope: "workspace",
        mountTarget: "/workspace",
      },
    } as never,
    workerEnv: {},
    ...overrides,
  };
}

function makeRef(runtimeInstanceId = "container-abc"): RuntimeInstanceRef {
  return {
    runtimeType: "docker",
    ownerId: "ws-1",
    runtimeInstanceId,
    isolationScope: "workspace",
  };
}

function dockerNameConflictError(containerId: string) {
  const message = `docker: Error response from daemon: Conflict. The container name "/agework-worker-ws-1" is already in use by container "${containerId}".`;
  const err = new Error(message) as Error & { stderr: string };
  err.stderr = message;
  return err;
}

const runArgsOf = () => {
  const runCall = mockExecFile.mock.calls.find(
    (c) => (c[1] as string[])[0] === "run"
  );
  return runCall![1] as string[];
};

describe("DockerRuntimeProvider", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  describe("start", () => {
    it("runs a named container and returns its id", async () => {
      mockExecFile.mockImplementation(((...args: any[]) => {
        args[args.length - 1](null, { stdout: "container-abc\n", stderr: "" });
      }) as any);

      const result = await makeProvider().start(makeCtx());

      expect(result).toEqual({ runtimeInstanceId: "container-abc" });
      const runArgs = runArgsOf();
      expect(runArgs).not.toContain("--rm");
      const nameIdx = runArgs.indexOf("--name");
      expect(runArgs[nameIdx + 1]).toBe("agework-worker-ws-1");
      expect(runArgs).toContain("com.docker.compose.project=agework");
      expect(runArgs).toContain("host.docker.internal:host-gateway");
      expect(runArgs).toContain("agework/runtime:latest");
    });

    it("adds --label args from the fixed ownership metadata", async () => {
      mockExecFile.mockImplementation(((...args: any[]) => {
        args[args.length - 1](null, { stdout: "container-abc\n", stderr: "" });
      }) as any);

      await makeProvider().start(makeCtx());

      const runArgs = runArgsOf();
      expect(runArgs).toContain("agework.io/runtime-owner-id=ws-1");
      expect(runArgs).toContain("agework.io/isolation-scope=workspace");
    });

    it("passes workerEnv through as -e args", async () => {
      mockExecFile.mockImplementation(((...args: any[]) => {
        args[args.length - 1](null, { stdout: "container-abc\n", stderr: "" });
      }) as any);

      await makeProvider().start(
        makeCtx({ workerEnv: { AGEWORK_WORKER_OWNER_ID: "ws-1" } })
      );

      const runArgs = runArgsOf();
      expect(runArgs).toContain("AGEWORK_WORKER_OWNER_ID=ws-1");
      expect(runArgs).toContain(
        "AGEWORK_WORKER_API_BASE=http://host.docker.internal:3000/api/v1"
      );
    });

    it("leaves a non-loopback serverBaseUrl (remote override) unchanged", async () => {
      mockExecFile.mockImplementation(((...args: any[]) => {
        args[args.length - 1](null, { stdout: "container-abc\n", stderr: "" });
      }) as any);

      const provider = new DockerRuntimeProvider({
        ...CONFIG,
        serverBaseUrl: "https://api.example.com/api/v1",
      });
      await provider.start(makeCtx());

      const runArgs = runArgsOf();
      expect(runArgs).toContain(
        "AGEWORK_WORKER_API_BASE=https://api.example.com/api/v1"
      );
    });

    it("mounts the workspace and runtime-log volumes", async () => {
      mockExecFile.mockImplementation(((...args: any[]) => {
        args[args.length - 1](null, { stdout: "container-abc\n", stderr: "" });
      }) as any);

      await makeProvider().start(makeCtx());

      const runArgs = runArgsOf();
      expect(runArgs).toContain("/tmp/workspace:/workspace");
      expect(runArgs).toContain(`${RUNTIME_LOG_HOST}:${RUNTIME_LOG_MOUNT}`);
    });

    it("does not mount a workspace volume when hostPath is empty", async () => {
      mockExecFile.mockImplementation(((...args: any[]) => {
        args[args.length - 1](null, { stdout: "container-abc\n", stderr: "" });
      }) as any);

      const ctx = makeCtx();
      (ctx.placement as { hostPath: string }).hostPath = "";
      await makeProvider().start(ctx);

      const runArgs = runArgsOf();
      expect(runArgs).not.toContain("/tmp/workspace:/workspace");
    });

    it("throws on empty container ID", async () => {
      mockExecFile.mockImplementation(((...args: any[]) => {
        args[args.length - 1](null, { stdout: "\n", stderr: "" });
      }) as any);

      await expect(makeProvider().start(makeCtx())).rejects.toThrow(
        "docker run returned empty container ID"
      );
    });

    it("throws on a non-absolute mount path", async () => {
      const ctx = makeCtx();
      (ctx.placement as { hostPath: string }).hostPath = "relative/path";
      await expect(makeProvider().start(ctx)).rejects.toThrow("absolute");
    });

    it("removes an unbound conflicting container and retries (no binding: expectedRuntimeInstanceId=null)", async () => {
      const conflictingContainerId =
        "bef10e13ac2f21c751927a40ea3a1ce296898dbf42f93f4bb2eff494c4c36719";
      let runAttempts = 0;
      mockExecFile.mockImplementation(((...args: any[]) => {
        const cmdArgs = args[1] as string[];
        const callback = args[args.length - 1];
        if (cmdArgs[0] === "run") {
          runAttempts += 1;
          if (runAttempts === 1) {
            callback(dockerNameConflictError(conflictingContainerId));
            return;
          }
          callback(null, { stdout: "container-next\n", stderr: "" });
          return;
        }
        if (cmdArgs[0] === "inspect") {
          callback(null, { stdout: `${conflictingContainerId}\n`, stderr: "" });
          return;
        }
        if (cmdArgs[0] === "rm") {
          callback(null, { stdout: "", stderr: "" });
          return;
        }
        callback(new Error(`unexpected docker command: ${cmdArgs.join(" ")}`));
      }) as any);

      const result = await makeProvider().start(
        makeCtx({ expectedRuntimeInstanceId: null })
      );

      expect(result).toEqual({ runtimeInstanceId: "container-next" });
      expect(mockExecFile).toHaveBeenCalledWith(
        "docker",
        ["rm", "-f", conflictingContainerId],
        expect.any(Function)
      );
    });

    it("removes a conflicting container bound to a different instance and retries", async () => {
      const conflictingContainerId =
        "bef10e13ac2f21c751927a40ea3a1ce296898dbf42f93f4bb2eff494c4c36719";
      let runAttempts = 0;
      mockExecFile.mockImplementation(((...args: any[]) => {
        const cmdArgs = args[1] as string[];
        const callback = args[args.length - 1];
        if (cmdArgs[0] === "run") {
          runAttempts += 1;
          if (runAttempts === 1) {
            callback(dockerNameConflictError(conflictingContainerId));
            return;
          }
          callback(null, { stdout: "container-next\n", stderr: "" });
          return;
        }
        if (cmdArgs[0] === "inspect") {
          callback(null, { stdout: `${conflictingContainerId}\n`, stderr: "" });
          return;
        }
        if (cmdArgs[0] === "rm") {
          callback(null, { stdout: "", stderr: "" });
          return;
        }
        callback(new Error(`unexpected docker command: ${cmdArgs.join(" ")}`));
      }) as any);

      const result = await makeProvider().start(
        makeCtx({ expectedRuntimeInstanceId: "some-other-container-id" })
      );

      expect(result).toEqual({ runtimeInstanceId: "container-next" });
      expect(mockExecFile).toHaveBeenCalledWith(
        "docker",
        ["rm", "-f", conflictingContainerId],
        expect.any(Function)
      );
    });

    it("does not remove a conflicting container that matches the expected binding", async () => {
      const conflictingContainerId =
        "bef10e13ac2f21c751927a40ea3a1ce296898dbf42f93f4bb2eff494c4c36719";
      mockExecFile.mockImplementation(((...args: any[]) => {
        const cmdArgs = args[1] as string[];
        const callback = args[args.length - 1];
        if (cmdArgs[0] === "run") {
          callback(dockerNameConflictError(conflictingContainerId));
          return;
        }
        if (cmdArgs[0] === "inspect") {
          callback(null, { stdout: `${conflictingContainerId}\n`, stderr: "" });
          return;
        }
        callback(new Error(`unexpected docker command: ${cmdArgs.join(" ")}`));
      }) as any);

      await expect(
        makeProvider().start(
          makeCtx({ expectedRuntimeInstanceId: conflictingContainerId })
        )
      ).rejects.toThrow("Conflict");

      expect(mockExecFile).not.toHaveBeenCalledWith(
        "docker",
        expect.arrayContaining(["rm", "-f", conflictingContainerId]),
        expect.any(Function)
      );
    });

    it("does not attempt recovery when expectedRuntimeInstanceId is undefined (caller opted out)", async () => {
      const conflictingContainerId =
        "bef10e13ac2f21c751927a40ea3a1ce296898dbf42f93f4bb2eff494c4c36719";
      mockExecFile.mockImplementation(((...args: any[]) => {
        const cmdArgs = args[1] as string[];
        const callback = args[args.length - 1];
        if (cmdArgs[0] === "run") {
          callback(dockerNameConflictError(conflictingContainerId));
          return;
        }
        callback(new Error(`unexpected docker command: ${cmdArgs.join(" ")}`));
      }) as any);

      await expect(makeProvider().start(makeCtx())).rejects.toThrow(
        "Conflict"
      );

      expect(mockExecFile).not.toHaveBeenCalledWith(
        "docker",
        expect.arrayContaining(["inspect"]),
        expect.any(Function)
      );
    });
  });

  describe("stop", () => {
    it("stops the container without removing it", async () => {
      mockExecFile.mockImplementation(((...args: any[]) => {
        args[args.length - 1](null, { stdout: "", stderr: "" });
      }) as any);

      await makeProvider().stop(makeRef());

      expect(mockExecFile).toHaveBeenCalledWith(
        "docker",
        expect.arrayContaining(["stop", "container-abc"]),
        expect.any(Function)
      );
      expect(mockExecFile).not.toHaveBeenCalledWith(
        "docker",
        expect.arrayContaining(["rm", "container-abc"]),
        expect.any(Function)
      );
    });

    it("falls back to docker kill when stop fails", async () => {
      mockExecFile.mockImplementation(((...args: any[]) => {
        const cmdArgs = args[1] as string[];
        const callback = args[args.length - 1];
        if (cmdArgs[0] === "stop") {
          callback(new Error("stop failed"));
        } else {
          callback(null, { stdout: "", stderr: "" });
        }
      }) as any);

      await makeProvider().stop(makeRef());

      expect(mockExecFile).toHaveBeenCalledWith(
        "docker",
        ["kill", "container-abc"],
        expect.any(Function)
      );
    });
  });

  describe("destroy", () => {
    it("force-removes the container", async () => {
      mockExecFile.mockImplementation(((...args: any[]) => {
        args[args.length - 1](null, { stdout: "", stderr: "" });
      }) as any);

      await makeProvider().destroy(makeRef());

      expect(mockExecFile).toHaveBeenCalledWith(
        "docker",
        ["rm", "-f", "container-abc"],
        expect.any(Function)
      );
    });

    it("swallows errors when the container is already gone", async () => {
      mockExecFile.mockImplementation(((...args: any[]) => {
        args[args.length - 1](new Error("No such container"));
      }) as any);

      await expect(makeProvider().destroy(makeRef())).resolves.toBeUndefined();
    });
  });
});
