import { Injectable } from "@nestjs/common";
import type { RunConfig } from "@agework/shared/protocol";

/**
 * 内存 RunConfig 暂存。
 * sandbox runtime 的兼容启动路径 register，worker HTTP 拉取时 get，终态后 unregister。
 * LocalRuntimeProvider 不使用此 store（IPC 直接发送 config）。
 */
@Injectable()
export class RuntimeConfigStore {
  private readonly configs = new Map<string, RunConfig>();

  register(runId: string, config: RunConfig): void {
    this.configs.set(runId, config);
  }

  get(runId: string): RunConfig | undefined {
    return this.configs.get(runId);
  }

  unregister(runId: string): void {
    this.configs.delete(runId);
  }
}
