import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { runtimesApi } from '@/api/runtimes';
import type { CreateRuntimeRequest } from '@agework/shared/api';
export type { Runtime, CreateRuntimeResponse } from '@/api/runtimes';

export function useRuntimes() {
  return useQuery({
    queryKey: ['runtimes'],
    queryFn: () => runtimesApi.list(),
    select: (data) => data.list,
  });
}

export function useCreateRuntime() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (data: CreateRuntimeRequest) => runtimesApi.create(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['runtimes'] }),
  });
}

export function useDeleteRuntime() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => runtimesApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['runtimes'] }),
  });
}
