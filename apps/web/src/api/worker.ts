import { apiGet, apiPost } from "@/lib/http";
import type {
  WorkerInstanceResponse,
  WorkerInstanceListResponse,
} from "@agework/shared/api";
import type { WorkerSnapshot } from "@agework/shared/protocol";

export type { WorkerInstanceResponse };
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
  listResources: (params: {
    status?: string;
    pageNo?: number;
    pageSize?: number;
  }) => {
    const query = new URLSearchParams();
    if (params.status) query.set("status", params.status);
    if (params.pageNo) query.set("pageNo", String(params.pageNo));
    if (params.pageSize) query.set("pageSize", String(params.pageSize));
    const qs = query.toString();
    return apiGet<WorkerInstanceListResponse>(
      `/api/v1/admin/worker/resources${qs ? `?${qs}` : ""}`
    );
  },
  /** 现场查询所有 Host（builtin + registered）的 worker 快照。 */
  listLiveWorkers: () =>
    apiGet<LiveWorkerListResponse>("/api/v1/admin/worker/resources/live"),
  stopResource: (id: string) =>
    apiPost<{ ok: boolean }>("/api/v1/admin/worker/resources/stop", { id }),
  /** Phase 2: 通过 WorkerKey 停止 worker（走 hostContract.stopWorker）。 */
  stopLiveWorker: (workerKey: string) =>
    apiPost<{ ok: boolean }>("/api/v1/admin/worker/resources/stop-live", {
      workerKey,
    }),
};
