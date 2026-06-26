import { Injectable } from "@nestjs/common";
import type { CommandPayload } from "@agework/shared/protocol";
import { RuntimeProviderRegistry } from "../../runtime/providers/provider-registry";
import type {
  RunDriverStartInput,
  WorkerExecutionHandle,
} from "./run-driver.types";

/**
 * Run 驱动 provider 的薄缝：按 runtimeType 解析 provider，下发 start / command /
 * cancel / heartbeat / cleanup。无状态——live handle 由 RunActiveStore 单独持有，
 * 各方法要么返回 handle、要么收 handle，不再自留派发表。
 *
 * worker 的物理启动（local fork / sandbox 容器会话）在 runtime provider 内实现，
 * 这里只驱动其 WorkerExecutionProvider 契约——「Run 驱动执行」，区别于
 * 「Runtime 准备环境」(RuntimeService.resolveRuntimeTarget)。
 */
@Injectable()
export class RunDriver {
  constructor(private readonly providerRegistry: RuntimeProviderRegistry) {}

  start(input: RunDriverStartInput): WorkerExecutionHandle {
    return this.providerRegistry
      .resolve(input.runtimeTarget.runtimeType)
      .startWorkerExecution(input);
  }

  sendCommand(handle: WorkerExecutionHandle, command: CommandPayload): void {
    this.providerRegistry
      .resolve(handle.runtimeType)
      .sendCommand(handle, command);
  }

  cancel(handle: WorkerExecutionHandle): void {
    this.providerRegistry.resolve(handle.runtimeType).cancel(handle);
  }

  heartbeat(handle: WorkerExecutionHandle): void {
    this.providerRegistry.resolve(handle.runtimeType).heartbeat(handle.runId);
  }

  cleanup(handle: WorkerExecutionHandle): void {
    this.providerRegistry.resolve(handle.runtimeType).cleanup(handle.runId);
  }
}
