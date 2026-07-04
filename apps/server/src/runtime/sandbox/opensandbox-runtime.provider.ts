import { Inject, Injectable, Logger } from "@nestjs/common";
import { isAbsolute } from "node:path";
import type {
  RuntimeProvider,
  RuntimeLaunchContext,
  RuntimeInstanceRef,
  SandboxStartInput,
} from "../runtime.types";
import { ConfigService } from "../../config/config.service";
import { buildSandboxStartInput } from "./sandbox-utils";
import { swallow } from "../../common/swallow";
import {
  OPENSANDBOX_CLIENT,
  type OpenSandboxClientLike,
  type OpenSandboxSandboxLike,
} from "./opensandbox-client";

/** opensandbox 运行形态:createSandbox 建沙箱 + runCommand 起 worker;stop 暂停
 *  沙箱(pauseSandbox),destroy 删除沙箱(deleteSandbox)。 */
@Injectable()
export class OpenSandboxRuntimeProvider implements RuntimeProvider {
  readonly type = "opensandbox";
  private readonly logger = new Logger(OpenSandboxRuntimeProvider.name);
  private readonly sandboxes = new Map<string, OpenSandboxSandboxLike>();

  constructor(
    @Inject(OPENSANDBOX_CLIENT)
    private readonly client: OpenSandboxClientLike,
    private readonly configService: ConfigService
  ) {}

  async start(
    ctx: RuntimeLaunchContext
  ): Promise<{ runtimeInstanceId: string }> {
    const input = buildSandboxStartInput(
      ctx,
      this.type,
      this.configService.getRuntimeLogDir()
    );
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
    const { placement, image, apiBaseUrl, env, metadata } = input;
    const { workspaceHostPath, workspaceMountPath, ownerId, isolationScope } =
      placement;

    if (workspaceHostPath) {
      this.assertSafeMountPath(workspaceHostPath);
    }
    if (input.runtimeLogHostPath) {
      this.assertSafeMountPath(input.runtimeLogHostPath);
    }

    const sandbox = await this.client.createSandbox({
      image,
      env: {
        AGEWORK_WORKER_ROLE: "worker",
        AGEWORK_WORKER_CHANNEL: "http",
        AGEWORK_WORKER_API_BASE: apiBaseUrl,
        AGEWORK_WORKER_OWNER_ID: ownerId,
        AGEWORK_WORKER_ISOLATION_SCOPE: isolationScope,
        ...env,
      },
      timeoutSeconds: null,
      workspaceHostPath: workspaceHostPath || undefined,
      workspaceMountPath,
      runtimeLogHostPath: input.runtimeLogHostPath,
      runtimeLogMountPath: input.runtimeLogMountPath,
      metadata: {
        "agework.io/runtime-owner-id": ownerId,
        "agework.io/isolation-scope": isolationScope,
        ...metadata,
      },
    });

    this.logger.log(
      `Sandbox created: ownerId=${ownerId} sandboxId=${sandbox.id.slice(0, 12)}`
    );

    this.sandboxes.set(sandbox.id, sandbox);
    return sandbox;
  }

  private assertSafeMountPath(hostPath: string): void {
    if (!isAbsolute(hostPath)) {
      throw new Error(`OpenSandbox mount path must be absolute: ${hostPath}`);
    }
  }

  private async startWorkerInSandbox(
    sandbox: OpenSandboxSandboxLike,
    input: SandboxStartInput
  ): Promise<void> {
    const { placement, apiBaseUrl, env } = input;
    const { ownerId, isolationScope, workspaceMountPath } = placement;

    try {
      const envs: Record<string, string> = {
        AGEWORK_WORKER_ROLE: "worker",
        AGEWORK_WORKER_CHANNEL: "http",
        AGEWORK_WORKER_OWNER_ID: ownerId,
        AGEWORK_WORKER_API_BASE: apiBaseUrl,
        AGEWORK_WORKER_ISOLATION_SCOPE: isolationScope,
        ...env,
      };

      await sandbox.runCommand("node /app/dist/main.js", {
        envs,
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
