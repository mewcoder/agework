import type { WorkerScope } from "@agework/shared/protocol";
import type { RuntimeType } from "@agework/runtime-sdk";
import type { ReleaseCleanupContext } from "./cleanup-ledger";

/**
 * Runtime 内部派生的结构化复用身份。scope 是最大共享边界,subjectId 是该 scope
 * 下的复用主体(user scope → userId, workspace scope → workspaceId)。
 * 该类型只存在于 apps/runtime,不从 packages/shared 导出。
 */
export type ReuseIdentity = {
  scope: WorkerScope;
  subjectId: string;
  runtimeType: RuntimeType;
};

/** 把 ReuseIdentity 序列化为 Map key(避免歧义拼接)。 */
export function reuseKey(identity: ReuseIdentity): string {
  return JSON.stringify([
    identity.scope,
    identity.subjectId,
    identity.runtimeType,
  ]);
}

/** 把 (ReuseIdentity, userLifecycleVersion) 序列化为 acquisition 去重 key。
 *  不同 generation 的 acquisition 各占独立槽位,支持两代短暂并存(SPEC §5.2)。 */
function acquisitionKey(identity: ReuseIdentity, version: number): string {
  return `${reuseKey(identity)}:${version}`;
}

/** 从 placement 派生 ReuseIdentity(唯一派生点)。 */
export function deriveReuseIdentity(placement: {
  scope: WorkerScope;
  userId: string;
  workspaceId: string;
  runtimeType: RuntimeType;
}): ReuseIdentity {
  return {
    scope: placement.scope,
    subjectId:
      placement.scope === "user"
        ? placement.userId
        : placement.workspaceId,
    runtimeType: placement.runtimeType,
  };
}

/**
 * 一个 worker 在池中的条目。worker 是 Host 上的常驻执行代理：
 * 一个常驻进程，接命令、fork runner、回事件。
 *
 * 保存结构化 isolation、userId、userLifecycleVersion,而不是从字符串 key 反解析。
 */
