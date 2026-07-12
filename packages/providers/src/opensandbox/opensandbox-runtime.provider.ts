import { Logger } from "@nestjs/common";
import type {
  RuntimeConfig,
  RuntimeProvider,
  RuntimeLaunchContext,
  RuntimeInstanceRef,
  SandboxStartInput,
} from "../types";
import { buildSandboxStartInput } from "../common/sandbox-launch";
import { swallow } from "../common/util";
import {
  OpenSandboxClient,
  type OpenSandboxClientLike,
  type OpenSandboxSandboxLike,
} from "./opensandbox-client";

/** opensandbox 运行形态:createSandbox 建沙箱 + runCommand 起 worker;stop 暂停
 *  沙箱(pauseSandbox),destroy 删除沙箱(deleteSandbox)。 */
export class OpenSandboxRuntimeProvider implements RuntimeProvider {
  readonly type = "opensandbox";
  private readonly logger = new Logger(OpenSandboxRuntimeProvider.name);
  private readonly sandboxes = new Map<string, OpenSandboxSandboxLike>();
  private readonly client: OpenSandboxClientLike;

  /** client 默认由 config.openSandbox 内部构造;单测传入替身覆盖。 */
  constructor(
    private readonly config: RuntimeConfig,
    client?: OpenSandboxClientLike
  ) {
    this.client = client ?? new OpenSandboxClient(config.openSandbox);
  }

  async start(
    ctx: RuntimeLaunchContext
  ): Promise<{ runtimeInstanceId: string }> {
    const input = buildSandboxStartInput(ctx, this.config);
    const sandbox = await this.createSandbox(input);
    await this.startWorkerInSandbox(sandbox, input);
    return { runtimeInstanceId: sandbox.id };
  }

  async stop(ref: RuntimeInstanceRef): Promise<void> {
    this.sandboxes.delete(ref.runtimeInstanceId);
    await this.client
      .pauseSandbox(ref.runtimeInstanceId)
      .catch(swallow(this.logger, `pause sandbox ${ref.runtimeInstanceId}`));
  }

  async destroy(ref: RuntimeInstanceRef): Promise<void> {
    this.sandboxes.delete(ref.runtimeInstanceId);
    await this.client
      .deleteSandbox(ref.runtimeInstanceId)
      .catch(swallow(this.logger, `delete sandbox ${ref.runtimeInstanceId}`));
  }

  private async createSandbox(
    input: SandboxStartInput
  ): Promise<OpenSandboxSandboxLike> {
    const { placement, image, env, metadata } = input;
    const { workspaceHostPath, workspaceMountPath, ownerId } = placement;

    // env / metadata / 挂载路径校验都由 buildSandboxStartInput 唯一构造,这里只透传。
    const sandbox = await this.client.createSandbox({
      image,
      env,
      timeoutSeconds: null,
      workspaceHostPath: workspaceHostPath || undefined,
      workspaceMountPath,
      runtimeLogHostPath: input.runtimeLogHostPath,
      runtimeLogMountPath: input.runtimeLogMountPath,
      metadata,
    });

    this.logger.log(
      `Sandbox created: ownerId=${ownerId} sandboxId=${sandbox.id.slice(0, 12)}`
    );

    this.sandboxes.set(sandbox.id, sandbox);
    return sandbox;
  }

  private async startWorkerInSandbox(
    sandbox: OpenSandboxSandboxLike,
    input: SandboxStartInput
  ): Promise<void> {
    const { placement, env } = input;
    const { workspaceMountPath } = placement;

    try {
      await sandbox.runCommand("node /app/dist/main.js", {
        envs: env,
        background: true,
        workingDirectory: workspaceMountPath,
      });

      this.logger.log(`Started worker in sandbox ${sandbox.id.slice(0, 12)}`);
    } catch (err) {
      this.logger.warn(
        `Failed to start worker in sandbox ${sandbox.id.slice(0, 12)}: ${String(err)}. ` +
          `Worker may start via image entrypoint instead.`
      );
    }
  }
}
