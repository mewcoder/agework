import type { WorkerKey } from "@agework/shared/protocol";

/**
 * 一个 worker 在池中的条目。worker 是 Host 上的一个隔离执行代理：
 * 一个常驻进程，接命令、fork runner、回事件。
 */
export type WorkerEntry = {
  /** Worker 主键（供 worker HTTP 鉴权用，等价于旧模型的 Worker.id）。 */
  workerId: string;
  /** 池键：`${OwnerKey}#${RuntimeType}`（不变量 2）。 */
  key: WorkerKey;
  /** 启动握手共享密钥，绑定"这次运行载体存活周期"。 */
  startToken: string;
  status: "starting" | "ready";
  /** 宿主实例标识（容器 ID / sandbox ID / pid:token）。 */
  runtimeInstanceId: string;
  /** 最后被看见的时间戳（long-poll 或事件上报时 touch）。 */
  lastSeen: number;
  /** 就绪前到达的 cancel runId 集合——就绪那刻转 cancelled 终态。 */
  cancelledRuns: Set<string>;
  /** 该 worker 名下活跃的 runId 集合。 */
  activeRuns: Set<string>;
};

/**
 * worker 池：内存 `Map<WorkerKey, WorkerEntry>`。
 *
 * 不变量 2：同一个 `(owner, runtimeType)` 同时至多一个活跃 worker；
 * 该键下所有 run 都路由给它。池、观测、stopWorker、fence 全部用同一个 WorkerKey，
 * 不出现裸 ownerKey。
 */
export class WorkerPool {
  private readonly workers = new Map<WorkerKey, WorkerEntry>();
  /** runId → WorkerKey 反查索引，供 command 路由用。 */
  private readonly runIndex = new Map<string, WorkerKey>();

  /** 按 WorkerKey 查活跃 worker。 */
  get(key: WorkerKey): WorkerEntry | undefined {
    return this.workers.get(key);
  }

  /** 按 runId 查 worker（command 路由用）。 */
  getByRunId(runId: string): WorkerEntry | undefined {
    const key = this.runIndex.get(runId);
    if (!key) return undefined;
    return this.workers.get(key);
  }

  /** 放入一个 starting 状态的 worker。 */
  put(entry: WorkerEntry): void {
    this.workers.set(entry.key, entry);
  }

  /** 更新 worker 状态为 ready（握手成功后）。 */
  markReady(key: WorkerKey, runtimeInstanceId: string): void {
    const entry = this.workers.get(key);
    if (entry) {
      entry.status = "ready";
      entry.runtimeInstanceId = runtimeInstanceId;
    }
  }

  /** 关联 runId 到 worker。 */
  associateRun(key: WorkerKey, runId: string): void {
    const entry = this.workers.get(key);
    if (entry) {
      entry.activeRuns.add(runId);
      this.runIndex.set(runId, key);
    }
  }

  /** 取消关联 runId。 */
  dissociateRun(runId: string): void {
    const key = this.runIndex.get(runId);
    if (key) {
      const entry = this.workers.get(key);
      entry?.activeRuns.delete(runId);
      this.runIndex.delete(runId);
    }
  }

  /** touch 心跳（long-poll 或事件上报时调用）。 */
  touch(key: WorkerKey, now: number = Date.now()): void {
    const entry = this.workers.get(key);
    if (entry) entry.lastSeen = now;
  }

  /** 标记就绪前 cancel。 */
  markCancelled(key: WorkerKey, runId: string): void {
    const entry = this.workers.get(key);
    if (entry) entry.cancelledRuns.add(runId);
  }

  /** 消费就绪前 cancel 标记（就绪时检查）。 */
  consumeCancelled(key: WorkerKey, runId: string): boolean {
    const entry = this.workers.get(key);
    if (!entry) return false;
    return entry.cancelledRuns.delete(runId);
  }

  /** 删除 worker（fence / stop / destroy 后）。 */
  remove(key: WorkerKey): WorkerEntry | undefined {
    const entry = this.workers.get(key);
    if (!entry) return undefined;
    // 清理 run 索引
    for (const runId of entry.activeRuns) {
      this.runIndex.delete(runId);
    }
    this.workers.delete(key);
    return entry;
  }

  /** 列出所有 worker（admin 观测用）。 */
  list(): WorkerEntry[] {
    return [...this.workers.values()];
  }

  /** 按 OwnerKey 前缀过滤 worker（releaseOwner 用）。 */
  listByOwner(ownerPrefix: string): WorkerEntry[] {
    return this.list().filter((w) => w.key.startsWith(ownerPrefix));
  }
}
