import { apiGet, apiPost } from "@/lib/http";
import type { WorkerSnapshot } from "@agework/shared/protocol";

export type { WorkerSnapshot };

/** live workers 列表响应（无分页，现场快照）。 */
export interface LiveWorkerListResponse {
  list: WorkerSnapshot[];
}

export interface RuntimePolicy {
  defaultRuntimeType: string;
  allowedRuntimeTypes: string[];
  defaultScope: string;
  allowedScopes: string[];
  idleTimeoutSeconds: number;
}

export interface WorkerStats {
  activeWorkers: number;
}

export const workerApi = {
  policy: () => apiGet<RuntimePolicy>("/api/v1/admin/worker/policy"),
  stats: () => apiGet<WorkerStats>("/api/v1/admin/worker/stats"),
  /** 现场查询所有 Host（builtin + registered）的 worker 快照。 */
  listResources: () =>
    apiGet<LiveWorkerListResponse>("/api/v1/admin/worker/resources"),
  /** 定向停止 worker:runtimeHostId 选 Host,workerKey 定位其上的 worker。 */
  stopWorker: (input: { runtimeHostId: string; workerKey: string }) =>
    apiPost<{ ok: boolean }>("/api/v1/admin/worker/resources/stop", input),
};