export type WorkerEntry = {
  /** Worker 主键（供 worker HTTP 鉴权用,Runtime 内部控制身份）。 */
  workerId: string;
  /** 结构化隔离身份,由 Runtime 从 placement 唯一派生。 */
  isolation: {
    scope: WorkerScope;
    subjectId: string;
  };
  /** runtimeType(与 isolation 一起构成 ReuseIdentity)。 */
  runtimeType: RuntimeType;
  /** 归属用户(用于 user target 释放时匹配该用户的所有 worker)。 */
  userId: string;
  /** User.sessionVersion(用于 generation fence)。 */
  userLifecycleVersion: number;
  /** 该 worker 服务过的 workspaceId 集合(user scope 可能多个)。 */
  workspaceIds: Set<string>;
  /** 启动握手共享密钥，绑定"这次运行实例存活周期"。 */
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
 * 在途 acquisition 的元数据。release 时需要按 user/workspace 匹配并取消。
 */
export type AcquisitionTask = {
  /** submit 等待的结果；可因 timeout/cancel 先失败。 */
  result: Promise<WorkerEntry>;
  /** provider.start + 必要 rollback 的真实资源生命周期屏障。 */
  lifetime: Promise<void>;
  cancel: (release?: ReleaseCleanupContext) => void;
};

type AcquisitionRecord = AcquisitionTask & {
  identity: ReuseIdentity;
  userId: string;
  /** user scope 的共享 acquisition 可能同时有多个 workspace waiter。 */
  workspaceIds: Set<string>;
  userLifecycleVersion: number;
};

/**
 * worker 池:内存索引结构。
 *
 * - `workersById` 是 stop、fence 和现场控制的权威索引(按 workerId)。
 * - `reuseIndex` 是可替换策略索引;初期一个 identity 对一个 workerId。
 * - `runIndex` 是 runId → workerId 反查索引,供 command 路由用。
 * - `acquisitions` 带元数据,release 时可枚举、取消并等待 settle。
 *
 * 序列化只用于 Map key,不能成为协议。
 */
export class WorkerPool {
  private readonly workersById = new Map<string, WorkerEntry>();
  /** ReuseIdentity key → (userLifecycleVersion → workerId)。
   *  多代并存:不同 userLifecycleVersion 的 worker 各占独立槽位(SPEC §5.2)。 */
  private readonly reuseIndex = new Map<string, Map<number, string>>();
 /** (ReuseIdentity, userLifecycleVersion) 级启动去重：创建中的 worker 也占用唯一槽位(带元数据)。
   *  不同 generation 的 acquisition 各占独立槽位,支持两代短暂并存。 */
  private readonly acquisitions = new Map<string, AcquisitionRecord>();
  /** runId → workerId 反查索引，供 command 路由用。 */
  private readonly runIndex = new Map<string, string>();

  /** 按 workerId 查活跃 worker。 */
  getById(workerId: string): WorkerEntry | undefined {
    return this.workersById.get(workerId);
  }

  /** 按 (ReuseIdentity, userLifecycleVersion) 查活跃 worker。
   *  版本必须精确匹配:不同 generation 不得复用旧代 worker(SPEC §6.2)。 */
  getByIdentity(
    identity: ReuseIdentity,
    userLifecycleVersion: number
  ): WorkerEntry | undefined {
    const workerId = this.reuseIndex
      .get(reuseKey(identity))
      ?.get(userLifecycleVersion);
    if (!workerId) return undefined;
    return this.workersById.get(workerId);
  }

  /**
   * 取得（创建）worker。同一 ReuseIdentity 至多一个活跃 worker。
   *
   * 复用命中必须处于同一 user generation：不同 userLifecycleVersion 不得复用
   * 旧代 worker（SPEC §6.2）。如果存在旧代 ready worker，调用方应先释放它
   * 再创建新代 worker——这里只做拒绝复用。
   *
   * `cancel` 用于 release 时取消在途 acquisition；`metadata` 用于 release 时
   * 按 user/workspace 匹配在途 acquisition。
   */
  acquireOnce(
    identity: ReuseIdentity,
    userLifecycleVersion: number,
    metadata: {
      userId: string;
      workspaceId: string;
      /** 旧调用方兼容；新 acquisition task 自带 cancel。 */
      cancel?: () => void;
    },
    acquire: () => AcquisitionTask | Promise<WorkerEntry>
  ): Promise<WorkerEntry> {
    // 复用命中:同一 (identity, version) 的 ready worker
    const existing = this.getByIdentity(identity, userLifecycleVersion);
    if (existing?.status === "ready") {
      return Promise.resolve(existing);
    }

    // 在途 acquisition 去重:同一 (identity, version) 的在途 promise
    const ak = acquisitionKey(identity, userLifecycleVersion);
    const inFlight = this.acquisitions.get(ak);
    if (inFlight) {
      inFlight.workspaceIds.add(metadata.workspaceId);
      return inFlight.result;
    }

    const acquired = acquire();
    const task: AcquisitionTask =
      "result" in acquired
        ? acquired
        : {
            result: acquired,
            lifetime: acquired.then(
              () => undefined,
              () => undefined
            ),
            cancel: metadata.cancel ?? (() => {}),
          };
    const tracked: AcquisitionRecord = {
      ...task,
      identity,
      userId: metadata.userId,
      workspaceIds: new Set([metadata.workspaceId]),
      userLifecycleVersion,
    };
    this.acquisitions.set(ak, tracked);
    const clear = () => {
      if (this.acquisitions.get(ak) === tracked) {
        this.acquisitions.delete(ak);
      }
    };
    task.lifetime.then(clear, clear);
    return task.result;
  }

  /**
   * 枚举在途 acquisition（release 对账用）。
   * 返回浅拷贝，调用方可以安全遍历。
   */
  listAcquisitions(): readonly AcquisitionRecord[] {
    return [...this.acquisitions.values()];
  }

  /**
   * 取消并等待匹配的在途 acquisition settle。
   *
   * 调用 cancel() 后，acquireWorker 会清理已启动的资源并 reject promise。
   * 本方法 await 所有匹配 acquisition 的 promise（转为 settle，不抛错）。
   */
  async drainAcquisitions(
    predicate: (a: AcquisitionRecord) => boolean,
    release?: ReleaseCleanupContext
  ): Promise<void> {
    const matching = this.listAcquisitions().filter(predicate);
    if (matching.length === 0) return;
    // 先全部 cancel（同步设置 cancelled 标记）
    for (const acq of matching) {
      acq.cancel(release);
    }
    // lifetime 只在 provider 清理失败时 reject，不能用 allSettled 吞掉。
    await Promise.all(matching.map((acq) => acq.lifetime));
  }

  /**
   * workspace release 从共享 acquisition 移除该 workspace waiter。
   * workspace scope 必定取消；user scope 仅在没有其它 workspace waiter 时取消。
   */
  async detachWorkspaceAcquisitions(
    workspaceId: string,
    release?: ReleaseCleanupContext
  ): Promise<void> {
    const cancelled: AcquisitionRecord[] = [];
    for (const record of this.listAcquisitions()) {
      if (!record.workspaceIds.delete(workspaceId)) continue;
      this.getByIdentity(
        record.identity,
        record.userLifecycleVersion
      )?.workspaceIds.delete(workspaceId);
      if (record.identity.scope === "workspace" || record.workspaceIds.size === 0) {
        record.cancel(release);
        cancelled.push(record);
      }
    }
    await Promise.all(cancelled.map((record) => record.lifetime));
  }

  /** 按 runId 查 worker（command 路由用）。 */
  getByRunId(runId: string): WorkerEntry | undefined {
    const workerId = this.runIndex.get(runId);
    if (!workerId) return undefined;
    return this.workersById.get(workerId);
  }

  /** run 是否归指定 worker 所有（worker 数据面授权用）。 */
  ownsRun(workerId: string, runId: string): boolean {
    return this.getByRunId(runId)?.workerId === workerId;
  }

  /**
   * 放入一个 starting 状态的 worker,同时建立 reuseIndex。
   *
   * 多代并存(SPEC §5.2):不同 userLifecycleVersion 的 worker 各占独立槽位,
   * 新代 worker 的 put 不移除旧代 worker——旧代 worker 继续服务已绑定 run,
   * 但不再接受新 submit(由 getByIdentity 版本精确匹配保证)。
   *
   * 同代替换:同一 (identity, version) 已存在旧条目时,移除旧条目
   * (同一 generation 至多一个 worker,旧条目是被新 attempt 取代的僵死实例)。
   */
  put(entry: WorkerEntry): void {
    const identity: ReuseIdentity = {
      scope: entry.isolation.scope,
      subjectId: entry.isolation.subjectId,
      runtimeType: entry.runtimeType,
    };
    const rk = reuseKey(identity);
    let versionMap = this.reuseIndex.get(rk);
    if (!versionMap) {
      versionMap = new Map();
      this.reuseIndex.set(rk, versionMap);
    }
    // 同代替换:移除旧条目(不调用 provider release,只是索引清理)
    const existingWorkerId = versionMap.get(entry.userLifecycleVersion);
    if (existingWorkerId && existingWorkerId !== entry.workerId) {
      const old = this.workersById.get(existingWorkerId);
      if (old) {
        for (const runId of old.activeRuns) {
          this.runIndex.delete(runId);
        }
        this.workersById.delete(existingWorkerId);
      }
    }
    versionMap.set(entry.userLifecycleVersion, entry.workerId);
    this.workersById.set(entry.workerId, entry);
  }

  /** 更新 worker 状态为 ready（握手成功后）。 */
  markReady(workerId: string, runtimeInstanceId: string): void {
    const entry = this.workersById.get(workerId);
    if (entry) {
      entry.status = "ready";
      entry.runtimeInstanceId = runtimeInstanceId;
    }
  }

  /** 关联 runId 到 worker。 */
  associateRun(workerId: string, runId: string): void {
    const entry = this.workersById.get(workerId);
    if (entry) {
      entry.activeRuns.add(runId);
      this.runIndex.set(runId, workerId);
    }
  }

  /** 取消关联 runId。 */
  dissociateRun(runId: string): void {
    const workerId = this.runIndex.get(runId);
    if (workerId) {
      const entry = this.workersById.get(workerId);
      entry?.activeRuns.delete(runId);
      this.runIndex.delete(runId);
    }
  }

  /** touch 心跳（long-poll 或事件上报时调用）。 */
  touch(workerId: string, now: number = Date.now()): void {
    const entry = this.workersById.get(workerId);
    if (entry) entry.lastSeen = now;
  }

  /** 标记就绪前 cancel。 */
  markCancelled(workerId: string, runId: string): void {
    const entry = this.workersById.get(workerId);
    if (entry) entry.cancelledRuns.add(runId);
  }

  /** 消费就绪前 cancel 标记（就绪时检查）。 */
  consumeCancelled(workerId: string, runId: string): boolean {
    const entry = this.workersById.get(workerId);
    if (!entry) return false;
    return entry.cancelledRuns.delete(runId);
  }

  /** 删除 worker（fence / stop / destroy 后）。 */
  remove(
    workerId: string,
    expectedWorkerId?: string
  ): WorkerEntry | undefined {
    const entry = this.workersById.get(workerId);
    if (!entry) return undefined;
    if (expectedWorkerId && entry.workerId !== expectedWorkerId)
      return undefined;
    // 清理 run 索引
    for (const runId of entry.activeRuns) {
      this.runIndex.delete(runId);
    }
    // 清理 reuseIndex(只删当前版本槽位,不影响其它代)
    const identity: ReuseIdentity = {
      scope: entry.isolation.scope,
      subjectId: entry.isolation.subjectId,
      runtimeType: entry.runtimeType,
    };
    const rk = reuseKey(identity);
    const versionMap = this.reuseIndex.get(rk);
    if (versionMap?.get(entry.userLifecycleVersion) === workerId) {
      versionMap.delete(entry.userLifecycleVersion);
      if (versionMap.size === 0) {
        this.reuseIndex.delete(rk);
      }
    }
    this.workersById.delete(workerId);
    return entry;
  }

  /** 列出所有 worker（admin 观测用）。 */
  list(): WorkerEntry[] {
    return [...this.workersById.values()];
  }

  /** 按 workspaceId 过滤 worker(释放 workspace target 用)。 */
  listByWorkspace(workspaceId: string): WorkerEntry[] {
    return this.list().filter((w) =>
      w.isolation.scope === "workspace"
        ? w.isolation.subjectId === workspaceId
        : w.workspaceIds.has(workspaceId)
    );
  }

  /** 按 userId 过滤 worker(释放 user target 用,覆盖两类 scope)。 */
  listByUser(userId: string): WorkerEntry[] {
    return this.list().filter((w) => w.userId === userId);
  }
}
