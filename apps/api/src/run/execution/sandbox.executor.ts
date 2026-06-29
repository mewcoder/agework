import { Injectable, Logger } from "@nestjs/common";
import { generateId } from "@agework/shared";
import type {
  WorkerExecutionHandle,
  WorkerExecutionStartInput,
  CommandPayload,
} from "@agework/shared/protocol";
import type { RunEventPort, RunExecutor } from "./executor";
import { RuntimeService } from "../../runtime/runtime.service";
import { errorLogFields, safeLogJson } from "../../common/logging";

/**
 * sandbox run executor 适配器：sandbox 执行编排归 runtime 层，本类只把 RunExecutor
 * 契约薄转发到 RuntimeService 门面，run 模块因此不直接依赖任何 runtime 内部 provider。
 *
 * 命令下发的 command.sent trace 由本类（run 侧）在下发时记录，与 LocalRunExecutor
 * 对称；worker-host 不再反向回连 run-event。首个 user_message 也由本类在 start
 * 后显式下发，触发持久 worker 拉起 runner。
 */
@Injectable()
export class SandboxRunExecutor implements RunExecutor {
  readonly type = "sandbox" as const;
  private readonly logger = new Logger(SandboxRunExecutor.name);
  private receiver!: RunEventPort;

  constructor(private readonly runtimeService: RuntimeService) {}

  setRunEventPort(receiver: RunEventPort): void {
    this.receiver = receiver;
    this.runtimeService.setSandboxWorkerEventPort(receiver);
  }

  start(input: WorkerExecutionStartInput): WorkerExecutionHandle {
    const handle = this.runtimeService.startSandboxWorker(input);
    // 持久 worker 按 ownerId 轮询命令；首个 user_message 触发它为本 run 拉起 runner。
    this.sendCommand(handle, {
      type: "user_message",
      commandId: generateId(),
      runId: handle.runId,
    });
    return handle;
  }

  sendCommand(handle: WorkerExecutionHandle, command: CommandPayload): void {
    const sent = this.runtimeService.sendSandboxCommand(handle, command);
    // 只为真正入队的命令记 command.sent；被 no_owner drop 的命令不记，与重构前一致。
    if (sent) this.recordCommandSent(handle.runId, command);
  }

  cancel(handle: WorkerExecutionHandle): void {
    const sent = this.runtimeService.cancelSandboxRun(handle);
    if (sent) this.recordCommandSent(handle.runId, sent);
  }

  private recordCommandSent(runId: string, command: CommandPayload): void {
    this.receiver
      .recordCommandSent({
        runId,
        commandId: command.commandId,
        commandType: command.type,
      })
      .catch((err) =>
        this.logger.warn(
          `record command sent failed ${safeLogJson({
            runId,
            commandType: command.type,
            ...errorLogFields(err),
          })}`
        )
      );
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
