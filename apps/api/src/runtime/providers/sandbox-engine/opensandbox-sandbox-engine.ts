import { Inject, Injectable, Logger } from "@nestjs/common";
import { isAbsolute } from "node:path";
import type { SandboxEngine, SandboxEngineType, SandboxStartInput, SandboxRuntime } from ".";
import type { OpenSandboxClientLike, OpenSandboxSandboxLike } from "../opensandbox-client";
import { OPENSANDBOX_CLIENT } from "../opensandbox-client.token";

@Injectable()
export class OpenSandboxEngine implements SandboxEngine {
  readonly type: SandboxEngineType = "opensandbox";
  private readonly logger = new Logger(OpenSandboxEngine.name);

  constructor(@Inject(OPENSANDBOX_CLIENT) private readonly client: OpenSandboxClientLike) {}

  async getOrCreate(input: SandboxStartInput): Promise<SandboxRuntime> {
    const { placement, image, apiBaseUrl, accessKey, env, metadata } = input;
    const {
      workspaceHostPath,
      workspaceMountPath,
      resourceKey,
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
        AGEWORK_INTERNAL_TRANSPORT: "http",
        AGEWORK_INTERNAL_API_BASE: apiBaseUrl,
        AGEWORK_INTERNAL_RUNTIME_ACCESS_KEY: accessKey,
        AGEWORK_INTERNAL_WORKSPACE_ID: resourceKey,
        AGEWORK_INTERNAL_ISOLATION_SCOPE: isolationScope,
        ...env,
      },
      timeoutSeconds: null,
      workspaceHostPath: workspaceHostPath || undefined,
      workspaceMountPath,
      runtimeLogHostPath: input.runtimeLogHostPath,
      runtimeLogMountPath: input.runtimeLogMountPath,
      metadata: {
        "agework.io/runtime-resource-key": resourceKey,
        "agework.io/isolation-scope": isolationScope,
        ...metadata,
      },
    });

    this.logger.log(
      `Sandbox created: resourceKey=${resourceKey} sandboxId=${sandbox.id.slice(0, 12)}`
    );

    // 创建后立即启动 worker，避免 getSdk 重新查找时因延迟找不到
    await this.startWorkerInSandbox(sandbox, input);

    return {
      engineType: "opensandbox",
      runtimeResourceId: sandbox.id,
      workspaceMountPath,
    };
  }

  async startWorker(
    _runtime: SandboxRuntime,
    _input: SandboxStartInput
  ): Promise<void> {
    // OpenSandbox 的 worker 在 getOrCreate 中启动，此处为空操作。
    // 如果后续需要 DB resource 恢复场景下重启 worker，可在此实现。
  }

  async stop(runtimeResourceId: string): Promise<void> {
    await this.client.pauseSandbox(runtimeResourceId);
  }

  async resume(
    runtimeResourceId: string,
    input: SandboxStartInput
  ): Promise<SandboxRuntime> {
    const sandbox = await this.client.resumeSandbox(runtimeResourceId);
    this.logger.log(
      `Sandbox resumed: resourceKey=${input.placement.resourceKey} sandboxId=${sandbox.id.slice(0, 12)}`
    );
    return {
      engineType: "opensandbox",
      runtimeResourceId: sandbox.id,
      workspaceMountPath: input.placement.workspaceMountPath,
    };
  }

  async recoverOrphan(runtimeResourceId: string): Promise<void> {
    await this.client.deleteSandbox(runtimeResourceId);
  }

  async isHealthy(runtimeResourceId: string): Promise<boolean> {
    try {
      const sandbox = await this.client.getSandbox(runtimeResourceId);
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
    const { resourceKey, isolationScope, workspaceMountPath } = placement;

    try {
      const envs: Record<string, string> = {
        AGEWORK_INTERNAL_TRANSPORT: "http",
        AGEWORK_INTERNAL_WORKER_MODE: "persistent",
        AGEWORK_INTERNAL_WORKSPACE_ID: resourceKey,
        AGEWORK_INTERNAL_API_BASE: apiBaseUrl,
        AGEWORK_INTERNAL_RUNTIME_ACCESS_KEY: accessKey,
        AGEWORK_INTERNAL_ISOLATION_SCOPE: isolationScope,
        ...env,
        AGEWORK_INTERNAL_RUNTIME_RESOURCE_ID: sandbox.id,
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
