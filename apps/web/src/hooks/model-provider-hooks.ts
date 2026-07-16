import { useQuery, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { modelProvidersApi } from '@/api/model-providers';
import type { ProviderConfigValues } from '@/api/model-providers';
import type { AgentType, ApiFormat } from '@agework/shared';
export type { ModelProvider, ProviderConfigValues, ModelProviderTestResponse } from '@/api/model-providers';

function queryKey(agentType: AgentType, runtimeHostId?: string) {
  return ['model-providers', agentType, runtimeHostId ?? null];
}

const ADMIN_QUERY_KEY = ['admin-model-providers'];

/** 一个模型服务可服务多个 agent,写操作后按前缀失效全部 agent 的列表缓存。 */
function invalidateModelProviderQueries(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: ['model-providers'] });
  qc.invalidateQueries({ queryKey: ADMIN_QUERY_KEY });
}

export function useModelProviders(agentType: AgentType, runtimeHostId?: string) {
  return useQuery({
    queryKey: queryKey(agentType, runtimeHostId),
    queryFn: () => modelProvidersApi.list(agentType, runtimeHostId),
    select: (data) => data.list,
  });
}

export function useAdminModelProviders() {
  return useQuery({
    queryKey: ADMIN_QUERY_KEY,
    queryFn: () => modelProvidersApi.adminList(),
    select: (data) => data.list,
  });
}

export function useCreateModelProvider() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (data: {
      apiFormat: ApiFormat;
      name: string;
      providerConfig: ProviderConfigValues;
    }) => modelProvidersApi.create(data),
    onSuccess: () => invalidateModelProviderQueries(qc),
  });
}

export function useUpdateModelProvider() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: ({
      modelProviderId,
      name,
      providerConfig,
    }: {
      modelProviderId: string;
      name: string;
      providerConfig: ProviderConfigValues;
    }) => modelProvidersApi.update({ id: modelProviderId, name, providerConfig }),
    onSuccess: () => invalidateModelProviderQueries(qc),
  });
}

export function useSetModelProviderEnabled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ modelProviderId, isEnabled }: { modelProviderId: string; isEnabled: boolean }) =>
      modelProvidersApi.setEnabled({ id: modelProviderId, isEnabled }),
    onSuccess: () => invalidateModelProviderQueries(qc),
  });
}

export function useDeleteModelProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (modelProviderId: string) => modelProvidersApi.delete({ id: modelProviderId }),
    onSuccess: () => invalidateModelProviderQueries(qc),
  });
}

export function useTestModelProvider() {
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (modelProviderId: string) => modelProvidersApi.test({ id: modelProviderId }),
  });
}

export function useAdminTestModelProvider() {
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (modelProviderId: string) => modelProvidersApi.adminTest({ id: modelProviderId }),
  });
}
