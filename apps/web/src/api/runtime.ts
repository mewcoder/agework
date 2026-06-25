import { apiGet, apiPost } from '@/lib/http';
import type {
  RuntimeInstanceResponse,
  RuntimeInstanceListResponse,
} from '@agework/shared/api';

export type { RuntimeInstanceResponse as RuntimeTarget };

export interface RuntimePolicy {
  runtimeType: string;
  allowedRuntimeTypes: string[];
  isolationScope: string;
  allowedIsolationScopes: string[];
  idleTimeoutSeconds: number;
}

export interface RuntimeStats {
  activeRuntimes: number;
}

export const runtimeApi = {
  policy: () => apiGet<RuntimePolicy>('/api/v1/admin/runtime/policy'),
  stats: () => apiGet<RuntimeStats>('/api/v1/admin/runtime/stats'),
  listResources: (params: { status?: string; pageNo?: number; pageSize?: number }) => {
    const query = new URLSearchParams();
    if (params.status) query.set('status', params.status);
    if (params.pageNo) query.set('pageNo', String(params.pageNo));
    if (params.pageSize) query.set('pageSize', String(params.pageSize));
    const qs = query.toString();
    return apiGet<RuntimeInstanceListResponse>(`/api/v1/admin/runtime/resources${qs ? `?${qs}` : ''}`);
  },
  stopResource: (id: string) => apiPost<{ ok: boolean }>('/api/v1/admin/runtime/resources/stop', { id }),
};
