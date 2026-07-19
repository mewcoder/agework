import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFile } from "node:child_process";
import { DockerRuntimeProvider } from "./docker-runtime.provider";
import type {
  RuntimeProviderConfig,
  RuntimeLaunchContext,
  RuntimeInstanceRef,
} from "@agework/runtime-sdk";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

const mockExecFile = vi.mocked(execFile);

const RUNTIME_LOG_HOST = "/tmp/agework-logs/runtime";
const RUNTIME_LOG_MOUNT = "/home/agework/.agework/logs/runtime";

const CONFIG: RuntimeProviderConfig = {
  workerImage: "agework/runtime:latest",
  runtimeLogHostPath: RUNTIME_LOG_HOST,
  workerApiBaseUrl: "http://127.0.0.1:7101/api/v1",
};

const makeProvider = () => new DockerRuntimeProvider(CONFIG);

function makeCtx(
  overrides: Partial<RuntimeLaunchContext> = {}
): RuntimeLaunchContext {
  return {
    runtimeType: "docker",
    workerId: "worker-1",
    runId: "run-1",
    workspaceId: "ws-1",
    isolation: { scope: "workspace", subjectId: "ws-1" },
    placement: {
      runtimeType: "docker",
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

function makeRef(runtimeInstanceId = "container-abc"): RuntimeInstanceRef {
  return {
    runtimeType: "docker",
    workerId: "worker-1",
    runtimeInstanceId,
  };
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
    it("runs an unnamed container and returns its id", async () => {
      mockExecFile.mockImplementation(((...args: any[]) => {
        args[args.length - 1](null, { stdout: "container-abc\n", stderr: "" });
      }) as any);

      const result = await makeProvider().start(makeCtx());

      expect(result).toEqual({ runtimeInstanceId: "container-abc" });
      const runArgs = runArgsOf();
      expect(runArgs).not.toContain("--rm");
      // 不再使用 ownerId 稳定命名,容器名由 Docker 自动生成
      expect(runArgs).not.toContain("--name");
      expect(runArgs).toContain("com.docker.compose.project=agework");
      expect(runArgs).toContain("host.docker.internal:host-gateway");
      expect(runArgs).toContain("agework/runtime:latest");
    });

    it("adds structured isolation labels from metadata", async () => {
      mockExecFile.mockImplementation(((...args: any[]) => {
        args[args.length - 1](null, { stdout: "container-abc\n", stderr: "" });
      }) as any);

      await makeProvider().start(makeCtx());

      const runArgs = runArgsOf();
      expect(runArgs).toContain("agework.io/runtime-type=docker");
      expect(runArgs).toContain("agework.io/scope=workspace");
      expect(runArgs).toContain("agework.io/subject-id=ws-1");
      expect(runArgs).toContain("agework.io/workspace-id=ws-1");
      expect(runArgs).toContain("agework.io/worker-id=worker-1");
    });

    it("passes workerEnv through as -e args", async () => {
      mockExecFile.mockImplementation(((...args: any[]) => {
        args[args.length - 1](null, { stdout: "container-abc\n", stderr: "" });
      }) as any);

      await makeProvider().start(
        makeCtx({ workerEnv: { AGEWORK_WORKER_ROLE: "worker" } })
      );

      const runArgs = runArgsOf();
      expect(runArgs).toContain("AGEWORK_WORKER_ROLE=worker");
      expect(runArgs).toContain(
        "AGEWORK_WORKER_API_BASE=http://host.docker.internal:7101/api/v1"
      );
    });

    it("leaves a non-loopback workerApiBaseUrl unchanged", async () => {
      mockExecFile.mockImplementation(((...args: any[]) => {
        args[args.length - 1](null, { stdout: "container-abc\n", stderr: "" });
      }) as any);

      const provider = new DockerRuntimeProvider({
        ...CONFIG,
        workerApiBaseUrl: "https://host.example.com/api/v1",
      });
      await provider.start(makeCtx());

      const runArgs = runArgsOf();
      expect(runArgs).toContain(
        "AGEWORK_WORKER_API_BASE=https://host.example.com/api/v1"
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
