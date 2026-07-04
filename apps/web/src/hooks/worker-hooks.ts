import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { workerApi } from '@/api/worker';
import { DEFAULT_PAGE_SIZE } from '@/hooks/use-pagination';

export function useRuntimePolicy() {
  return useQuery({
    queryKey: ['admin', 'runtime', 'policy'],
    queryFn: () => workerApi.policy(),
  });
}

export function useWorkerStats() {
  return useQuery({
    queryKey: ['admin', 'runtime', 'stats'],
    queryFn: () => workerApi.stats(),
  });
}

export function useWorkerResources(status?: string, page = 1, pageSize = DEFAULT_PAGE_SIZE) {
  return useQuery({
    queryKey: ['admin', 'runtime', 'resources', status, page, pageSize],
    queryFn: () => workerApi.listResources({ status: status || undefined, pageNo: page, pageSize }),
  });
}

export function useStopWorkerResource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => workerApi.stopResource(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'runtime', 'resources'] });
      qc.invalidateQueries({ queryKey: ['admin', 'runtime', 'stats'] });
    },
  });
}
