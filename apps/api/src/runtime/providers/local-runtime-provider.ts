import { Injectable, Logger } from "@nestjs/common";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  RuntimeProvider,
  RuntimeHandle,
  RunConfig,
  RuntimePlacement,
  ControlPayload,
  Envelope,
} from "@agework/shared/protocol";
import { RunEnvelopeProcessor } from "../../runs/execution/run-envelope.processor";
import { RunEventRecorder } from "../../runs/events/run-event-recorder";
import { RunEventFacts } from "../../runs/events/run-event-facts";
import {
  HeartbeatWatchdog,
  nextControlEnvelope,
  publishWorkerErrorStatus,
} from "./runtime-provider-utils";
import { errorLogFields, safeLogJson } from "../../common/logging";

/** Internal state for a local worker process (not part of the protocol handle). */
type LocalRunState = {
  handle: RuntimeHandle;
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

@Injectable()
export class LocalRuntimeProvider implements RuntimeProvider {
  readonly type = "local" as const;
  private readonly logger = new Logger(LocalRuntimeProvider.name);
  private readonly states = new Map<string, LocalRunState>();
  private readonly heartbeats = new HeartbeatWatchdog();
  private readonly controlSeqs = new Map<string, number>();

  constructor(
    private readonly runEventProcessor: RunEnvelopeProcessor,
    private readonly runEventRecorder: RunEventRecorder
  ) {}

  start(runConfig: RunConfig, _placement: RuntimePlacement): RuntimeHandle {
    const startToken = randomUUID();
    const { runId } = runConfig;

    const child = fork(TSX_CLI, [WORKER_MAIN], {
      env: {
        ...process.env,
        AGEWORK_INTERNAL_TRANSPORT: "ipc",
        AGEWORK_INTERNAL_RUN_ID: runId,
        AGEWORK_INTERNAL_RUN_START_TOKEN: startToken,
        ...(runConfig.workerLogFilePath
          ? { AGEWORK_INTERNAL_WORKER_LOG_FILE: runConfig.workerLogFilePath }
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

    const handle: RuntimeHandle = {
      runId,
      runtimeType: "local",
      runtimeResourceId: `${child.pid}:${startToken}`,
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
      this.runEventProcessor.publish(envelope).catch((err) => {
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
          this.runEventProcessor,
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
      publishWorkerErrorStatus(this.runEventProcessor, runId, "worker heartbeat timeout");
    });

    return handle;
  }

  sendControl(handle: RuntimeHandle, control: ControlPayload): void {
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
    this.runEventRecorder
      .append(
        RunEventFacts.controlSent({
          runId: handle.runId,
          commandId: control.commandId,
          controlType: control.type,
        })
      )
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

  cancel(handle: RuntimeHandle): void {
    this.sendControl(handle, { type: "cancel", commandId: randomUUID(), runId: handle.runId, conversationId: handle.conversationId });
  }

  getHandle(runId: string): RuntimeHandle | undefined {
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

  /** runtimeResourceId 格式为 `pid:startToken`；向 pid 发送 SIGTERM，进程已退出（ESRCH）时忽略。 */
  async recoverOrphan(runtimeResourceId: string): Promise<void> {
    const [pidStr] = runtimeResourceId.split(":");
    const pid = Number(pidStr);
    if (!Number.isInteger(pid)) return;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // ESRCH: process already gone
    }
  }
}
