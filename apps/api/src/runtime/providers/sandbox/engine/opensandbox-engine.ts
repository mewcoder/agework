import { Inject, Injectable, Logger } from "@nestjs/common";
import { isAbsolute } from "node:path";
import type { SandboxEngine, SandboxEngineType, SandboxStartInput, SandboxRuntime } from ".";
import type { OpenSandboxClientLike, OpenSandboxSandboxLike } from "../opensandbox-client";
import { OPENSANDBOX_CLIENT } from "../opensandbox-client.token";

@Injectable()
export class OpenSandboxEngine implements SandboxEngine {
  readonly type: SandboxEngineType = "opensandbox";
  private readonly logger = new Logger(OpenSandboxEngine.name);
  private readonly sandboxes = new Map<string, OpenSandboxSandboxLike>();

  constructor(@Inject(OPENSANDBOX_CLIENT) private readonly client: OpenSandboxClientLike) {}

  async getOrCreate(input: SandboxStartInput): Promise<SandboxRuntime> {
    const { placement, image, apiBaseUrl, accessKey, env, metadata } = input;
    const {
      workspaceHostPath,
      workspaceMountPath,
      ownerId,
      isolationScope,
    } = placement;

    if (workspaceHostPath) {
      this.assertSafeMountPath(workspaceHostPath);
    }
    if (input.runtimeLogHostPath) {
      this.assertSafeMountPath(input.runtimeLogHostPath);
    }

    const sandbox = await this.client.createSandbox({
      image,
      env: {
        AGEWORK_WORKER_CHANNEL: "http",
        AGEWORK_WORKER_API_BASE: apiBaseUrl,
        AGEWORK_WORKER_RUNTIME_ACCESS_KEY: accessKey,
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

    return {
      engineType: "opensandbox",
      runtimeInstanceId: sandbox.id,
      workspaceMountPath,
    };
  }

  async startWorker(
    runtime: SandboxRuntime,
    input: SandboxStartInput
  ): Promise<void> {
    const sandbox =
      this.sandboxes.get(runtime.runtimeInstanceId) ??
      (await this.client.getSandbox(runtime.runtimeInstanceId));
    if (!sandbox) {
      throw new Error(
        `Cannot start worker: sandbox ${runtime.runtimeInstanceId.slice(0, 12)} not found`
      );
    }
    this.sandboxes.set(sandbox.id, sandbox);
    await this.startWorkerInSandbox(sandbox, input);
  }

  async stop(runtimeInstanceId: string): Promise<void> {
    this.sandboxes.delete(runtimeInstanceId);
    await this.client.pauseSandbox(runtimeInstanceId);
  }

  async resume(
    runtimeInstanceId: string,
    input: SandboxStartInput
  ): Promise<SandboxRuntime> {
    const sandbox = await this.client.resumeSandbox(runtimeInstanceId);
    this.sandboxes.set(sandbox.id, sandbox);
    this.logger.log(
      `Sandbox resumed: ownerId=${input.placement.ownerId} sandboxId=${sandbox.id.slice(0, 12)}`
    );
    return {
      engineType: "opensandbox",
      runtimeInstanceId: sandbox.id,
      workspaceMountPath: input.placement.workspaceMountPath,
    };
  }

  async recoverOrphan(runtimeInstanceId: string): Promise<void> {
    this.sandboxes.delete(runtimeInstanceId);
    await this.client.deleteSandbox(runtimeInstanceId);
  }

  async isHealthy(runtimeInstanceId: string): Promise<boolean> {
    try {
      const sandbox = await this.client.getSandbox(runtimeInstanceId);
      if (!sandbox) return false;
      return await sandbox.isHealthy();
    } catch {
      return false;
    }
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
    const { placement, apiBaseUrl, accessKey, env } = input;
    const { ownerId, isolationScope, workspaceMountPath } = placement;

    try {
      const envs: Record<string, string> = {
        AGEWORK_WORKER_CHANNEL: "http",
        AGEWORK_WORKER_OWNER_ID: ownerId,
        AGEWORK_WORKER_API_BASE: apiBaseUrl,
        AGEWORK_WORKER_RUNTIME_ACCESS_KEY: accessKey,
        AGEWORK_WORKER_ISOLATION_SCOPE: isolationScope,
        ...env,
      };

      await sandbox.runCommand("node /app/dist/main.js", {
        envs,
        background: true,
        workingDirectory: workspaceMountPath,
      });

      this.logger.log(
        `Started persistent worker in sandbox ${sandbox.id.slice(0, 12)}`
      );
    } catch (err) {
      this.logger.warn(
        `Failed to start worker in sandbox ${sandbox.id.slice(0, 12)}: ${String(err)}. ` +
          `Worker may start via image entrypoint instead.`
      );
    }
  }
}
