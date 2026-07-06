export const WORKER_LOST_EVENT = "worker.lost";

/**
 * worker 因心跳超时被 fence 掉,其名下这个 run 已经拿不到该 worker 后续任何执行
 * 反馈了。run 层据此把该 run 强制推进终态,不等待也不会再收到这个 worker 的上报。
 */
export class WorkerLostEvent {
  constructor(
    readonly runId: string,
    readonly reason: string
  ) {}
}
