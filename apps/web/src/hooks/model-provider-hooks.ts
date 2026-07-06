import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { modelProvidersApi } from '@/api/model-providers';
import type { ProviderConfigValues } from '@/api/model-providers';
import type { AgentType } from '@agework/shared';
export type { ModelProvider, ProviderConfigValues, ModelProviderTestResponse } from '@/api/model-providers';

function queryKey(agentType: AgentType, runtimeId?: string) {
  return ['model-providers', agentType, runtimeId ?? null];
}

function adminQueryKey(agentType: AgentType) {
  return ['admin-model-providers', agentType];
}

export function useModelProviders(agentType: AgentType, runtimeId?: string) {
  return useQuery({
    queryKey: queryKey(agentType, runtimeId),
    queryFn: () => modelProvidersApi.list(agentType, runtimeId),
    select: (data) => data.list,
  });
}

export function useAdminModelProviders(agentType: AgentType) {
  return useQuery({
    queryKey: adminQueryKey(agentType),
    queryFn: () => modelProvidersApi.adminList(agentType),
    select: (data) => data.list,
  });
}

export function useCreateModelProvider(agentType: AgentType) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (data: { name: string; providerConfig: ProviderConfigValues }) =>
      modelProvidersApi.create({ agentType, ...data }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKey(agentType) });
      qc.invalidateQueries({ queryKey: adminQueryKey(agentType) });
    },
  });
}

export function useUpdateModelProvider(agentType: AgentType) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: ({ modelProviderId, name, providerConfig }: { modelProviderId: string; name: string; providerConfig: ProviderConfigValues }) =>
      modelProvidersApi.update({ id: modelProviderId, name, providerConfig }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKey(agentType) });
      qc.invalidateQueries({ queryKey: adminQueryKey(agentType) });
    },
  });
}

export function useSetModelProviderEnabled(agentType: AgentType) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ modelProviderId, isEnabled }: { modelProviderId: string; isEnabled: boolean }) =>
      modelProvidersApi.setEnabled({ id: modelProviderId, isEnabled }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKey(agentType) });
      qc.invalidateQueries({ queryKey: adminQueryKey(agentType) });
    },
  });
}

export function useDeleteModelProvider(agentType: AgentType) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (modelProviderId: string) => modelProvidersApi.delete({ id: modelProviderId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKey(agentType) });
      qc.invalidateQueries({ queryKey: adminQueryKey(agentType) });
    },
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
