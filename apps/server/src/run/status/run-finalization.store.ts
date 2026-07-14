import { Injectable } from "@nestjs/common";

/** 终态完成后保留记录的时长，用于阻止 exit handler 等延迟事件覆盖已终态 */
const COMPLETED_RUN_TTL_MS = 5 * 60 * 1000;

/**
 * Run 终态守卫状态（run-status 子能力的 internal provider）。
 *
 * 持有「正在处理终态」与「已完成终态」两份 per-run 状态，回答
 * isTerminalOrFinalizing，使 WorkerEventHandler 在并发 / 延迟到达的 worker 事件下
 * 不会覆盖已确定的终态。只管状态边界，不做事件落库与 run-status 编排。
 */
@Injectable()
export class RunFinalizationStore {
  /** 防止同一 run 被并发处理多次终态 */
  private readonly finalizingRuns = new Set<string>();
  /** 已完成终态的 run，TTL 后自动清除，用于阻止 exit handler 覆盖 */
  private readonly completedRuns = new Map<string, NodeJS.Timeout>();

  /** run 是否已在终态处理中或已完成终态。 */
  isTerminalOrFinalizing(runId: string): boolean {
    return this.finalizingRuns.has(runId) || this.completedRuns.has(runId);
  }

  /** 标记 run 进入终态处理中（落库前调用，挡住并发的第二次终态）。 */
  beginFinalizing(runId: string): void {
    this.finalizingRuns.add(runId);
  }

  /**
   * 终态完成后记录 completed，TTL 内阻止延迟的 exit handler 覆盖。
   * 幂等：已记录则不重复设置定时器。必须在可能抛异常的落库操作之前调用，
   * 否则异常会跳过本次记录，导致终态 guard 失效。
   */
  markCompleted(runId: string): void {
    if (this.completedRuns.has(runId)) return;
    const timer = setTimeout(
      () => this.completedRuns.delete(runId),
      COMPLETED_RUN_TTL_MS
    );
    timer.unref();
    this.completedRuns.set(runId, timer);
  }

  /** 结束终态处理中标记（completed 记录仍按 TTL 保留）。 */
  endFinalizing(runId: string): void {
    this.finalizingRuns.delete(runId);
  }
}
