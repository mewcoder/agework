import { Injectable, Logger } from "@nestjs/common";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { generateId } from "@agework/shared";
import {
  nextCommandMessage,
  type RunConfig,
  type WorkerExecutionHandle,
  type WorkerExecutionStartInput,
  type CommandPayload,
  type RunChannelMessage,
  type RpcResponse,
  type WorkerCommandResult,
} from "@agework/shared/protocol";
import {
  commandMessageToRpcRequest,
  isWorkerCommandResultRpcResponse,
  isWorkerEventRpcNotification,
  rpcNotificationToUpstreamMessage,
  rpcResponseToCommandResultMessage,
  runConfigMessageToRpcNotification,
} from "@agework/shared/protocol/rpc";
import type {
  RunEventReceiver,
  RunExecutor,
} from "./executor";
import { errorLogFields, safeLogJson } from "../../common/logging";

/** Internal state for a local worker process (not part of the protocol handle). */
type LocalRunState = {
  handle: WorkerExecutionHandle;
  child: ChildProcess;
};

// Worker entry point (TS source, executed via tsx), resolved via the
// `@agework/worker` workspace package so it works regardless of dev/dist
// layout or process cwd.
const WORKER_MAIN = require.resolve("@agework/worker");

// Run the worker through the tsx CLI rather than `node --import tsx/esm`:
// on Node 22.12+ the latter throws ERR_REQUIRE_CYCLE_MODULE for any TS entry
// file that has imports (https://github.com/privatenumber/tsx, tsx 4.22.4).
const TSX_CLI = require.resolve("tsx/cli");

/**
 * Local run executor：one run = one child process，无容器、无跨 run 复用。
 *
 * 因此 local 不写 RuntimeTarget / WorkspaceRuntime 表——没有持久容器要登记。
 * runtimeInstanceId 即 `pid:startToken`，只记在内存里，run 结束进程即销毁。
 */
@Injectable()
export class LocalRunExecutor implements RunExecutor {
  readonly type = "local" as const;
  private readonly logger = new Logger(LocalRunExecutor.name);
  private readonly states = new Map<string, LocalRunState>();
  private readonly commandSeqs = new Map<string, number>();
  private receiver!: RunEventReceiver;

  setRunEventReceiver(receiver: RunEventReceiver): void {
    this.receiver = receiver;
  }

