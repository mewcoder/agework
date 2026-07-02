import { Injectable, Logger } from "@nestjs/common";
import type { ChildProcess } from "node:child_process";
import { generateId } from "@agework/shared";
import type {
  AcquireInstanceResult,
  CommandPayload,
  RunChannelMessage,
  RunConfig,
  WorkerExecutionStartInput,
} from "@agework/shared/protocol";
import {
  commandMessageToRpcRequest,
  isWorkerCommandResultRpcResponse,
  isWorkerEventRpcNotification,
  rpcNotificationToUpstreamMessage,
  rpcResponseToCommandResultMessage,
  runConfigMessageToRpcNotification,
} from "@agework/shared/protocol/rpc";
import { RuntimeService } from "../../runtime/runtime.service";
import { WorkerRegistryRepository } from "../registry/worker-registry.repository";
import { WorkerUpstreamRegistry } from "../upstream/worker-upstream.registry";
import { swallow } from "../../common/swallow";
import { safeLogJson } from "../../common/logging";

type LocalOwnerState = {
  runtimeInstanceId: string;
  channel: ChildProcess;
  commandSeq: number;
};

/**
 * local 实例编排:owner 长期复用一个 keep-alive 进程,`worker-host` 直接持有并接管
 * IPC channel 收发——跟 sandbox 走同一套 WorkerRegistry 记录路径,但物理载体是
 * fork 出的进程而不是容器。本轮不做 idle 回收(见计划文档 Architecture 一节),
 * 只在进程 exit 或显式 owner 删除时释放。
 *
 * 只注入 RuntimeService(下层)、WorkerRegistryRepository/WorkerUpstreamRegistry
 * (同模块兄弟 provider),不注入 WorkerHostService 本身——避免重蹈 Phase 2 Task 7
 * 那次循环依赖的覆辙。
 */
@Injectable()
export class LocalInstanceExecutor {
  private readonly logger = new Logger(LocalInstanceExecutor.name);
  private readonly ownerStates = new Map<string, LocalOwnerState>();

  constructor(
    private readonly runtimeService: RuntimeService,
    private readonly registry: WorkerRegistryRepository,
    private readonly upstream: WorkerUpstreamRegistry
  ) {}

  getChannel(ownerId: string): ChildProcess | undefined {
    return this.ownerStates.get(ownerId)?.channel;
  }

  async acquireInstanceForRun(
    input: WorkerExecutionStartInput
  ): Promise<AcquireInstanceResult> {
    const ownerId = input.runtimeTarget.ownerId;
    const workspaceId = input.runConfig.workspaceId;
    const existing = this.ownerStates.get(ownerId);
    if (existing) {
      return {
        outcome: "ready",
        runtimeInstanceId: existing.runtimeInstanceId,
      };
    }

    const insertResult = await this.registry.insertStarting(
      {
        runtimeType: "local",
        isolationScope: "workspace",
        workspaceId,
        ownerId,
      },
      generateId(),
      "ipc"
    );
    if (!insertResult.ok) {
      // local 走 IPC,父子进程关系一旦断了就没有重连这回事(设计文档 2.4 节)。
      // 已有行不管是 starting 还是 running,都不能安全复用,统一报错。
      return {
        outcome: "error",
        error: `owner ${ownerId} already has an active local instance record (status=${insertResult.existing.status}); this process cannot reattach to it`,
      };
    }

    let launched: {
      runtimeInstanceId: string;
      channel: LocalOwnerState["channel"];
    };
    try {
      launched = this.runtimeService.launchLocal({
        runId: input.runConfig.runId,
        env: {
          AGEWORK_WORKER_KEEP_ALIVE: "true",
          AGEWORK_WORKER_CHANNEL: "ipc",
          ...(input.runConfig.workerLogFilePath
            ? { AGEWORK_WORKER_LOG_FILE: input.runConfig.workerLogFilePath }
            : {}),
        },
      });
    } catch (err) {
      await this.registry
        .markErrorByOwner(
          "local",
          "workspace",
          ownerId,
          err instanceof Error ? err.message : String(err)
        )
        .catch(swallow(this.logger, `mark launch error for owner ${ownerId}`));
      return {
        outcome: "error",
        error: `launch local worker failed: ${String(err)}`,
      };
    }

    const { runtimeInstanceId, channel } = launched;
    const state: LocalOwnerState = {
      runtimeInstanceId,
      channel,
      commandSeq: 0,
    };
    this.ownerStates.set(ownerId, state);
    this.attachChannelListeners(ownerId, channel);

    await this.registry
      .upsertRunning(
        {
          runtimeType: "local",
          isolationScope: "workspace",
          workspaceId,
          ownerId,
        },
        runtimeInstanceId,
        "ipc"
      )
      .catch(swallow(this.logger, `record local runtime for owner ${ownerId}`));

    this.logger.log(
      `local worker keep-alive started ${safeLogJson({ ownerId, pid: channel.pid })}`
    );
    return { outcome: "ready", runtimeInstanceId };
  }

