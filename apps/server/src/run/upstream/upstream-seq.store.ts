import { Injectable } from "@nestjs/common";

export type SeqDecision =
  | { action: "drop"; lastSeq: number }
  | {
      action: "accept";
      lastSeq: number;
      gap?: { expected: number; got: number };
    };

/**
 * Worker 上行事件的 per-run seq 闸门（worker-event 子能力的 internal provider）。
 *
 * 持有每个 run 已处理到的最大 seq，对新到事件做纯判定：重复(seq<=lastSeq)丢弃、
 * 跳号(seq>lastSeq+1)标记 gap、否则接受并推进游标。只决策与持状态，不打日志、
 * 不落库——gap 的诊断事件落库与 warn 日志由 HostUpstreamHandler 按决策反应。
 */
@Injectable()
export class UpstreamSeqStore {
  private readonly lastSeqMap = new Map<string, number>();

  /** 判定一条 seq 是否接受，并在接受时推进游标（drop 不推进）。 */
  accept(runId: string, seq: number): SeqDecision {
    const lastSeq = this.lastSeqMap.get(runId) ?? 0;
    if (seq <= lastSeq) {
      return { action: "drop", lastSeq };
    }
    const gap =
      seq > lastSeq + 1 ? { expected: lastSeq + 1, got: seq } : undefined;
    this.lastSeqMap.set(runId, seq);
    return { action: "accept", lastSeq, gap };
  }

  /** 终态 cleanup 时丢弃该 run 的游标。 */
  forget(runId: string): void {
    this.lastSeqMap.delete(runId);
  }
}
