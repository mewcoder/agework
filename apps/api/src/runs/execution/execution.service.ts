import { Injectable } from "@nestjs/common";
import type {
  CommandPayload,
  WorkerExecutionHandle,
  WorkerExecutionStartInput,
} from "@agework/shared/protocol";
import { RunExecutorRegistry } from "./executor.registry";

/**
 * runs 到 per-run executor 的门面：按 runtimeType 解析 executor，转发
 * start / command / cancel / terminate / cleanup。
 *
 * 它不持有 live handle；LiveRunRegistry 持有 handle，本 service 只负责把
 * handle/input 转交给对应 executor。
 */
@Injectable()
export class ExecutionService {
  constructor(
    private readonly executorRegistry: RunExecutorRegistry
  ) {}

  start(input: WorkerExecutionStartInput): WorkerExecutionHandle {
    return this.executorRegistry
      .resolve(input.runtimeTarget.runtimeType)
      .start(input);
  }

  sendCommand(handle: WorkerExecutionHandle, command: CommandPayload): void {
    this.executorRegistry
      .resolve(handle.runtimeType)
      .sendCommand(handle, command);
  }

  cancel(handle: WorkerExecutionHandle): void {
    this.executorRegistry.resolve(handle.runtimeType).cancel(handle);
  }

  terminateExecution(handle: WorkerExecutionHandle, reason: string): void {
    this.executorRegistry
      .resolve(handle.runtimeType)
      .terminateExecution?.(handle.runId, reason);
  }

  cleanup(handle: WorkerExecutionHandle): void {
    this.executorRegistry.resolve(handle.runtimeType).cleanup(handle.runId);
  }
}
