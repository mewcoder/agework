import { Injectable } from "@nestjs/common";
import type {
  WorkerExecutionHandle,
  WorkerExecutionStartInput,
  CommandPayload,
} from "@agework/shared/protocol";
import type { RunEventReceiver, RunExecutor } from "./executor";
import { RuntimeService } from "../../runtime/runtime.service";

/**
 * sandbox run executor 适配器：sandbox 执行编排归 runtime 层，本类只把 RunExecutor
 * 契约薄转发到 RuntimeService 门面，run 模块因此不直接依赖任何 runtime 内部 provider。
 */
@Injectable()
export class SandboxRunExecutor implements RunExecutor {
  readonly type = "sandbox" as const;

  constructor(private readonly runtimeService: RuntimeService) {}

  setRunEventReceiver(receiver: RunEventReceiver): void {
    this.runtimeService.setSandboxWorkerEventSink(receiver);
  }

  start(input: WorkerExecutionStartInput): WorkerExecutionHandle {
    return this.runtimeService.startSandboxWorker(input);
  }

  sendCommand(handle: WorkerExecutionHandle, command: CommandPayload): void {
    this.runtimeService.sendSandboxCommand(handle, command);
  }

  cancel(handle: WorkerExecutionHandle): void {
    this.runtimeService.cancelSandboxRun(handle);
  }

  terminateExecution(runId: string, reason: string): void {
    this.runtimeService.terminateSandboxRun(runId, reason);
  }

  cleanup(runId: string): void {
    this.runtimeService.cleanupSandboxRun(runId);
  }

  cleanupInterruptedExecution(runtimeInstanceId: string): Promise<void> {
    return this.runtimeService.recoverSandboxOrphan(runtimeInstanceId);
  }
}
