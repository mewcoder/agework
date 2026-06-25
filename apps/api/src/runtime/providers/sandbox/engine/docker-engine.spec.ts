import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFile } from "node:child_process";
import { DockerSandboxEngine } from "./docker-engine";
import type { SandboxStartInput, SandboxPlacement } from ".";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

const mockExecFile = vi.mocked(execFile);

function makePlacement(overrides?: Partial<SandboxPlacement>): SandboxPlacement {
  return {
    isolationScope: "workspace",
    resourceKey: "ws-1",
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
    apiBaseUrl: "http://host.docker.internal:3000/api/v1",
    accessKey: "test-key",
    env: {},
    metadata: {},
    ...overrides,
  };
}

function dockerNameConflictError(containerId: string) {
  const message = `docker: Error response from daemon: Conflict. The container name "/agework-worker-ws-1" is already in use by container "${containerId}".`;
  const err = new Error(message) as Error & { stderr: string };
  err.stderr = message;
  return err;
}

describe("DockerSandboxEngine", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it("getOrCreate starts a container and returns SandboxRuntime", async () => {
    const engine = new DockerSandboxEngine();
    mockExecFile.mockImplementation(((...args: any[]) => {
      args[args.length - 1](null, { stdout: "container-abc\n", stderr: "" });
    }) as any);

    const result = await engine.getOrCreate(makeInput());

    expect(result.engineType).toBe("docker");
    expect(result.runtimeResourceId).toBe("container-abc");
    expect(result.workspaceMountPath).toBe("/workspace");

    const runCall = mockExecFile.mock.calls.find(
      (c) => (c[1] as string[])[0] === "run"
    );
    const runArgs = runCall![1] as string[];
    expect(runArgs).not.toContain("--rm");
    expect(runArgs).toContain("--name");
    const nameIdx = runArgs.indexOf("--name");
    expect(runArgs[nameIdx + 1]).toBe("agework-worker-ws-1");
    expect(runArgs).toContain("com.docker.compose.project=agework");
    expect(runArgs).toContain("--add-host");
    expect(runArgs).toContain("host.docker.internal:host-gateway");
  });

  it("getOrCreate adds --label args from metadata", async () => {
    const engine = new DockerSandboxEngine();
    mockExecFile.mockImplementation(((...args: any[]) => {
      args[args.length - 1](null, { stdout: "container-abc\n", stderr: "" });
    }) as any);

    await engine.getOrCreate(makeInput({
      metadata: {
        "agework.io/runtime-resource-key": "ws-1",
        "agework.io/isolation-scope": "workspace",
      },
    }));

    const runCall = mockExecFile.mock.calls.find(
      (c) => (c[1] as string[])[0] === "run"
    );
    const runArgs = runCall![1] as string[];
    expect(runArgs).toContain("--label");
    expect(runArgs).toContain("agework.io/runtime-resource-key=ws-1");
    expect(runArgs).toContain("agework.io/isolation-scope=workspace");
  });

  it("getOrCreate includes env vars from input", async () => {
    const engine = new DockerSandboxEngine();
    mockExecFile.mockImplementation(((...args: any[]) => {
      args[args.length - 1](null, { stdout: "container-abc\n", stderr: "" });
    }) as any);

    await engine.getOrCreate(makeInput({
      env: {
        AGEWORK_INTERNAL_TRANSPORT: "http",
        AGEWORK_INTERNAL_RUNTIME_ACCESS_KEY: "test-key",
        AGEWORK_INTERNAL_WORKSPACE_ID: "ws-1",
      },
    }));

    const runCall = mockExecFile.mock.calls.find(
      (c) => (c[1] as string[])[0] === "run"
    );
    const runArgs = runCall![1] as string[];
    expect(runArgs).toContain("AGEWORK_INTERNAL_TRANSPORT=http");
    expect(runArgs).toContain("AGEWORK_INTERNAL_WORKSPACE_ID=ws-1");
  });

  it("getOrCreate mounts runtime log directory when provided", async () => {
    const engine = new DockerSandboxEngine();
    mockExecFile.mockImplementation(((...args: any[]) => {
      args[args.length - 1](null, { stdout: "container-abc\n", stderr: "" });
    }) as any);

    await engine.getOrCreate(makeInput({
      runtimeLogHostPath: "/tmp/agework-logs/runtime",
      runtimeLogMountPath: "/home/agework/.agework/logs/runtime",
    }));

    const runCall = mockExecFile.mock.calls.find(
      (c) => (c[1] as string[])[0] === "run"
    );
    const runArgs = runCall![1] as string[];
    expect(runArgs).toContain(
      "/tmp/agework-logs/runtime:/home/agework/.agework/logs/runtime"
    );
  });

  it("getOrCreate throws on empty container ID", async () => {
    const engine = new DockerSandboxEngine();
    mockExecFile.mockImplementation(((...args: any[]) => {
      args[args.length - 1](null, { stdout: "\n", stderr: "" });
    }) as any);

    await expect(engine.getOrCreate(makeInput())).rejects.toThrow(
      "docker run returned empty container ID"
    );
  });

  it("removes an unbound conflicting container and retries", async () => {
    const engine = new DockerSandboxEngine();
    const conflictingContainerId =
      "bef10e13ac2f21c751927a40ea3a1ce296898dbf42f93f4bb2eff494c4c36719";
    const isExpectedRuntimeResource = vi.fn().mockResolvedValue(false);
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

    const result = await engine.getOrCreate(
      makeInput({ isExpectedRuntimeResource })
    );

    expect(result.runtimeResourceId).toBe("container-next");
    expect(isExpectedRuntimeResource).toHaveBeenCalledWith(
      conflictingContainerId
    );
    expect(mockExecFile).toHaveBeenCalledWith(
      "docker",
      ["rm", "-f", conflictingContainerId],
      expect.any(Function)
    );
  });

  it("does not remove a conflicting container bound to the current workspace", async () => {
    const engine = new DockerSandboxEngine();
    const conflictingContainerId =
      "bef10e13ac2f21c751927a40ea3a1ce296898dbf42f93f4bb2eff494c4c36719";
    const isExpectedRuntimeResource = vi.fn().mockResolvedValue(true);
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
      engine.getOrCreate(makeInput({ isExpectedRuntimeResource }))
    ).rejects.toThrow("Conflict");

    expect(mockExecFile).not.toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["rm", "-f", conflictingContainerId]),
      expect.any(Function)
    );
  });

  it("stop calls docker stop and does not remove the container", async () => {
    const engine = new DockerSandboxEngine();
    mockExecFile.mockImplementation(((...args: any[]) => {
      args[args.length - 1](null, { stdout: "", stderr: "" });
    }) as any);

    await engine.stop("container-abc");

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

  it("stop falls back to docker kill when stop fails", async () => {
    const engine = new DockerSandboxEngine();
    mockExecFile.mockImplementation(((...args: any[]) => {
      const cmdArgs = args[1] as string[];
      const callback = args[args.length - 1];
      if (cmdArgs[0] === "stop") {
        callback(new Error("stop failed"));
      } else {
        callback(null, { stdout: "", stderr: "" });
      }
    }) as any);

    await engine.stop("container-abc");

    expect(mockExecFile).toHaveBeenCalledWith(
      "docker",
      ["kill", "container-abc"],
      expect.any(Function)
    );
  });

  it("recoverOrphan stops the container by id", async () => {
    const engine = new DockerSandboxEngine();
    mockExecFile.mockImplementation(((...args: any[]) => {
      args[args.length - 1](null, { stdout: "", stderr: "" });
    }) as any);

    await engine.recoverOrphan("container-abc");

    expect(mockExecFile).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["stop", "container-abc"]),
      expect.any(Function)
    );
  });

  it("recoverOrphan force kills when stop fails", async () => {
    const engine = new DockerSandboxEngine();
    mockExecFile.mockImplementation(((...args: any[]) => {
      const cmdArgs = args[1] as string[];
      const callback = args[args.length - 1];
      if (cmdArgs[0] === "stop") {
        callback(new Error("stop failed"));
      } else {
        callback(null, { stdout: "", stderr: "" });
      }
    }) as any);

    await engine.recoverOrphan("container-abc");

    expect(mockExecFile).toHaveBeenCalledWith(
      "docker",
      ["kill", "container-abc"],
      expect.any(Function)
    );
  });

  it("resume calls docker start and returns the runtime", async () => {
    const engine = new DockerSandboxEngine();
    mockExecFile.mockImplementation(((...args: any[]) => {
      args[args.length - 1](null, { stdout: "", stderr: "" });
    }) as any);

    const result = await engine.resume!("container-abc", makeInput());

    expect(mockExecFile).toHaveBeenCalledWith(
      "docker",
      ["start", "container-abc"],
      expect.any(Function)
    );
    expect(result).toEqual({
      engineType: "docker",
      runtimeResourceId: "container-abc",
      workspaceMountPath: "/workspace",
    });
  });

  it("startWorker is a no-op for Docker", async () => {
    const engine = new DockerSandboxEngine();
    await engine.startWorker(
      { engineType: "docker", runtimeResourceId: "container-abc", workspaceMountPath: "/workspace" },
      makeInput()
    );
  });

  it("getOrCreate throws on non-absolute mount path", async () => {
    const engine = new DockerSandboxEngine();
    const input = makeInput({
      placement: makePlacement({ workspaceHostPath: "relative/path" }),
    });

    await expect(engine.getOrCreate(input)).rejects.toThrow("absolute");
  });

  it("getOrCreate mounts workspace volume when hostPath is provided", async () => {
    const engine = new DockerSandboxEngine();
    mockExecFile.mockImplementation(((...args: any[]) => {
      args[args.length - 1](null, { stdout: "container-abc\n", stderr: "" });
    }) as any);

    await engine.getOrCreate(makeInput({
      placement: makePlacement({
        workspaceHostPath: "/tmp/workspace",
        workspaceMountPath: "/workspace",
      }),
    }));

    const runCall = mockExecFile.mock.calls.find(
      (c) => (c[1] as string[])[0] === "run"
    );
    const runArgs = runCall![1] as string[];
    expect(runArgs).toContain("-v");
    const vIdx = runArgs.indexOf("-v");
    expect(runArgs[vIdx + 1]).toBe("/tmp/workspace:/workspace");
  });

  it("getOrCreate does not mount volume when hostPath is empty", async () => {
    const engine = new DockerSandboxEngine();
    mockExecFile.mockImplementation(((...args: any[]) => {
      args[args.length - 1](null, { stdout: "container-abc\n", stderr: "" });
    }) as any);

    await engine.getOrCreate(makeInput({
      placement: makePlacement({ workspaceHostPath: "" }),
    }));

    const runCall = mockExecFile.mock.calls.find(
      (c) => (c[1] as string[])[0] === "run"
    );
    const runArgs = runCall![1] as string[];
    expect(runArgs).not.toContain("-v");
  });
});
