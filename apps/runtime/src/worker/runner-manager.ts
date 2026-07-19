import { fork, type ChildProcess } from "node:child_process";
import { dirname, extname, join } from "node:path";
import {
  nextCommandMessage,
  type CommandPayload,
  type RunChannelMessage,
  type RunConfig,
  type RunStatusPayload,
  type UpstreamMessage,
  type WorkerCommandResult,
  type RpcResponse,
  type UpstreamMessageInput,
} from "@agework/shared/protocol";
import { isTerminalRunStatus } from "@agework/shared";
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
} from "./logging/worker-log.js";

/** SIGTERM 到 SIGKILL 的宽限期。 */
const RUNNER_SIGKILL_GRACE_MS = 5_000;
/** cancel 已送达 runner 后允许 adapter 自行收敛的最长时间。 */
const RUNNER_CANCEL_GRACE_MS = 8_000;

type UserMessageCommand = Extract<CommandPayload, { type: "user_message" }>;
type CancelCommand = Extract<CommandPayload, { type: "cancel" }>;
type InterruptCommand = Extract<CommandPayload, { type: "interrupt" }>;
type ApprovalResolvedCommand = Extract<
  CommandPayload,
  { type: "approval_resolved" }
>;

export type RunnerManagerClient = {
  fetchRunConfig(runId: string): Promise<RunConfig>;
  emit(runId: string, msg: UpstreamMessageInput): Promise<void>;
  cleanup(runId: string): void;
};

type RunnerProcess = {
  child: ChildProcess;
  runId: string;
  terminalSeen: boolean;
  cleaned: boolean;
  cancellationRequested: boolean;
  cancellationTimer?: NodeJS.Timeout;
};

