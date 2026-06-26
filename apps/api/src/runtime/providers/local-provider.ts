import { Injectable, Logger } from "@nestjs/common";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { generateId } from "@agework/shared";
import type {
  RunConfig,
  WorkerExecutionHandle,
  WorkerExecutionStartInput,
  ControlPayload,
  Envelope,
} from "@agework/shared/protocol";
import type { RunEventReceiver } from "./run-event-receiver";
import type { RuntimeProvider } from "./provider-contracts";
import {
  HeartbeatWatchdog,
  publishWorkerErrorStatus,
} from "./provider-utils";
import { nextControlEnvelope } from "../../worker-host/control-envelope";
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
 * Local runtime provider：one run = one child process，无容器、无跨 run 复用。
 *
 * 因此 local 不写 RuntimeTarget / WorkspaceRuntime 表——没有持久容器要登记，
 * runtimeInstanceId 即 `pid:startToken`，只记在内存里，run 结束进程即销毁。
 * （sandbox 才需要这两张表记录持久容器的存活与复用关系。）
 */
@Injectable()
export class LocalRuntimeProvider implements RuntimeProvider {
  readonly type = "local" as const;
  private readonly logger = new Logger(LocalRuntimeProvider.name);
  private readonly states = new Map<string, LocalRunState>();
  private readonly heartbeats = new HeartbeatWatchdog();
  private readonly controlSeqs = new Map<string, number>();
  private receiver!: RunEventReceiver;

  setRunEventReceiver(receiver: RunEventReceiver): void {
    this.receiver = receiver;
  }

  startWorkerExecution(
    input: WorkerExecutionStartInput
  ): WorkerExecutionHandle {
    const { runConfig, runtimeTarget } = input;
    if (runtimeTarget.runtimeType !== this.type) {
      throw new Error(
        `LocalRuntimeProvider cannot start worker for runtime type: ${runtimeTarget.runtimeType}`
      );
    }
    const startToken = randomUUID();
    const { runId } = runConfig;

    const child = fork(TSX_CLI, [WORKER_MAIN], {
      env: {
        ...process.env,
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
    this.controlSeqs.set(runId, 0);

    // Send run config as first message
    const configEnvelope: Envelope<RunConfig> = {
      runId,
      seq: 0,
      type: "run.config",
      payload: runConfig,
      ts: new Date().toISOString(),
    };
    child.send(configEnvelope);

    // Forward upstream messages to RunEnvelopeProcessor
    child.on("message", (msg: unknown) => {
      const envelope = msg as Envelope<unknown>;
      if (envelope.type === "heartbeat") {
        this.heartbeats.beat(runId);
      }
      this.receiver.publish(envelope).catch((err) => {
        this.logger.warn(
          `runtime event publish failed ${safeLogJson({
            runId,
            type: envelope.type,
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
        publishWorkerErrorStatus(
          this.receiver,
          runId,
          `worker exited with code ${code}`
        );
      }
    });

    // Pipe worker stdout/stderr to logger
    child.stdout?.on("data", (data: Buffer) => {
      this.logger.debug(`[worker:${runId}] ${data.toString().trimEnd()}`);
    });
    child.stderr?.on("data", (data: Buffer) => {
      this.logger.debug(`[worker:${runId}:stderr] ${data.toString().trimEnd()}`);
    });

    // Start heartbeat check
    this.heartbeats.start(runId, () => {
      this.logger.error(
        `local worker heartbeat timeout ${safeLogJson({ runId })}`
      );
      child.kill();
      this.cleanup(runId);
      publishWorkerErrorStatus(this.receiver, runId, "worker heartbeat timeout");
    });

    return handle;
  }

  sendControl(handle: WorkerExecutionHandle, control: ControlPayload): void {
    const state = this.states.get(handle.runId);
    if (!state) {
      this.logger.warn(
        `send control dropped ${safeLogJson({
          runId: handle.runId,
          controlType: control.type,
          reason: "no_active_state",
        })}`
      );
      return;
    }

    const envelope = nextControlEnvelope(
      this.controlSeqs,
      handle.runId,
      handle.runId,
      control
    );
    this.receiver
      .recordControlSent({
        runId: handle.runId,
        commandId: control.commandId,
        controlType: control.type,
      })
      .catch((err) => {
        this.logger.warn(
          `record control sent failed ${safeLogJson({
            runId: handle.runId,
            controlType: control.type,
            ...errorLogFields(err),
          })}`
        );
      });
    state.child.send(envelope);
  }

  cancel(handle: WorkerExecutionHandle): void {
    this.sendControl(handle, { type: "cancel", commandId: generateId(), runId: handle.runId, conversationId: handle.conversationId });
  }

  getHandle(runId: string): WorkerExecutionHandle | undefined {
    return this.states.get(runId)?.handle;
  }

  heartbeat(runId: string): void {
    this.heartbeats.beat(runId);
  }

  /** Run 终态后清理（也由 RuntimeProvider 接口的统一清理路径调用，幂等）。 */
  cleanup(runId: string): void {
    this.states.delete(runId);
    this.heartbeats.stop(runId);
    this.controlSeqs.delete(runId);
  }

  /** runtimeInstanceId 格式为 `pid:startToken`；向 pid 发送 SIGTERM，进程已退出（ESRCH）时忽略。 */
  async recoverOrphan(runtimeInstanceId: string): Promise<void> {
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
