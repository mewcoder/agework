import { fork, type ChildProcess } from "node:child_process";
import type {
  CommandPayload,
  RunChannelMessage,
  RunConfig,
  RunStatusPayload,
  UpstreamMessage,
  WorkerCommandResult,
  RpcResponse,
} from "@agework/shared/protocol";
import {
  commandMessageToRpcRequest,
  isWorkerCommandResultRpcResponse,
  isWorkerEventRpcNotification,
  rpcNotificationToUpstreamMessage,
  rpcResponseToCommandResultMessage,
  runConfigMessageToRpcNotification,
} from "@agework/shared/protocol/rpc";
import type { CommandReceipts } from "./commands.js";
import {
  errorDetails,
  registerWorkerRunLog,
  unregisterWorkerRunLog,
  workerLog,
} from "./logs/worker.js";

type UserMessageCommand = Extract<CommandPayload, { type: "user_message" }>;
type CancelCommand = Extract<CommandPayload, { type: "cancel" }>;
type InterruptCommand = Extract<CommandPayload, { type: "interrupt" }>;
type ApprovalResolvedCommand = Extract<
  CommandPayload,
  { type: "approval_resolved" }
>;

export type RunnerManagerClient = {
  fetchRunConfig(runId: string): Promise<RunConfig>;
  emit(runId: string, msg: UpstreamMessage): Promise<void>;
  cleanup(runId: string): void;
};

type RunnerProcess = {
  child: ChildProcess;
  runId: string;
  conversationId: string;
  terminalSeen: boolean;
  cleaned: boolean;
};

export class RunnerManager {
  private readonly runners = new Map<string, RunnerProcess>();
  private readonly conversationIdToRun = new Map<string, string>();
  private readonly commandSeqs = new Map<string, number>();

  constructor(
    private readonly client: RunnerManagerClient,
    private readonly commandReceipts: CommandReceipts
  ) {}

  async handle(command: CommandPayload): Promise<void> {
    switch (command.type) {
      case "user_message":
        await this.handleUserMessage(command);
        break;
      case "cancel":
        this.forwardRunCommand(command);
        break;
      case "interrupt":
        this.forwardInterrupt(command);
        break;
      case "approval_resolved":
        this.forwardApprovalResolved(command);
        break;
    }
  }

  size(): number {
    return this.runners.size;
  }

  async shutdown(signal: NodeJS.Signals): Promise<void> {
    const active = [...this.runners.values()];
    workerLog("keep-alive worker received shutdown signal", {
      signal,
      activeRuns: active.map((runner) => ({ runId: runner.runId })),
    }, active.length > 0 ? "warn" : "info");

    await Promise.allSettled(
      active.map(async (runner) => {
        runner.terminalSeen = true;
        await this.emitRunStatusSafely(runner.runId, {
          status: "error",
          error: `worker received ${signal}`,
        });
        this.terminateRunner(runner, signal);
        this.cleanupRunner(runner.runId);
      })
    );
  }

  private async handleUserMessage(command: UserMessageCommand): Promise<void> {
    workerLog("processing user_message command", {
      runId: command.runId,
      commandId: command.commandId,
    });
    this.commandReceipts.received(command.runId, command);

    let config: RunConfig;
    try {
      config = await this.client.fetchRunConfig(command.runId);
    } catch (err) {
      workerLog("failed to fetch run config", {
        runId: command.runId,
        ...errorDetails(err),
      }, "error");
      this.commandReceipts.failed(command.runId, command, String(err));
      await this.emitRunStatusSafely(command.runId, {
        status: "error",
        error: `Failed to fetch run config: ${String(err)}`,
      });
      return;
    }

    if (this.runners.has(command.runId)) {
      this.commandReceipts.failed(
        command.runId,
        command,
        "run already active"
      );
      return;
    }

    registerWorkerRunLog({
      runId: config.runId,
      conversationId: config.conversationId,
      filePath: config.workerLogFilePath,
    });

    let runner: RunnerProcess;
    try {
      runner = this.startRunner(config);
    } catch (err) {
      unregisterWorkerRunLog(config.runId);
      workerLog("failed to start runner process", {
        runId: command.runId,
        commandId: command.commandId,
        ...errorDetails(err),
      }, "error");
      this.commandReceipts.failed(command.runId, command, String(err));
      await this.emitRunStatusSafely(command.runId, {
        status: "error",
        error: `Failed to start runner process: ${String(err)}`,
      });
      this.client.cleanup(command.runId);
      return;
    }

    this.runners.set(command.runId, runner);
    this.conversationIdToRun.set(config.conversationId, command.runId);

    workerLog("started runner process", {
      runId: command.runId,
      conversationId: config.conversationId,
      pid: runner.child.pid,
    });
    this.sendRunConfig(runner, config, command);
  }