export class RunnerManager {
  private readonly runners = new Map<string, RunnerProcess>();
  private readonly commandSeqs = new Map<string, number>();
  /** 每个 runId 的命令处理链尾,用于按 runId 串行、跨 runId 并行地派发命令。 */
  private readonly runQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly client: RunnerManagerClient,
    private readonly commandReceipts: CommandReceipts
  ) {}

  /**
   * 按 runId 串行、跨 runId 并行地派发命令。同一个 run 的命令保持 FIFO(cancel 排在它
   * 自己的 user_message 之后,等 runner 起来再执行,不会被丢);不同 run 之间互不阻塞——
   * 某个 run 慢的 fetchRunConfig 不再拖住别的 run 的 cancel/interrupt。
   *
   * 返回的 promise 在该命令处理完成后 resolve(便于直接单测 `await handle(...)`);命令泵
   * (WorkerCommands)不 await 它,从而获得跨 run 并发。handle 自身永不 reject。
   */
  handle(command: CommandPayload): Promise<void> {
    const previous = this.runQueues.get(command.runId) ?? Promise.resolve();
    const settled = previous
      .then(() => this.dispatch(command))
      .catch((err) => {
        workerLog(
          "command dispatch failed",
          {
            runId: command.runId,
            commandId: command.commandId,
            commandType: command.type,
            ...errorDetails(err),
          },
          "error"
        );
      });
    this.runQueues.set(command.runId, settled);
    void settled.finally(() => {
      if (this.runQueues.get(command.runId) === settled) {
        this.runQueues.delete(command.runId);
      }
    });
    return settled;
  }

  private async dispatch(command: CommandPayload): Promise<void> {
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
    workerLog(
      "worker received shutdown signal",
      {
        signal,
        activeRuns: active.map((runner) => ({ runId: runner.runId })),
      },
      active.length > 0 ? "warn" : "info"
    );

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
      workerLog(
        "failed to fetch run config",
        {
          runId: command.runId,
          ...errorDetails(err),
        },
        "error"
      );
      this.commandReceipts.failed(command.runId, command, String(err));
      await this.emitRunStatusSafely(command.runId, {
        status: "error",
        error: `Failed to fetch run config: ${String(err)}`,
      });
      return;
    }

    if (this.runners.has(command.runId)) {
      this.commandReceipts.failed(command.runId, command, "run already active");
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
      workerLog(
        "failed to start runner process",
        {
          runId: command.runId,
          commandId: command.commandId,
          ...errorDetails(err),
        },
        "error"
      );
      this.commandReceipts.failed(command.runId, command, String(err));
      await this.emitRunStatusSafely(command.runId, {
        status: "error",
        error: `Failed to start runner process: ${String(err)}`,
      });
      this.client.cleanup(command.runId);
      return;
    }

    this.runners.set(command.runId, runner);

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
      this.commandReceipts.failed(
        command.runId,
        command,
        "no active run matched"
      );
      workerLog(
        "command did not match an active runner",
        {
          runId: command.runId,
          commandId: command.commandId,
          commandType: command.type,
        },
        "warn"
      );
      return;
    }
    runner.cancellationRequested = true;
    this.sendCommandToRunner(runner, command);
    this.scheduleCancellationDeadline(runner);
  }

  private forwardInterrupt(command: InterruptCommand): void {
    const runId = command.runId;
    const runner = this.runners.get(runId);
    if (!runner) {
      this.commandReceipts.received(runId, command);
      this.commandReceipts.failed(runId, command, "no active run matched");
      workerLog(
        "interrupt command did not match an active runner",
        {
          runId,
          commandId: command.commandId,
        },
        "warn"
      );
      return;
    }
    this.sendCommandToRunner(runner, command);
  }

  private forwardApprovalResolved(command: ApprovalResolvedCommand): void {
    const { runId } = command;
    const runner = this.runners.get(runId);
    if (!runner) {
      this.commandReceipts.received(runId, command);
      this.commandReceipts.failed(runId, command, "no active run matched");
      return;
    }
    this.sendCommandToRunner(runner, command);
  }

  private startRunner(config: RunConfig): RunnerProcess {
    const workerEntryPath = process.argv[1];
    if (!workerEntryPath) {
      throw new Error(
        "Cannot start runner: current worker entry path is unknown"
      );
    }

    const child = fork(resolveRunnerEntryPath(workerEntryPath), [], {
      env: buildRunnerEnv(config),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      execArgv: process.execArgv,
    });

    const runner: RunnerProcess = {
      child,
      runId: config.runId,
      terminalSeen: false,
      cleaned: false,
      cancellationRequested: false,
    };

    child.on("message", (msg: unknown) => {
      this.handleRunnerMessage(runner, msg);
    });
    child.on("exit", (code, signal) => {
      this.handleRunnerExit(runner, code, signal);
    });
    child.stdout?.on("data", (data: Buffer) => {
      workerLog(
        "runner stdout",
        {
          runId: runner.runId,
          pid: child.pid,
          output: data.toString().trimEnd(),
        },
        "debug"
      );
    });
    child.stderr?.on("data", (data: Buffer) => {
      workerLog(
        "runner stderr",
        {
          runId: runner.runId,
          pid: child.pid,
          output: data.toString().trimEnd(),
        },
        "debug"
      );
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
      workerLog(
        "send run config to runner failed",
        {
          runId: runner.runId,
          pid: runner.child.pid,
          ...errorDetails(err),
        },
        "error"
      );
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
      workerLog(
        "send command to runner failed",
        {
          runId: runner.runId,
          commandId: command.commandId,
          commandType: command.type,
          pid: runner.child.pid,
          ...errorDetails(err),
        },
        "error"
      );
    });
  }

  private handleRunnerMessage(runner: RunnerProcess, msg: unknown): void {
    const upstream = upstreamMessageFromRunner(msg, runner.runId);
    if (!upstream) {
      workerLog(
        "runner ipc message ignored",
        {
          runId: runner.runId,
          pid: runner.child.pid,
          reason: "invalid_message",
        },
        "warn"
      );
      return;
    }

    if (isTerminalStatus(upstream)) {
      runner.terminalSeen = true;
      void this.client
        .emit(runner.runId, upstream)
        .catch((err) => {
          workerLog(
            "forward runner terminal status failed",
            {
              runId: runner.runId,
              ...errorDetails(err),
            },
            "error"
          );
        })
        .finally(() => {
          this.cleanupRunner(runner.runId);
        });
      return;
    }

    void this.client.emit(runner.runId, upstream).catch((err) => {
      workerLog(
        "forward runner event failed",
        {
          runId: runner.runId,
          type: upstream.type,
          ...errorDetails(err),
        },
        "error"
      );
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

    const exitError = `runner exited before terminal status${code !== null ? ` with code ${code}` : ""}${signal ? ` by ${signal}` : ""}`;
    void this.emitRunStatusSafely(
      runner.runId,
      runner.cancellationRequested
        ? { status: "cancelled" }
        : { status: "error", error: exitError }
    ).finally(() => {
      this.cleanupRunner(runner.runId);
    });
  }

  private terminateRunner(runner: RunnerProcess, reason: string): void {
    workerLog(
      "terminating runner process",
      {
        runId: runner.runId,
        pid: runner.child.pid,
        reason,
      },
      "warn"
    );
    try {
      if (!runner.child.killed) {
        runner.child.kill("SIGTERM");
        this.scheduleForceKill(runner);
      }
    } catch (err) {
      workerLog(
        "terminate runner process failed",
        {
          runId: runner.runId,
          pid: runner.child.pid,
          ...errorDetails(err),
        },
        "warn"
      );
    }
  }

  private scheduleCancellationDeadline(runner: RunnerProcess): void {
    if (runner.cancellationTimer) clearTimeout(runner.cancellationTimer);
    runner.cancellationTimer = setTimeout(() => {
      runner.cancellationTimer = undefined;
      if (runner.cleaned || runner.terminalSeen) return;
      this.terminateRunner(runner, "cancel grace period exceeded");
    }, RUNNER_CANCEL_GRACE_MS);
    runner.cancellationTimer.unref();
  }

  /** SIGTERM 宽限期后仍存活则 SIGKILL,避免忽略 SIGTERM 的 runner 变僵尸残留。 */
  private scheduleForceKill(runner: RunnerProcess): void {
    const timer = setTimeout(() => {
      if (runner.child.exitCode !== null || runner.child.signalCode !== null) {
        return; // 已退出,无需强杀
      }
      workerLog(
        "runner did not exit after SIGTERM, sending SIGKILL",
        {
          runId: runner.runId,
          pid: runner.child.pid,
        },
        "warn"
      );
      try {
        runner.child.kill("SIGKILL");
      } catch (err) {
        workerLog(
          "force kill runner failed",
          {
            runId: runner.runId,
            pid: runner.child.pid,
            ...errorDetails(err),
          },
          "warn"
        );
      }
    }, RUNNER_SIGKILL_GRACE_MS);
    // 强杀兜底不该拖住进程正常退出
    timer.unref();
  }

  private cleanupRunner(runId: string): void {
    const runner = this.runners.get(runId);
    if (!runner || runner.cleaned) return;

    runner.cleaned = true;
    if (runner.cancellationTimer) clearTimeout(runner.cancellationTimer);
    this.runners.delete(runId);
    this.commandSeqs.delete(runId);
    unregisterWorkerRunLog(runId);
    this.client.cleanup(runId);
  }

  private emitRunStatus(
    runId: string,
    payload: RunStatusPayload
  ): Promise<void> {
    return this.client.emit(runId, { type: "run.status", payload });
  }

  private async emitRunStatusSafely(
    runId: string,
    payload: RunStatusPayload
  ): Promise<void> {
    try {
      await this.emitRunStatus(runId, payload);
    } catch (err) {
      workerLog(
        "emit run status failed",
        {
          runId,
          status: payload.status,
          ...errorDetails(err),
        },
        "error"
      );
    }
  }
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
  return isTerminalRunStatus((msg.payload as RunStatusPayload).status);
}

/** runner 是 worker 入口的兄弟产物(dist/main.js → dist/runner.js),不是同一个文件。 */
function resolveRunnerEntryPath(workerEntryPath: string): string {
  return join(dirname(workerEntryPath), `runner${extname(workerEntryPath)}`);
}

// runner 全程只经 IPC 跟 worker 通信、从不直连 server,不需要 worker 自己的
// AGEWORK_WORKER_API_BASE / AGEWORK_WORKER_START_TOKEN 等认证信息,也不该继承
// server/worker 进程的其余环境变量——见 apps/runtime/docs/adr/0002。
const RUNNER_ENV_PASSTHROUGH_KEYS = [
  "PATH",
  "HOME",
  "NODE_ENV",
  "AGEWORK_WORKER_LOG_LEVEL",
  "AGEWORK_WORKER_LOG_MAX_FILE_MB",
  "AGEWORK_WORKER_RUNTIME_TYPE",
  "AGEWORK_WORKER_SCOPE",
  "AGEWORK_WORKER_SUBJECT_ID",
  "AGEWORK_WORKER_USER_ID",
  "AGEWORK_AGENT_PLUGINS",
  // Codex backend selection (【决策8】 SDK fallback): the runner process
  // needs to know which backend to use — without this it always defaults
  // to "app-server", breaking the SDK fallback path.
  "AGEWORK_CODEX_BACKEND",
  // App-server tuning (§12 of migration doc):
  "AGEWORK_CODEX_APP_SERVER_REQUEST_TIMEOUT_MS",
  "AGEWORK_CODEX_APP_SERVER_SHUTDOWN_TIMEOUT_MS",
] as const;

function buildRunnerEnv(config: RunConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of RUNNER_ENV_PASSTHROUGH_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  // Agent CLI override uses a generic key so external plugins do not require
  // another Worker allowlist edit.
  const agentCliEnvKey = `AGEWORK_${config.agentProviderConfig.agentType
    .replace(/[^a-zA-Z0-9]/g, "_")
    .toUpperCase()}_CLI_PATH`;
  const agentCliPath = process.env[agentCliEnvKey];
  if (agentCliPath !== undefined) env[agentCliEnvKey] = agentCliPath;
  env.AGEWORK_WORKER_ROLE = "runner";
  env.AGEWORK_WORKER_RUN_ID = config.runId;
  if (config.workerLogFilePath) {
    env.AGEWORK_WORKER_LOG_FILE = config.workerLogFilePath;
  }
  return env;
}
