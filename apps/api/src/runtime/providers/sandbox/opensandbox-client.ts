import { Sandbox, SandboxManager, ConnectionConfig } from "@alibaba-group/opensandbox";
import type { ConfigService } from "../../../config/config.service";

/**
 * OpenSandbox SDK 适配边界：定义内部接口，provider 不直接依赖真实 SDK 的完整类型。
 * 真实 SDK 的 import 只出现在此文件中，单测 provider 时 mock OpenSandboxClientLike 即可。
 */

export interface OpenSandboxCreateInput {
  image: string;
  env?: Record<string, string>;
  timeoutSeconds: number | null;
  workspaceHostPath?: string;
  workspaceMountPath: string;
  runtimeLogHostPath?: string;
  runtimeLogMountPath?: string;
  metadata?: Record<string, string>;
}

export interface OpenSandboxCommandOptions {
  envs?: Record<string, string>;
  background?: boolean;
  workingDirectory?: string;
}

export interface OpenSandboxSandboxLike {
  id: string;
  runCommand(
    command: string,
    options?: OpenSandboxCommandOptions
  ): Promise<unknown>;
  pause(): Promise<void>;
  resume(): Promise<OpenSandboxSandboxLike>;
  kill(): Promise<void>;
  close(): Promise<void>;
  renew(timeoutSeconds: number): Promise<void>;
  isHealthy(): Promise<boolean>;
  getEndpointUrl(port: number): Promise<string>;
}

export interface OpenSandboxClientLike {
  createSandbox(input: OpenSandboxCreateInput): Promise<OpenSandboxSandboxLike>;
  getSandbox(id: string): Promise<OpenSandboxSandboxLike | null>;
  pauseSandbox(id: string): Promise<void>;
  resumeSandbox(id: string): Promise<OpenSandboxSandboxLike>;
  deleteSandbox(id: string): Promise<void>;
}

/**
 * 真实 SDK 的 OpenSandboxClient 实现。
 * 连接配置从 ConfigService 读取。
 */
export class OpenSandboxClient implements OpenSandboxClientLike {
  private readonly connectionConfig: ConnectionConfig;

  constructor(configService: ConfigService) {
    const cfg = configService.getOpenSandboxConfig();
    this.connectionConfig = new ConnectionConfig({
      domain: cfg.domain,
      protocol: cfg.protocol,
      apiKey: cfg.apiKey,
      useServerProxy: cfg.useServerProxy,
    });
  }

  async createSandbox(
    input: OpenSandboxCreateInput
  ): Promise<OpenSandboxSandboxLike> {
    const sandbox = await Sandbox.create({
      connectionConfig: this.connectionConfig.withTransportIfMissing(),
      image: input.image,
      env: input.env,
      timeoutSeconds: input.timeoutSeconds,
      metadata: input.metadata,
      volumes: buildVolumes(input),
      skipHealthCheck: false,
    });
    return new OpenSandboxSandboxAdapter(sandbox);
  }

  async getSandbox(id: string): Promise<OpenSandboxSandboxLike | null> {
    try {
      const sandbox = await Sandbox.connect({
        connectionConfig: this.connectionConfig.withTransportIfMissing(),
        sandboxId: id as any,
        skipHealthCheck: true,
      });
      const info = await sandbox.getInfo();
      if (String(info.status?.state).toLowerCase() !== "running") {
        await sandbox.close().catch(() => {});
        return null;
      }
      return new OpenSandboxSandboxAdapter(sandbox);
    } catch {
      return null;
    }
  }

  async pauseSandbox(id: string): Promise<void> {
    await this.withManager((manager) => manager.pauseSandbox(id as any));
  }

  async resumeSandbox(id: string): Promise<OpenSandboxSandboxLike> {
    const sandbox = await Sandbox.resume({
      connectionConfig: this.connectionConfig,
      sandboxId: id as any,
      skipHealthCheck: false,
    });
    return new OpenSandboxSandboxAdapter(sandbox);
  }

  async deleteSandbox(id: string): Promise<void> {
    try {
      await this.withManager((manager) => manager.killSandbox(id as any));
    } catch {
      // sandbox 不存在时静默忽略
    }
  }

  private async withManager<T>(
    fn: (manager: SandboxManager) => Promise<T>
  ): Promise<T> {
    const manager = SandboxManager.create({
      connectionConfig: this.connectionConfig,
    });
    try {
      return await fn(manager);
    } finally {
      await manager.close().catch(() => {});
    }
  }
}

/**
 * 将真实 Sandbox 实例适配为 OpenSandboxSandboxLike 接口。
 */
export class OpenSandboxSandboxAdapter implements OpenSandboxSandboxLike {
  constructor(private readonly sandbox: Sandbox) {}

  get id(): string {
    return this.sandbox.id as unknown as string;
  }

  async runCommand(
    command: string,
    options?: OpenSandboxCommandOptions
  ): Promise<unknown> {
    return this.sandbox.commands.run(command, {
      envs: options?.envs,
      background: options?.background,
      workingDirectory: options?.workingDirectory,
    });
  }

  async pause(): Promise<void> {
    await this.sandbox.pause();
  }

  async resume(): Promise<OpenSandboxSandboxLike> {
    const resumed = await this.sandbox.resume();
    await this.sandbox.close().catch(() => {});
    return new OpenSandboxSandboxAdapter(resumed);
  }

  async kill(): Promise<void> {
    await this.sandbox.kill();
    await this.sandbox.close();
  }

  async close(): Promise<void> {
    await this.sandbox.close();
  }

  async renew(timeoutSeconds: number): Promise<void> {
    await this.sandbox.renew(timeoutSeconds);
  }

  async isHealthy(): Promise<boolean> {
    return this.sandbox.isHealthy();
  }

  async getEndpointUrl(port: number): Promise<string> {
    return this.sandbox.getEndpointUrl(port);
  }
}

function buildVolumes(input: OpenSandboxCreateInput) {
  const volumes = [];
  if (input.workspaceHostPath) {
    volumes.push({
      name: "workspace",
      mountPath: input.workspaceMountPath,
      host: { path: input.workspaceHostPath },
    });
  }
  if (input.runtimeLogHostPath && input.runtimeLogMountPath) {
    volumes.push({
      name: "runtime-logs",
      mountPath: input.runtimeLogMountPath,
      host: { path: input.runtimeLogHostPath },
    });
  }
  return volumes.length ? volumes : undefined;
}
