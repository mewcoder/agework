import { Logger } from "@nestjs/common";
import {
  buildSandboxStartInput,
  type RuntimeProviderConfig,
  type RuntimeProvider,
  type RuntimeLaunchContext,
  type RuntimeInstanceRef,
  type RuntimeStartOptions,
  type SandboxStartInput,
} from "@agework/runtime-sdk";
import { swallow } from "./util";
import {
  OpenSandboxClient,
  type OpenSandboxClientLike,
  type OpenSandboxSandboxLike,
} from "./opensandbox-client";
import type { OpenSandboxConnectionConfig } from "./types";

/** OpenSandbox runtime:createSandbox 建沙箱 + runCommand 起 worker;stop 暂停
 *  沙箱(pauseSandbox),destroy 删除沙箱(deleteSandbox)。 */
export class OpenSandboxRuntimeProvider implements RuntimeProvider {
  readonly type = "opensandbox";
  private readonly logger = new Logger(OpenSandboxRuntimeProvider.name);
  private readonly sandboxes = new Map<string, OpenSandboxSandboxLike>();
  private readonly client: OpenSandboxClientLike;

  /** client 默认由插件私有连接配置构造；单测可传入替身覆盖。 */
  constructor(
    private readonly config: RuntimeProviderConfig,
    connectionConfig: OpenSandboxConnectionConfig,
    client?: OpenSandboxClientLike
  ) {
    this.client = client ?? new OpenSandboxClient(connectionConfig);
  }

  async start(
    ctx: RuntimeLaunchContext,
    _onExit?: () => void,
    onProvisioned?: (runtimeInstanceId: string) => void,
    options?: RuntimeStartOptions
  ): Promise<{ runtimeInstanceId: string }> {
    options?.signal?.throwIfAborted();
    const input = buildSandboxStartInput(ctx, this.config);
    const sandbox = await this.createSandbox(input);
    onProvisioned?.(sandbox.id);
    options?.signal?.throwIfAborted();
    await this.startWorkerInSandbox(sandbox, input);
    return { runtimeInstanceId: sandbox.id };
  }

  async stop(ref: RuntimeInstanceRef): Promise<void> {
    this.sandboxes.delete(ref.runtimeInstanceId);
    await this.client
      .pauseSandbox(ref.runtimeInstanceId)
      .catch(swallow(this.logger, `pause sandbox ${ref.runtimeInstanceId}`));
  }

  /** 当前没有可靠的 paused sandbox 重新接管协议，释放策略选择直接删除。
   *  不吞错误:清理失败必须传播给调用方,由 Runtime 写入重试账本(SPEC §5.2)。
   *  sandbox 已不存在的错误视为成功(资源已不存在)。 */
  async release(ref: RuntimeInstanceRef): Promise<void> {
    await this.destroy(ref);
  }

  async destroy(ref: RuntimeInstanceRef): Promise<void> {
    this.sandboxes.delete(ref.runtimeInstanceId);
    try {
      await this.client.deleteSandbox(ref.runtimeInstanceId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // sandbox 已不存在视为成功
      if (/not found|no such|404/i.test(msg)) {
        this.logger.warn(
          `sandbox ${ref.runtimeInstanceId.slice(0, 12)} already gone: ${msg}`
        );
        return;
      }
      throw err;
    }
  }

  private async createSandbox(
    input: SandboxStartInput
  ): Promise<OpenSandboxSandboxLike> {
    const { placement, image, env, metadata } = input;
    const { workspaceHostPath, workspaceMountPath } = placement;

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
      `Sandbox created: workerId=${metadata["agework.io/worker-id"] ?? "?"} sandboxId=${sandbox.id.slice(0, 12)}`
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
