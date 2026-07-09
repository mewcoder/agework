import { Injectable } from "@nestjs/common";

/**
 * worker → 其名下 in-flight runId 的双向索引,供心跳 fence 时反查该 worker 名下要
 * 终结哪些 run。resolveInstance/releaseInstanceForRun/cleanupRun 是 local 与
 * sandbox 两条路径都会经过的地方,索引维护收在这个独立 store 里,而不是散在
 * provisioner 或 facade 的私有状态里——WorkerManagerService 和
 * WorkerLivenessSweeper 都需要读写它,各自直接依赖它,不必互相持有对方。
 */
@Injectable()
export class OwnerRunStore {
  private readonly workerRunIds = new Map<string, Set<string>>();
  private readonly runWorker = new Map<string, string>();

  registerRun(runId: string, workerId: string): void {
    this.runWorker.set(runId, workerId);
    let runIds = this.workerRunIds.get(workerId);
    if (!runIds) {
      runIds = new Set();
      this.workerRunIds.set(workerId, runIds);
    }
    runIds.add(runId);
  }

  unregisterRun(runId: string): void {
    const workerId = this.runWorker.get(runId);
    if (!workerId) return;
    this.runWorker.delete(runId);
    const runIds = this.workerRunIds.get(workerId);
    if (!runIds) return;
    runIds.delete(runId);
    if (runIds.size === 0) {
      this.workerRunIds.delete(workerId);
    }
  }

  listRunIdsByWorkerId(workerId: string): string[] {
    return Array.from(this.workerRunIds.get(workerId) ?? []);
  }

  findWorkerIdByRunId(runId: string): string | undefined {
    return this.runWorker.get(runId);
  }
}