  private forwardRunCommand(command: CancelCommand): void {
    const runner = this.runners.get(command.runId);
    if (!runner) {
      this.commandReceipts.received(command.runId, command);
      this.commandReceipts.failed(command.runId, command, "no active run matched");
      workerLog("command did not match an active runner", {
        runId: command.runId,
        commandId: command.commandId,
        commandType: command.type,
      }, "warn");
      return;
    }
    this.sendCommandToRunner(runner, command);
  }

  private forwardInterrupt(command: InterruptCommand): void {
    const runId = command.runId;
    if (!runId) {
      workerLog("interrupt command missing runId", {
        commandId: command.commandId,
      }, "warn");
      return;
    }

    const runner = this.runners.get(runId);
    if (!runner) {
      this.commandReceipts.received(runId, command);
      this.commandReceipts.failed(runId, command, "no active run matched");
      workerLog("interrupt command did not match an active runner", {
        runId,
        commandId: command.commandId,
      }, "warn");
      return;
    }
    this.sendCommandToRunner(runner, command);
  }

  private forwardApprovalResolved(command: ApprovalResolvedCommand): void {
    const runId = this.conversationIdToRun.get(command.conversationId);
    if (!runId) {
      workerLog("approval_resolved command had no runner mapping", {
        conversationId: command.conversationId,
        commandId: command.commandId,
      }, "warn");
      return;
    }

    const runner = this.runners.get(runId);
    if (!runner) {
      this.commandReceipts.received(runId, command);
      this.commandReceipts.failed(runId, command, "no active run matched");
      return;
    }
    this.sendCommandToRunner(runner, command);
  }

