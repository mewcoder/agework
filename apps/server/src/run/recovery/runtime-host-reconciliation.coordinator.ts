import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import {
  RUNTIME_HOST_CONNECTED_EVENT,
  type RuntimeHostConnectedEvent,
} from "../../runtime-host/runtime-host.events";
import {
  RUNTIME_HOST_RESOURCE_RECONCILIATION,
  type RuntimeHostResourceReconciliationPort,
} from "../../runtime-host/runtime-host.types";
import { RuntimeHostService } from "../../runtime-host/runtime-host.service";
import { WorkspaceService } from "../../workspace/workspace.service";
import { UserService } from "../../user/user.service";
import { RunService } from "../run.service";

const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 30_000;

/**
 * registered Host 重连的同步用例 owner。每次 attempt 依次完成 run、一次 claims
 * 读取、workspace、user 对账，全部成功后才以 epoch CAS 放行 submitRun。
 */
@Injectable()
export class RuntimeHostReconciliationCoordinator
  implements OnApplicationShutdown
{
  private readonly logger = new Logger(
    RuntimeHostReconciliationCoordinator.name
  );
  private readonly retryTimers = new Map<
    string,
    { epoch: number; timer: NodeJS.Timeout }
  >();

  constructor(
    private readonly runs: RunService,
    private readonly workspaces: WorkspaceService,
    private readonly users: UserService,
    private readonly runtimeHosts: RuntimeHostService,
    @Inject(RUNTIME_HOST_RESOURCE_RECONCILIATION)
    private readonly hostResources: RuntimeHostResourceReconciliationPort
  ) {}

  onApplicationShutdown(): void {
    for (const { timer } of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
  }

  @OnEvent(RUNTIME_HOST_CONNECTED_EVENT)
  async onRuntimeHostConnected({
    runtimeHostId,
    epoch,
  }: RuntimeHostConnectedEvent): Promise<void> {
    this.clearRetry(runtimeHostId);
    await this.runAttempt(runtimeHostId, epoch, 0);
  }

  private async runAttempt(
    runtimeHostId: string,
    epoch: number,
    attempt: number
  ): Promise<void> {
    if (!this.isCurrent(runtimeHostId, epoch)) return;

    try {
      await this.runs.reconcileRuntimeHostRuns(runtimeHostId);
      if (!this.isCurrent(runtimeHostId, epoch)) return;

      const claims =
        await this.hostResources.listLifecycleClaims(runtimeHostId);
      if (!this.isCurrent(runtimeHostId, epoch)) return;

      await this.workspaces.reconcileRuntimeHostResources(
        runtimeHostId,
        claims
      );
      if (!this.isCurrent(runtimeHostId, epoch)) return;

      await this.users.reconcileRuntimeHostResources(runtimeHostId, claims);
      if (!this.isCurrent(runtimeHostId, epoch)) return;

      if (this.runtimeHosts.markReconciled(runtimeHostId, epoch)) {
        this.clearRetry(runtimeHostId);
        this.logger.log(
          `host ${runtimeHostId} (epoch ${epoch}) reconciliation completed`
        );
      }
    } catch (error) {
      if (!this.isCurrent(runtimeHostId, epoch)) return;

      this.runtimeHosts.markReconcileFailed(runtimeHostId, epoch);
      this.logger.warn(
        `host ${runtimeHostId} (epoch ${epoch}) reconciliation attempt ${attempt + 1} failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      this.scheduleRetry(runtimeHostId, epoch, attempt + 1);
    }
  }

  private scheduleRetry(
    runtimeHostId: string,
    epoch: number,
    attempt: number
  ): void {
    this.clearRetry(runtimeHostId);
    const delay = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
    const timer = setTimeout(() => {
      const pending = this.retryTimers.get(runtimeHostId);
      if (pending?.epoch !== epoch || pending.timer !== timer) return;
      this.retryTimers.delete(runtimeHostId);
      if (!this.isCurrent(runtimeHostId, epoch)) return;
      void this.runAttempt(runtimeHostId, epoch, attempt);
    }, delay);
    timer.unref();
    this.retryTimers.set(runtimeHostId, { epoch, timer });
  }

  private clearRetry(runtimeHostId: string): void {
    const pending = this.retryTimers.get(runtimeHostId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.retryTimers.delete(runtimeHostId);
  }

  private isCurrent(runtimeHostId: string, epoch: number): boolean {
    return this.runtimeHosts.isCurrentReconciliationEpoch(runtimeHostId, epoch);
  }
}
