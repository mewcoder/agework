import { Logger } from "@nestjs/common";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  RuntimeProviderConfig,
  RuntimeProvider,
  RuntimeLaunchContext,
  RuntimeInstanceRef,
  SandboxStartInput,
} from "@agework/runtime-sdk";
import { buildSandboxStartInput } from "@agework/runtime-sdk";
import { swallow } from "./util";

const execFileAsync = promisify(execFile);

const DOCKER_STOP_TIMEOUT_S = 10;
const DOCKER_RUN_TIMEOUT_MS = 120_000;

/** docker 运行形态:一次 `docker run` 建容器并经 entrypoint 起 worker;stop 保留
 *  容器(`docker stop`),destroy 删除容器(`docker rm -f`)。 */
export class DockerRuntimeProvider implements RuntimeProvider {
  readonly type = "docker";
  private readonly logger = new Logger(DockerRuntimeProvider.name);

  constructor(private readonly config: RuntimeProviderConfig) {}

  async start(
    ctx: RuntimeLaunchContext,
    _onExit?: () => void,
    onProvisioned?: (runtimeInstanceId: string) => void
  ): Promise<{ runtimeInstanceId: string }> {
    const input = buildSandboxStartInput(ctx, this.config);
    const containerId = await this.runContainer(input);
    onProvisioned?.(containerId);
    return { runtimeInstanceId: containerId };
  }

  async stop(ref: RuntimeInstanceRef): Promise<void> {
    await this.stopContainer(ref.runtimeInstanceId).catch(
      swallow(this.logger, `stop container ${ref.runtimeInstanceId}`)
    );
  }

  /** 尚无独立 cache registry/TTL，释放时删除，避免 Host 丢索引后残留容器。 */
  async release(ref: RuntimeInstanceRef): Promise<void> {
    await this.destroy(ref);
  }

  async destroy(ref: RuntimeInstanceRef): Promise<void> {
    await this.dockerRemove(ref.runtimeInstanceId).catch(
      swallow(this.logger, `remove container ${ref.runtimeInstanceId}`)
    );
  }

  private async runContainer(input: SandboxStartInput): Promise<string> {
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

    // 传入的 env（由 buildSandboxStartInput 构造）
    for (const [key, value] of Object.entries(env)) {
      args.push("-e", `${key}=${value}`);
    }

    // Mount workspace if specified(路径绝对性已在 buildSandboxStartInput 校验)
    if (workspaceHostPath) {
      args.push("-v", `${workspaceHostPath}:${workspaceMountPath}`);
    }

    if (input.runtimeLogHostPath && input.runtimeLogMountPath) {
      args.push(
        "-v",
        `${input.runtimeLogHostPath}:${input.runtimeLogMountPath}`
      );
    }

    args.push(image);

    let stdout: string;
    try {
      ({ stdout } = await execFileAsync("docker", args, {
        timeout: DOCKER_RUN_TIMEOUT_MS,
      }));
    } catch (err) {
      const conflictingContainerId = parseDockerNameConflictContainerId(err);
      if (!conflictingContainerId || input.expectedRuntimeInstanceId === undefined) {
        throw err;
      }

      const runtimeInstanceId = await this.inspectContainerId(
        conflictingContainerId
      ).catch(swallow(this.logger, `docker inspect ${conflictingContainerId}`));
      if (!runtimeInstanceId) {
        throw err;
      }

      if (runtimeInstanceId === input.expectedRuntimeInstanceId) {
        // 是当前 workspace 预期绑定的那个容器,理论上不该撞名,保守不清理
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
    return containerId;
  }

  private async stopContainer(runtimeInstanceId: string): Promise<void> {
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
