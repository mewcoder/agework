import { Injectable } from "@nestjs/common";
import type {
  CommandPayload,
  WorkerExecutionHandle,
  WorkerExecutionStartInput,
} from "@agework/shared/protocol";
import { WorkerRunExecutor } from "./worker-run.executor";
import type { RunEventPort } from "./executor";

/**
 * runs 到执行器的应用层入口：转发 start / command / cancel / terminate / cleanup
 * 给唯一的 `WorkerRunExecutor`——runtimeType(sandbox/local)判断已经被
 * `WorkerHostService` 内部吸收（设计文档第一节),这里不再需要按类型查找执行器。
 *
 * 它不持有 live handle；LiveRunRegistry 持有 handle，本 service 只负责把
 * handle/input 转交给执行器。
 */
@Injectable()
export class ExecutionService {
  constructor(private readonly executor: WorkerRunExecutor) {}

  start(input: WorkerExecutionStartInput): WorkerExecutionHandle {
    return this.executor.start(input);
  }

  sendCommand(handle: WorkerExecutionHandle, command: CommandPayload): void {
    this.executor.sendCommand(handle, command);
  }

  cancel(handle: WorkerExecutionHandle): void {
    this.executor.cancel(handle);
  }

  terminateExecution(handle: WorkerExecutionHandle, reason: string): void {
    this.executor.terminateExecution?.(handle.runId, reason);
  }

  cleanup(handle: WorkerExecutionHandle): void {
    this.executor.cleanup(handle.runId);
  }

  setRunEventPort(receiver: RunEventPort): void {
    this.executor.setRunEventPort(receiver);
  }
}
