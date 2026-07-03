import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type {
  AcquireInstanceResult,
  WorkerExecutionStartInput,
} from "@agework/shared/protocol";
import type {
  RuntimeInstanceRef,
  RuntimeLaunchContext,
} from "../../runtime/runtime.types";
import { RuntimeService } from "../../runtime/runtime.service";
import { WorkerRegistryRepository } from "../registry/worker-registry.repository";
import { WorkerHandshakeStore } from "../handshake/worker-handshake.store";
import { WorkerCommandDispatcher } from "../command/command-dispatcher.service";
import { ConfigService } from "../../config/config.service";
import { withTimeout } from "../../common/with-timeout";
import { swallow } from "../../common/swallow";
import { errorLogFields, safeLogJson } from "../../common/logging";

type OwnerInstance =
  | { status: "pending"; promise: Promise<AcquireInstanceResult> }
  | {
      status: "ready";
      runtimeInstanceId: string;
      isolationScope: string;
      runtimeType: string;
    };

/** worker 实例编排(泛型,不认识 runtimeType):两个旧 executor 复制的启动握手
 *  序列的唯一副本。无回收(引用计数/idle/settle 全砍)。 */
@Injectable()
export class WorkerProvisioner {
  private readonly logger = new Logger(WorkerProvisioner.name);
  private readonly owners = new Map<string, OwnerInstance>();

  constructor(
    private readonly runtimeService: RuntimeService,
    private readonly registry: WorkerRegistryRepository,
    private readonly handshakeStore: WorkerHandshakeStore,
    private readonly commandDispatcher: WorkerCommandDispatcher,
    private readonly configService: ConfigService
  ) {}

  acquireInstanceForRun(
    input: WorkerExecutionStartInput
  ): Promise<AcquireInstanceResult> {
    const ownerId = input.runtimeTarget.ownerId;
    const existing = this.owners.get(ownerId);
    if (existing?.status === "ready") {
      return Promise.resolve({
        outcome: "ready",
        runtimeInstanceId: existing.runtimeInstanceId,
      });
    }
    if (existing?.status === "pending") return existing.promise;

    const promise = this.launch(input);
    this.owners.set(ownerId, { status: "pending", promise });
    return promise;
  }

  private async launch(
    input: WorkerExecutionStartInput
  ): Promise<AcquireInstanceResult> {
    const { runtimeTarget, runConfig } = input;
    const ownerId = runtimeTarget.ownerId;
    const { runtimeType, isolationScope } = this.identity(input);
    const startToken = randomUUID();

    const insert = await this.registry.insertStarting(
      {
        runtimeType,
        isolationScope,
        workspaceId: runConfig.workspaceId,
        ownerId,
      },
      randomUUID(),
      "http",
      startToken
    );
    if (!insert.ok) {
      if (insert.existing.status === "running") {
        this.owners.set(ownerId, {
          status: "ready",
          runtimeInstanceId: insert.existing.runtimeInstanceId,
          isolationScope,
          runtimeType,
        });
        return {
          outcome: "ready",
          runtimeInstanceId: insert.existing.runtimeInstanceId,
        };
      }
      this.owners.delete(ownerId);
      return {
        outcome: "error",
        error: `owner ${ownerId} has a concurrent launch already starting`,
      };
    }

    const ctx: RuntimeLaunchContext = {
      runtimeType,
      ownerId,
      workspaceId: runConfig.workspaceId,
      runId: runConfig.runId,
      placement: runtimeTarget,
      workerEnv: this.buildWorkerEnv(
        input,
        startToken,
        runtimeType,
        isolationScope
      ),
    };

    try {
      const { runtimeInstanceId } = await withTimeout(
        (async () => {
          const env = await this.runtimeService.prepareEnvironment(ctx);
          const launched = await this.runtimeService.launchWorker(ctx, env);
          await this.handshakeStore.waitForRegister(ownerId, startToken);
          return launched;
        })(),
        this.configService.getLaunchTimeoutSeconds() * 1000,
        `worker launch timed out for owner ${ownerId}`
      );

      await this.registry
        .upsertRunning(
          {
            runtimeType,
            isolationScope,
            workspaceId: runConfig.workspaceId,
            ownerId,
          },
          runtimeInstanceId,
          "http"
        )
        .catch(swallow(this.logger, `upsert running for owner ${ownerId}`));

      this.owners.set(ownerId, {
        status: "ready",
        runtimeInstanceId,
        isolationScope,
        runtimeType,
      });
      return { outcome: "ready", runtimeInstanceId };
    } catch (err) {
      this.handshakeStore.cancel(
        ownerId,
        `worker launch failed for owner ${ownerId}`
      );
      await this.registry
        .markErrorByOwner(
          runtimeType,
          isolationScope,
          ownerId,
          err instanceof Error ? err.message : String(err)
        )
        .catch(swallow(this.logger, `mark launch error for owner ${ownerId}`));
      this.owners.delete(ownerId);
      this.logger.warn(
        `worker launch failed ${safeLogJson({ ownerId, runtimeType, ...errorLogFields(err) })}`
      );
      return {
        outcome: "error",
        error: `worker launch failed: ${String(err)}`,
      };
    }
  }

  /** 拆除某 owner 的实例:清内存态 + command dispatcher + registry markStopped +
   *  provider.teardown。ref 由调用方从 DB 行派生(重启后无内存态也能停)。 */
  async teardown(ref: RuntimeInstanceRef): Promise<void> {
    this.owners.delete(ref.ownerId);
    this.commandDispatcher.cleanupByOwnerId(ref.ownerId);
    await Promise.resolve(this.runtimeService.teardown(ref)).catch(
      swallow(this.logger, `provider teardown for owner ${ref.ownerId}`)
    );
    await this.registry
      .markStoppedByOwner(ref.runtimeType, ref.isolationScope, ref.ownerId)
      .catch(swallow(this.logger, `mark stopped for owner ${ref.ownerId}`));
  }

  private identity(input: WorkerExecutionStartInput): {
    runtimeType: string;
    isolationScope: string;
  } {
    const target = input.runtimeTarget;
    const isolationScope =
      target.runtimeType === "sandbox"
        ? target.sandbox.isolationScope
        : "workspace";
    return { runtimeType: target.runtimeType, isolationScope };
  }

  private buildWorkerEnv(
    input: WorkerExecutionStartInput,
    startToken: string,
    runtimeType: string,
    isolationScope: string
  ): Record<string, string> {
    const { runConfig } = input;
    const env: Record<string, string> = {
      AGEWORK_WORKER_ROLE: "worker",
      AGEWORK_WORKER_OWNER_ID: input.runtimeTarget.ownerId,
      AGEWORK_WORKER_START_TOKEN: startToken,
      AGEWORK_WORKER_RUNTIME_TYPE: runtimeType,
      AGEWORK_WORKER_ISOLATION_SCOPE: isolationScope,
    };
    if (runConfig.workerLogFilePath) {
      env.AGEWORK_WORKER_LOG_FILE = runConfig.workerLogFilePath;
    }
    return env;
  }
}