  /** local 本轮不做 idle 回收,保留方法只为跟 sandbox 侧的调用形状对齐。 */
  releaseInstanceForRun(_runId: string): void {
    // no-op
  }

  openSession(ownerId: string, runConfig: RunConfig): void {
    const state = this.ownerStates.get(ownerId);
    if (!state) return;
    state.channel.send(
      runConfigMessageToRpcNotification({
        runId: runConfig.runId,
        seq: 0,
        type: "run.config",
        payload: runConfig,
        ts: new Date().toISOString(),
      })
    );
  }

  sendCommand(ownerId: string, command: CommandPayload): void {
    const state = this.ownerStates.get(ownerId);
    if (!state) {
      this.logger.warn(
        `local send command dropped ${safeLogJson({ ownerId, commandType: command.type, reason: "no_active_state" })}`
      );
      return;
    }
    state.commandSeq += 1;
    const message: RunChannelMessage<CommandPayload> = {
      runId: (command as Record<string, string>).runId ?? "",
      seq: state.commandSeq,
      type: command.type,
      payload: command,
      ts: new Date().toISOString(),
    };
    state.channel.send(commandMessageToRpcRequest(message));
  }

  shutdownRuntimeInstanceByOwnerId(ownerId: string): void {
    const state = this.ownerStates.get(ownerId);
    if (!state) return;
    try {
      if (!state.channel.killed) {
        state.channel.kill("SIGTERM");
      }
    } catch (err) {
      this.logger.warn(
        `terminate local keep-alive worker failed ${safeLogJson({ ownerId, ...swallowFields(err) })}`
      );
    }
    this.registry
      .markStoppedByOwner("local", "workspace", ownerId)
      .catch(
        swallow(this.logger, `mark local runtime stopped for owner ${ownerId}`)
      );
    this.ownerStates.delete(ownerId);
  }

  recoverOrphan(runtimeInstanceId: string): Promise<void> {
    return this.runtimeService.recoverOrphanLocal(runtimeInstanceId);
  }

  private attachChannelListeners(ownerId: string, channel: ChildProcess): void {
    channel.on("message", (msg: unknown) => {
      const message = normalizeIpcMessage(msg);
      if (!message) return;
      this.upstream.sendEvent(message.runId, message).catch((err) => {
        this.logger.warn(
          `local worker message forward failed ${safeLogJson({ ownerId, ...swallowFields(err) })}`
        );
      });
    });

    channel.on("exit", (code) => {
      this.logger.warn(
        `local keep-alive worker exited ${safeLogJson({ ownerId, code })}`
      );
      this.registry
        .markStoppedByOwner("local", "workspace", ownerId)
        .catch(
          swallow(
            this.logger,
            `mark local runtime stopped for owner ${ownerId}`
          )
        );
      this.ownerStates.delete(ownerId);
    });
  }
}

function normalizeIpcMessage(msg: unknown) {
  if (isWorkerEventRpcNotification(msg)) {
    return rpcNotificationToUpstreamMessage(msg);
  }
  if (isWorkerCommandResultRpcResponse(msg)) {
    return rpcResponseToCommandResultMessage(msg, { runId: "" });
  }
  return undefined;
}

function swallowFields(err: unknown): { error: string } {
  return { error: err instanceof Error ? err.message : String(err) };
}
