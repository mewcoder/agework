import { apiGet, apiPost } from '@/lib/http';
import type { AgentType } from '@agework/shared';
import type {
  ModelProviderResponse,
  ModelProviderListResponse,
  ModelProviderTestResponse,
  CreateModelProviderRequest,
  UpdateModelProviderRequest,
  SetModelProviderEnabledRequest,
  ModelProviderIdRequest,
  ProviderConfig,
} from '@agework/shared/api';

export type { ModelProviderResponse as ModelProvider };
export type ProviderConfigValues = ProviderConfig;
export type { ModelProviderTestResponse };

export const modelProvidersApi = {
  list: (agentType: AgentType, runtimeHostId?: string) => {
    const params = new URLSearchParams({ agentType });
    if (runtimeHostId) params.set('runtimeHostId', runtimeHostId);
    return apiGet<ModelProviderListResponse>(`/api/v1/model-providers/list?${params.toString()}`);
  },

  adminList: () =>
    apiGet<ModelProviderListResponse>('/api/v1/admin/model-providers/list'),

  create: (body: CreateModelProviderRequest) =>
    apiPost<ModelProviderResponse>('/api/v1/admin/model-providers/create', body),

  update: (body: UpdateModelProviderRequest) =>
    apiPost<ModelProviderResponse>('/api/v1/admin/model-providers/update', body),

  setEnabled: (body: SetModelProviderEnabledRequest) =>
    apiPost<ModelProviderResponse>('/api/v1/admin/model-providers/set-enabled', body),

  test: (body: ModelProviderIdRequest) =>
    apiPost<ModelProviderTestResponse>('/api/v1/model-providers/ping', body),

  adminTest: (body: ModelProviderIdRequest) =>
    apiPost<ModelProviderTestResponse>('/api/v1/admin/model-providers/ping', body),

  delete: (body: ModelProviderIdRequest) =>
    apiPost('/api/v1/admin/model-providers/remove', body),
};
