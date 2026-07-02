import { Injectable } from "@nestjs/common";
import { RunEventRepository } from "../run-event.repository";

/**
 * Run event 的 per-run seq 分配与串行化闸门（run-event 子能力的 internal provider）。
 *
 * 持有每个 run 已分配到的 seq 游标与串行执行队列：同一 runId 的多次 append 会被
 * 排队串行执行，保证 seq 单调递增且不重复；游标缺失时懒加载 repository 的
 * `maxRunSeq` 作为起点。Per-run seq 只在单个 API 实例内进程内分配，多实例部署需
 * 把分配迁入 RunEventRepository/DB。
 */
@Injectable()
export class RunSeqStore {
  private readonly runSeqCounters = new Map<string, number>();
  private readonly runLocks = new Map<string, Promise<unknown>>();

  constructor(private readonly repository: RunEventRepository) {}

  /** 在该 run 的串行队列中执行 fn，并传入本次分配到的下一个单调 runSeq。 */
  withNextSeq<T>(
    runId: string,
    fn: (runSeq: number) => Promise<T>
  ): Promise<T> {
    return this.withRunLock(runId, async () => {
      if (!this.runSeqCounters.has(runId)) {
        this.runSeqCounters.set(runId, await this.repository.maxRunSeq(runId));
      }

      const runSeq = (this.runSeqCounters.get(runId) ?? 0) + 1;
      this.runSeqCounters.set(runId, runSeq);

      return fn(runSeq);
    });
  }

  /** 终态 cleanup 时丢弃该 run 的 seq 游标缓存，下次重新从 repository 读取。 */
  forget(runId: string): void {
    this.runSeqCounters.delete(runId);
  }

  private withRunLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.runLocks.get(runId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(fn);
    const stored = next.catch(() => undefined);
    this.runLocks.set(runId, stored);
    stored.finally(() => {
      if (this.runLocks.get(runId) === stored) {
        this.runLocks.delete(runId);
      }
    });
    return next;
  }
}
