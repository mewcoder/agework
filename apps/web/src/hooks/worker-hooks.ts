import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { workerApi } from '@/api/worker';
import { DEFAULT_PAGE_SIZE } from '@/hooks/use-pagination';

/** admin runtime 资源相关 react-query 键的唯一 factory:define 与 invalidate 共用。 */
const adminRuntimeKeys = {
  policy: ['admin', 'runtime', 'policy'] as const,
  stats: ['admin', 'runtime', 'stats'] as const,
  resourcesRoot: ['admin', 'runtime', 'resources'] as const,
  resources: (status: string | undefined, page: number, pageSize: number) =>
    ['admin', 'runtime', 'resources', status, page, pageSize],
  liveWorkers: ['admin', 'runtime', 'live-workers'] as const,
};

export function useRuntimePolicy() {
  return useQuery({
    queryKey: adminRuntimeKeys.policy,
    queryFn: () => workerApi.policy(),
  });
}

export function useWorkerStats() {
  return useQuery({
    queryKey: adminRuntimeKeys.stats,
    queryFn: () => workerApi.stats(),
  });
}

export function useWorkerResources(status?: string, page = 1, pageSize = DEFAULT_PAGE_SIZE) {
  return useQuery({
    queryKey: adminRuntimeKeys.resources(status, page, pageSize),
    queryFn: () => workerApi.listResources({ status: status || undefined, pageNo: page, pageSize }),
  });
}

/** Phase 2: 现场查询所有 Host 的 worker 快照。 */
export function useLiveWorkers() {
  return useQuery({
    queryKey: adminRuntimeKeys.liveWorkers,
    queryFn: () => workerApi.listLiveWorkers(),
  });
}

export function useStopWorkerResource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => workerApi.stopResource(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: adminRuntimeKeys.resourcesRoot });
      qc.invalidateQueries({ queryKey: adminRuntimeKeys.stats });
    },
  });
}

/** Phase 2: 通过 WorkerKey 停止 worker（走 hostContract.stopWorker）。 */
export function useStopLiveWorker() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (workerKey: string) => workerApi.stopLiveWorker(workerKey),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: adminRuntimeKeys.liveWorkers });
      qc.invalidateQueries({ queryKey: adminRuntimeKeys.stats });
    },
  });
}