  start(input: WorkerExecutionStartInput): WorkerExecutionHandle {
    const { runConfig, runtimeTarget } = input;
    if (runtimeTarget.runtimeType !== this.type) {
      throw new Error(
        `LocalRunExecutor cannot start worker for runtime type: ${runtimeTarget.runtimeType}`
      );
    }
    const startToken = randomUUID();
    const { runId } = runConfig;

    const child = fork(TSX_CLI, [WORKER_MAIN], {
      env: {
        ...process.env,
        AGEWORK_WORKER_KEEP_ALIVE: "false",
        AGEWORK_WORKER_CHANNEL: "ipc",
        AGEWORK_WORKER_RUN_ID: runId,
        AGEWORK_WORKER_RUN_START_TOKEN: startToken,
        ...(runConfig.workerLogFilePath
          ? { AGEWORK_WORKER_LOG_FILE: runConfig.workerLogFilePath }
          : {}),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    this.logger.log(
      `local worker started ${safeLogJson({
        runId,
        conversationId: runConfig.conversationId,
        workspaceId: runConfig.workspaceId,
        pid: child.pid,
      })}`
    );

    const handle: WorkerExecutionHandle = {
      runId,
      runtimeType: runtimeTarget.runtimeType,
      runtimeInstanceId: `${child.pid}:${startToken}`,
      conversationId: runConfig.conversationId,
    };

    this.states.set(runId, { handle, child });
    this.commandSeqs.set(runId, 0);

    // Send run config as first message
    const configMessage: RunChannelMessage<RunConfig> = {
      runId,
      seq: 0,
      type: "run.config",
      payload: runConfig,
      ts: new Date().toISOString(),
    };
    child.send(runConfigMessageToRpcNotification(configMessage));

    // Forward upstream messages to WorkerEventsService
    child.on("message", (msg: unknown) => {
      const message = normalizeWorkerIpcMessage(msg, runId);
      if (!message) {
        this.logger.warn(
          `worker ipc message ignored ${safeLogJson({
            runId,
            reason: "invalid_message",
          })}`
        );
        return;
      }
      this.receiver.sendEvent(runId, message).catch((err) => {
        this.logger.warn(
          `worker message receive failed ${safeLogJson({
            runId,
            type: message.type,
            ...errorLogFields(err),
          })}`
        );
      });
    });

    // Handle unexpected exit
    child.on("exit", (code) => {
      this.cleanup(runId);
      if (code !== 0) {
        this.logger.warn(
          `local worker exited unexpectedly ${safeLogJson({ runId, code })}`
        );
        this.receiver
          .notifyWorkerError(runId, `worker exited with code ${code}`)
          .catch((err) => {
            this.logger.warn(
              `notify worker error failed ${safeLogJson({
                runId,
                ...errorLogFields(err),
              })}`
            );
          });
      }
    });

    // Pipe worker stdout/stderr to logger
    child.stdout?.on("data", (data: Buffer) => {
      this.logger.debug(`[worker:${runId}] ${data.toString().trimEnd()}`);
    });
    child.stderr?.on("data", (data: Buffer) => {
      this.logger.debug(`[worker:${runId}:stderr] ${data.toString().trimEnd()}`);
    });

    return handle;
  }

  sendCommand(handle: WorkerExecutionHandle, command: CommandPayload): void {
    const state = this.states.get(handle.runId);
    if (!state) {
      this.logger.warn(
        `send command dropped ${safeLogJson({
          runId: handle.runId,
          commandType: command.type,
          reason: "no_active_state",
        })}`
      );
      return;
    }

    const message = nextCommandMessage(
      this.commandSeqs,
      handle.runId,
      handle.runId,
      command
    );
    this.receiver
      .recordCommandSent({
        runId: handle.runId,
        commandId: command.commandId,
        commandType: command.type,
      })
      .catch((err) => {
        this.logger.warn(
          `record command sent failed ${safeLogJson({
            runId: handle.runId,
            commandType: command.type,
            ...errorLogFields(err),
          })}`
        );
      });
    state.child.send(commandMessageToRpcRequest(message));
  }

  cancel(handle: WorkerExecutionHandle): void {
    this.sendCommand(handle, { type: "cancel", commandId: generateId(), runId: handle.runId, conversationId: handle.conversationId });
  }

  /** Run 终态后清理，幂等。 */
  cleanup(runId: string): void {
    this.states.delete(runId);
    this.commandSeqs.delete(runId);
  }

  terminateExecution(runId: string, reason: string): void {
    const state = this.states.get(runId);
    if (!state) return;

    this.logger.warn(
      `terminating local worker ${safeLogJson({
        runId,
        reason,
        pid: state.child.pid,
      })}`
    );
    try {
      if (!state.child.killed) {
        state.child.kill("SIGTERM");
      }
    } catch (err) {
      this.logger.warn(
        `terminate local worker failed ${safeLogJson({
          runId,
          reason,
          ...errorLogFields(err),
        })}`
      );
    } finally {
      this.cleanup(runId);
    }
  }

  /** runtimeInstanceId 格式为 `pid:startToken`；向 pid 发送 SIGTERM，进程已退出（ESRCH）时忽略。 */
  async cleanupInterruptedExecution(runtimeInstanceId: string): Promise<void> {
    const [pidStr] = runtimeInstanceId.split(":");
    const pid = Number(pidStr);
    if (!Number.isInteger(pid)) return;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // ESRCH: process already gone
    }
  }
}

function normalizeWorkerIpcMessage(
  message: unknown,
  fallbackRunId: string
): RunChannelMessage<unknown> | undefined {
  if (isWorkerEventRpcNotification(message)) {
    return rpcNotificationToUpstreamMessage(message);
  }
  if (isWorkerCommandResultRpcResponse(message)) {
    return rpcResponseToCommandResultMessage(
      message as RpcResponse<WorkerCommandResult>,
      { runId: fallbackRunId }
    );
  }
  return undefined;
}
