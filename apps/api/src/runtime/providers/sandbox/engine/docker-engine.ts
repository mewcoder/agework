import { Injectable, Logger } from "@nestjs/common";
import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import type { SandboxEngine, SandboxEngineType, SandboxStartInput, SandboxRuntime } from ".";
import { swallow } from "../../../../common/swallow";

const execFileAsync = promisify(execFile);

const DOCKER_STOP_TIMEOUT_S = 10;
const DOCKER_RUN_TIMEOUT_MS = 120_000;

@Injectable()
export class DockerSandboxEngine implements SandboxEngine {
  readonly type: SandboxEngineType = "docker";
  private readonly logger = new Logger(DockerSandboxEngine.name);

  async getOrCreate(input: SandboxStartInput): Promise<SandboxRuntime> {
    const { placement, image, env, metadata } = input;
    const { workspaceHostPath, workspaceMountPath, ownerId } = placement;

    const args = [
      "run",
      "-d",
      "--init",
      "--name",
      `agework-worker-${ownerId}`,
      // Docker Desktop 按 com.docker.compose.project label 对容器分组展示
      "--label",
      "com.docker.compose.project=agework",
      "--add-host",
      "host.docker.internal:host-gateway",
    ];

    // 归属信息以 label 标注
    for (const [key, value] of Object.entries(metadata)) {
      args.push("--label", `${key}=${value}`);
    }

    // 传入的 env（由 SandboxRuntimeProvider 构造）
    for (const [key, value] of Object.entries(env)) {
      args.push("-e", `${key}=${value}`);
    }

    // Mount workspace if specified
    if (workspaceHostPath) {
      this.assertSafeMountPath(workspaceHostPath);
      args.push("-v", `${workspaceHostPath}:${workspaceMountPath}`);
    }

    if (input.runtimeLogHostPath && input.runtimeLogMountPath) {
      this.assertSafeMountPath(input.runtimeLogHostPath);
      args.push("-v", `${input.runtimeLogHostPath}:${input.runtimeLogMountPath}`);
    }

    args.push(image);

    let stdout: string;
    try {
      ({ stdout } = await execFileAsync("docker", args, {
        timeout: DOCKER_RUN_TIMEOUT_MS,
      }));
    } catch (err) {
      const conflictingContainerId = parseDockerNameConflictContainerId(err);
      if (!conflictingContainerId || !input.isExpectedRuntimeInstance) {
        throw err;
      }

      const runtimeInstanceId =
        await this.inspectContainerId(conflictingContainerId).catch(
          swallow(this.logger, `docker inspect ${conflictingContainerId}`)
        );
      if (!runtimeInstanceId) {
        throw err;
      }

      let isExpectedRuntimeInstance: boolean;
      try {
        isExpectedRuntimeInstance =
          await input.isExpectedRuntimeInstance(runtimeInstanceId);
      } catch (lookupErr) {
        this.logger.warn(
          `workspace runtime binding lookup failed for ${runtimeInstanceId.slice(0, 12)}: ${String(lookupErr)}`
        );
        throw err;
      }

      if (isExpectedRuntimeInstance) {
        throw err;
      }

      this.logger.warn(
        `Removing Docker container ${runtimeInstanceId.slice(0, 12)} not bound to current workspace before retrying sandbox create`
      );
      await this.dockerRemove(runtimeInstanceId);
      ({ stdout } = await execFileAsync("docker", args, {
        timeout: DOCKER_RUN_TIMEOUT_MS,
      }));
    }

    const containerId = stdout.trim();
    if (!containerId) {
      throw new Error("docker run returned empty container ID");
    }
    this.logger.log(
      `Container started: ownerId=${ownerId} containerId=${containerId.slice(0, 12)}`
    );
    return {
      engineType: "docker",
      runtimeInstanceId: containerId,
      workspaceMountPath,
    };
  }

  async startWorker(
    _runtime: SandboxRuntime,
    _input: SandboxStartInput
  ): Promise<void> {
    // Docker worker 通过容器 entrypoint / CMD 启动，无需额外操作
  }

  async stop(runtimeInstanceId: string): Promise<void> {
    try {
      await this.dockerStop(runtimeInstanceId);
    } catch (err) {
      this.logger.warn(
        `docker stop failed for ${runtimeInstanceId.slice(0, 12)}: ${String(err)}, force killing`
      );
      await this.dockerKill(runtimeInstanceId).catch(
        swallow(this.logger, `docker kill ${runtimeInstanceId.slice(0, 12)}`)
      );
    }
  }

  async resume(
    runtimeInstanceId: string,
    input: SandboxStartInput
  ): Promise<SandboxRuntime> {
    if (input.isExpectedRuntimeInstance) {
      const isOurs = await input.isExpectedRuntimeInstance(runtimeInstanceId);
      if (!isOurs) {
        throw new Error(
          `Container ${runtimeInstanceId.slice(0, 12)} is not bound to the current workspace`
        );
      }
    }
    await execFileAsync("docker", ["start", runtimeInstanceId]);
    return {
      engineType: "docker",
      runtimeInstanceId,
      workspaceMountPath: input.placement.workspaceMountPath,
    };
  }

  async recoverOrphan(runtimeInstanceId: string): Promise<void> {
    try {
      await this.dockerStop(runtimeInstanceId);
    } catch {
      await this.dockerKill(runtimeInstanceId).catch(
        swallow(
          this.logger,
          `recover orphan: docker kill ${runtimeInstanceId.slice(0, 12)}`
        )
      );
    }
  }

  private async dockerStop(containerId: string): Promise<void> {
    await execFileAsync("docker", [
      "stop",
      "-t",
      String(DOCKER_STOP_TIMEOUT_S),
      containerId,
    ]);
  }

  private async dockerKill(containerId: string): Promise<void> {
    await execFileAsync("docker", ["kill", containerId]);
  }

  private async dockerRemove(containerId: string): Promise<void> {
    await execFileAsync("docker", ["rm", "-f", containerId]);
  }

  private async inspectContainerId(containerId: string): Promise<string> {
    const { stdout } = await execFileAsync("docker", [
      "inspect",
      "--format",
      "{{.Id}}",
      containerId,
    ]);
    const inspectedId = stdout.trim();
    if (!inspectedId) {
      throw new Error(`docker inspect returned empty ID for ${containerId}`);
    }
    return inspectedId;
  }

  private assertSafeMountPath(hostPath: string): void {
    if (!isAbsolute(hostPath)) {
      throw new Error(`Docker mount path must be absolute: ${hostPath}`);
    }
  }
}

function parseDockerNameConflictContainerId(err: unknown): string | undefined {
  const output = errorOutput(err);
  return output.match(/is already in use by container "([a-f0-9]+)"/i)?.[1];
}

function errorOutput(err: unknown): string {
  if (!err || typeof err !== "object") {
    return String(err);
  }
  const output: string[] = [];
  if (err instanceof Error) {
    output.push(err.message);
  }
  const maybeWithOutput = err as { stderr?: unknown; stdout?: unknown };
  if (typeof maybeWithOutput.stderr === "string") {
    output.push(maybeWithOutput.stderr);
  }
  if (typeof maybeWithOutput.stdout === "string") {
    output.push(maybeWithOutput.stdout);
  }
  return output.join("\n");
}
