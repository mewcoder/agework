import { apiGet, apiPost } from '@/lib/http';
import type {
  CreateRuntimeRequest,
  CreateRuntimeResponse,
  RuntimeResponse,
} from '@agework/shared/api';

export type { RuntimeResponse as Runtime };
export type { CreateRuntimeResponse };

export const runtimesApi = {
  list: () => apiGet<{ list: RuntimeResponse[] }>('/api/v1/runtimes/list'),

  create: (body: CreateRuntimeRequest) =>
    apiPost<CreateRuntimeResponse>('/api/v1/runtimes/create', body),

  delete: (id: string) => apiPost('/api/v1/runtimes/delete', { id }),
};