  private startRunner(config: RunConfig): RunnerProcess {
    const modulePath = process.argv[1];
    if (!modulePath) {
      throw new Error("Cannot start runner: current worker entry path is unknown");
    }

    const child = fork(modulePath, process.argv.slice(2), {
      env: {
        ...process.env,
        AGEWORK_WORKER_KEEP_ALIVE: "false",
        AGEWORK_WORKER_CHANNEL: "ipc",
        AGEWORK_WORKER_RUN_ID: config.runId,
        ...(config.workerLogFilePath
          ? { AGEWORK_WORKER_LOG_FILE: config.workerLogFilePath }
          : {}),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      execArgv: process.execArgv,
    });

    const runner: RunnerProcess = {
      child,
      runId: config.runId,
      conversationId: config.conversationId,
      terminalSeen: false,
      cleaned: false,
    };

    child.on("message", (msg: unknown) => {
      this.handleRunnerMessage(runner, msg);
    });
    child.on("exit", (code, signal) => {
      this.handleRunnerExit(runner, code, signal);
    });
    child.stdout?.on("data", (data: Buffer) => {
      workerLog("runner stdout", {
        runId: runner.runId,
        pid: child.pid,
        output: data.toString().trimEnd(),
      }, "debug");
    });
    child.stderr?.on("data", (data: Buffer) => {
      workerLog("runner stderr", {
        runId: runner.runId,
        pid: child.pid,
        output: data.toString().trimEnd(),
      }, "debug");
    });

    return runner;
  }

  private sendRunConfig(
    runner: RunnerProcess,
    config: RunConfig,
    command: UserMessageCommand
  ): void {
    const message: RunChannelMessage<RunConfig> = {
      runId: runner.runId,
      seq: 0,
      type: "run.config",
      payload: config,
      ts: new Date().toISOString(),
    };
    runner.child.send(runConfigMessageToRpcNotification(message), (err) => {
      if (!err) {
        this.commandReceipts.handled(command.runId, command);
        return;
      }
      workerLog("send run config to runner failed", {
        runId: runner.runId,
        pid: runner.child.pid,
        ...errorDetails(err),
      }, "error");
      this.commandReceipts.failed(
        command.runId,
        command,
        `Failed to send run config to runner: ${err.message}`
      );
      void this.emitRunStatusSafely(runner.runId, {
        status: "error",
        error: `Failed to send run config to runner: ${err.message}`,
      }).finally(() => {
        this.terminateRunner(runner, "send run config failed");
        this.cleanupRunner(runner.runId);
      });
    });
  }

  private sendCommandToRunner(
    runner: RunnerProcess,
    command: CommandPayload
  ): void {
    const message = nextCommandMessage(
      this.commandSeqs,
      runner.runId,
      runner.runId,
      command
    );
    runner.child.send(commandMessageToRpcRequest(message), (err) => {
      if (!err) return;
      this.commandReceipts.received(runner.runId, command);
      this.commandReceipts.failed(runner.runId, command, String(err));
      workerLog("send command to runner failed", {
        runId: runner.runId,
        commandId: command.commandId,
        commandType: command.type,
        pid: runner.child.pid,
        ...errorDetails(err),
      }, "error");
    });
  }

  private handleRunnerMessage(runner: RunnerProcess, msg: unknown): void {
    const upstream = upstreamMessageFromRunner(msg, runner.runId);
    if (!upstream) {
      workerLog("runner ipc message ignored", {
        runId: runner.runId,
        pid: runner.child.pid,
        reason: "invalid_message",
      }, "warn");
      return;
    }

    if (isTerminalStatus(upstream)) {
      runner.terminalSeen = true;
      void this.client
        .emit(runner.runId, upstream)
        .catch((err) => {
          workerLog("forward runner terminal status failed", {
            runId: runner.runId,
            ...errorDetails(err),
          }, "error");
        })
        .finally(() => {
          this.cleanupRunner(runner.runId);
        });
      return;
    }

    void this.client.emit(runner.runId, upstream).catch((err) => {
      workerLog("forward runner event failed", {
        runId: runner.runId,
        type: upstream.type,
        ...errorDetails(err),
      }, "error");
    });
  }

  private handleRunnerExit(
    runner: RunnerProcess,
    code: number | null,
    signal: NodeJS.Signals | null
  ): void {
    workerLog(
      "runner process exited",
      {
        runId: runner.runId,
        pid: runner.child.pid,
        code,
        signal,
      },
      code === 0 && runner.terminalSeen ? "debug" : "warn"
    );

    if (runner.terminalSeen || runner.cleaned) return;

    void this.emitRunStatusSafely(runner.runId, {
      status: "error",
      error: `runner exited before terminal status${code !== null ? ` with code ${code}` : ""}${signal ? ` by ${signal}` : ""}`,
    }).finally(() => {
      this.cleanupRunner(runner.runId);
    });
  }

  private terminateRunner(runner: RunnerProcess, reason: string): void {
    workerLog("terminating runner process", {
      runId: runner.runId,
      pid: runner.child.pid,
      reason,
    }, "warn");
    try {
      if (!runner.child.killed) {
        runner.child.kill("SIGTERM");
      }
    } catch (err) {
      workerLog("terminate runner process failed", {
        runId: runner.runId,
        pid: runner.child.pid,
        ...errorDetails(err),
      }, "warn");
    }
  }

  private cleanupRunner(runId: string): void {
    const runner = this.runners.get(runId);
    if (!runner || runner.cleaned) return;

    runner.cleaned = true;
    this.runners.delete(runId);
    this.conversationIdToRun.delete(runner.conversationId);
    this.commandSeqs.delete(runId);
    unregisterWorkerRunLog(runId);
    this.client.cleanup(runId);
  }

  private emitRunStatus(
    runId: string,
    payload: RunStatusPayload
  ): Promise<void> {
    return this.client.emit(runId, {
      runId,
      seq: 0,
      type: "run.status",
      payload,
      ts: "",
    } satisfies RunChannelMessage<RunStatusPayload>);
  }

  private async emitRunStatusSafely(
    runId: string,
    payload: RunStatusPayload
  ): Promise<void> {
    try {
      await this.emitRunStatus(runId, payload);
    } catch (err) {
      workerLog("emit run status failed", {
        runId,
        status: payload.status,
        ...errorDetails(err),
      }, "error");
    }
  }
}

function nextCommandMessage(
  commandSeqs: Map<string, number>,
  seqOwnerId: string,
  runId: string,
  payload: CommandPayload
): RunChannelMessage<CommandPayload> {
  const seq = (commandSeqs.get(seqOwnerId) ?? 0) + 1;
  commandSeqs.set(seqOwnerId, seq);
  return {
    runId,
    seq,
    type: "command",
    payload,
    ts: new Date().toISOString(),
  };
}

function upstreamMessageFromRunner(
  msg: unknown,
  runId: string
): UpstreamMessage | undefined {
  if (isWorkerEventRpcNotification(msg)) {
    return rpcNotificationToUpstreamMessage(msg);
  }
  if (isWorkerCommandResultRpcResponse(msg)) {
    return rpcResponseToCommandResultMessage(
      msg as RpcResponse<WorkerCommandResult>,
      { runId }
    );
  }
  return undefined;
}

function isTerminalStatus(msg: UpstreamMessage): boolean {
  if (msg.type !== "run.status") return false;
  const status = (msg.payload as RunStatusPayload).status;
  return status === "finished" || status === "error" || status === "cancelled";
}
