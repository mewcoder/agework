import type { RunConfig } from "@agework/shared/protocol";

type SubmittedRunState = {
  workerId: string;
  status: "acquiring" | "ready";
  cancelled: boolean;
};

/** Host 内一次 run 的短期会话状态，不是持久化业务数据。 */
export class RunSessionRegistry {
  private readonly states = new Map<string, SubmittedRunState>();
  private readonly submissions = new Map<string, Promise<void>>();
  private readonly configs = new Map<string, RunConfig>();

  has(runId: string): boolean {
    return this.states.has(runId);
  }

  reserve(runId: string): void {
    this.states.set(runId, {
      workerId: "",
      status: "acquiring",
      cancelled: false,
    });
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
    return this.states.get(runId)?.status === "ready";
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
    state.status = "ready";
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
