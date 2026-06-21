import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { runtimeApi } from '@/api/runtime';
import { DEFAULT_PAGE_SIZE } from '@/hooks/use-pagination';

export function useRuntimePolicy() {
  return useQuery({
    queryKey: ['admin', 'runtime', 'policy'],
    queryFn: () => runtimeApi.policy(),
  });
}

export function useRuntimeStats() {
  return useQuery({
    queryKey: ['admin', 'runtime', 'stats'],
    queryFn: () => runtimeApi.stats(),
  });
}

export function useRuntimeResources(status?: string, page = 1, pageSize = DEFAULT_PAGE_SIZE) {
  return useQuery({
    queryKey: ['admin', 'runtime', 'resources', status, page, pageSize],
    queryFn: () => runtimeApi.listResources({ status: status || undefined, pageNo: page, pageSize }),
  });
}

export function useStopRuntimeResource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => runtimeApi.stopResource(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'runtime', 'resources'] });
      qc.invalidateQueries({ queryKey: ['admin', 'runtime', 'stats'] });
    },
  });
}
