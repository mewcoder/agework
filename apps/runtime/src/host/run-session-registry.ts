import type { RunConfig, WorkerScope } from "@agework/shared/protocol";
import type { RuntimeType } from "@agework/runtime-sdk";

/** session 阶段(用于 lifecycle claims 投影)。 */
export type RunSessionPhase =
  | "reserved"
  | "configuring"
  | "acquiring"
  | "ready";

type ReservedPlacement = {
  userId: string;
  workspaceId: string;
  scope: WorkerScope;
  runtimeType: RuntimeType;
  userLifecycleVersion: number;
};

type SubmittedRunState = {
  workerId: string;
  phase: RunSessionPhase;
  cancelled: boolean;
  placement: ReservedPlacement;
};

/** Host 内一次 run 的短期会话状态，不是持久化业务数据。 */
export class RunSessionRegistry {
  private readonly states = new Map<string, SubmittedRunState>();
  private readonly submissions = new Map<string, Promise<void>>();
  private readonly configs = new Map<string, RunConfig>();

  has(runId: string): boolean {
    return this.states.has(runId);
  }

  listRunIds(): string[] {
    return [...this.states.keys()];
  }

  /** 列出所有 session 的 runId + phase + placement(用于 lifecycle claims)。 */
  listSessions(): Array<{
    runId: string;
    phase: RunSessionPhase;
    placement: ReservedPlacement;
  }> {
    return [...this.states.entries()].map(([runId, state]) => ({
      runId,
      phase: state.phase,
      placement: state.placement,
    }));
  }

  reserve(runId: string, placement: ReservedPlacement): void {
    this.states.set(runId, {
      workerId: "",
      phase: "reserved",
      cancelled: false,
      placement,
    });
  }

  /** 更新 session 阶段。 */
  setPhase(runId: string, phase: RunSessionPhase): void {
    const state = this.states.get(runId);
    if (state) state.phase = phase;
  }

  getPlacement(runId: string): ReservedPlacement | undefined {
    return this.states.get(runId)?.placement;
  }

  getSubmission(runId: string): Promise<void> | undefined {
    return this.submissions.get(runId);
  }

  trackSubmission(runId: string, submission: Promise<void>): Promise<void> {
    let tracked: Promise<void>;
    tracked = submission.finally(() => {
      if (this.submissions.get(runId) === tracked) {
        this.submissions.delete(runId);
      }
    });
    this.submissions.set(runId, tracked);
    return tracked;
  }

  setConfig(runId: string, config: RunConfig): void {
    this.configs.set(runId, config);
  }

  getConfig(runId: string): RunConfig | undefined {
    return this.configs.get(runId);
  }

  isReady(runId: string): boolean {
    return this.states.get(runId)?.phase === "ready";
  }

  isCancelled(runId: string): boolean {
    return this.states.get(runId)?.cancelled === true;
  }

  markCancelled(runId: string): void {
    const state = this.states.get(runId);
    if (state) state.cancelled = true;
  }

  bindWorker(runId: string, workerId: string): boolean {
    const state = this.states.get(runId);
    if (!state) return false;
    state.workerId = workerId;
    state.phase = "ready";
    return true;
  }

  workerId(runId: string): string | undefined {
    const workerId = this.states.get(runId)?.workerId;
    return workerId || undefined;
  }

  delete(runId: string): void {
    this.states.delete(runId);
    this.configs.delete(runId);
  }
}
