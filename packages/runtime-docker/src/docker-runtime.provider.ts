import { Logger } from "@nestjs/common";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  RuntimeProviderConfig,
  RuntimeProvider,
  RuntimeLaunchContext,
  RuntimeInstanceRef,
  RuntimeStartOptions,
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
    onProvisioned?: (runtimeInstanceId: string) => void,
    options?: RuntimeStartOptions
  ): Promise<{ runtimeInstanceId: string }> {
    options?.signal?.throwIfAborted();
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

  /** 尚无独立 cache registry/TTL，释放时删除，避免 Host 丢索引后残留容器。
   *  不吞错误:清理失败必须传播给调用方,由 Runtime 写入重试账本(SPEC §5.2)。
   *  "No such container" 视为成功(资源已不存在)。 */
  async release(ref: RuntimeInstanceRef): Promise<void> {
    await this.destroy(ref);
  }

  async destroy(ref: RuntimeInstanceRef): Promise<void> {
    try {
      await this.dockerRemove(ref.runtimeInstanceId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // "No such container" / "not found" 视为成功:资源已不存在
      if (/no such|not found/i.test(msg)) {
        this.logger.warn(
          `container ${ref.runtimeInstanceId.slice(0, 12)} already gone: ${msg}`
        );
        return;
      }
      throw err;
    }
  }

  private async runContainer(input: SandboxStartInput): Promise<string> {
    const { placement, image, env, metadata } = input;
    const { workspaceHostPath, workspaceMountPath } = placement;

    const args = [
      "run",
      "-d",
      "--init",
      // 不再使用 ownerId 稳定命名:让 Docker 自动生成容器名,避免跨 subject 碰撞
      // 与误停。stop/destroy 始终以 containerId 为准。workerId 仅作为 label 便于排查。
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

    const { stdout } = await execFileAsync("docker", args, {
      timeout: DOCKER_RUN_TIMEOUT_MS,
    });

    const containerId = stdout.trim();
    if (!containerId) {
      throw new Error("docker run returned empty container ID");
    }
    this.logger.log(
      `Container started: workerId=${metadata["agework.io/worker-id"] ?? "?"} containerId=${containerId.slice(0, 12)}`
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
}
