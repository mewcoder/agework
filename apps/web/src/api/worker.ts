import { apiGet, apiPost } from '@/lib/http';
import type {
  WorkerInstanceResponse,
  WorkerInstanceListResponse,
} from '@agework/shared/api';

export type { WorkerInstanceResponse };

export interface RuntimePolicy {
  runtimeType: string;
  allowedRuntimeTypes: string[];
  isolationScope: string;
  allowedIsolationScopes: string[];
  idleTimeoutSeconds: number;
}

export interface WorkerStats {
  activeWorkers: number;
}

export const workerApi = {
  policy: () => apiGet<RuntimePolicy>('/api/v1/admin/worker/policy'),
  stats: () => apiGet<WorkerStats>('/api/v1/admin/worker/stats'),
  listResources: (params: { status?: string; pageNo?: number; pageSize?: number }) => {
    const query = new URLSearchParams();
    if (params.status) query.set('status', params.status);
    if (params.pageNo) query.set('pageNo', String(params.pageNo));
    if (params.pageSize) query.set('pageSize', String(params.pageSize));
    const qs = query.toString();
    return apiGet<WorkerInstanceListResponse>(`/api/v1/admin/worker/resources${qs ? `?${qs}` : ''}`);
  },
  stopResource: (id: string) => apiPost<{ ok: boolean }>('/api/v1/admin/worker/resources/stop', { id }),
};
