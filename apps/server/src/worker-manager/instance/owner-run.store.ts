import { Injectable } from "@nestjs/common";

/**
 * owner → 其名下 in-flight runId 的双向索引,供心跳 fence 时反查该 owner 名下要
 * 终结哪些 run。resolveInstance/releaseInstanceForRun/cleanupRun 是 local 与
 * sandbox 两条路径都会经过的地方,索引维护收在这个独立 store 里,而不是散在
 * provisioner 或 facade 的私有状态里——WorkerManagerService 和
 * WorkerLivenessSweeper 都需要读写它,各自直接依赖它,不必互相持有对方。
 */
@Injectable()
export class OwnerRunStore {
  private readonly ownerRunIds = new Map<string, Set<string>>();
  private readonly runOwner = new Map<string, string>();

  registerRun(runId: string, ownerId: string): void {
    this.runOwner.set(runId, ownerId);
    let runIds = this.ownerRunIds.get(ownerId);
    if (!runIds) {
      runIds = new Set();
      this.ownerRunIds.set(ownerId, runIds);
    }
    runIds.add(runId);
  }

  unregisterRun(runId: string): void {
    const ownerId = this.runOwner.get(runId);
    if (!ownerId) return;
    this.runOwner.delete(runId);
    const runIds = this.ownerRunIds.get(ownerId);
    if (!runIds) return;
    runIds.delete(runId);
    if (runIds.size === 0) {
      this.ownerRunIds.delete(ownerId);
    }
  }

  listRunIdsByOwnerId(ownerId: string): string[] {
    return Array.from(this.ownerRunIds.get(ownerId) ?? []);
  }

  findOwnerIdByRunId(runId: string): string | undefined {
    return this.runOwner.get(runId);
  }
}
