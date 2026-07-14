import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { workerApi } from '@/api/worker';

/** admin runtime 资源相关 react-query 键的唯一 factory:define 与 invalidate 共用。 */
const adminRuntimeKeys = {
  policy: ['admin', 'runtime', 'policy'] as const,
  stats: ['admin', 'runtime', 'stats'] as const,
  workers: ['admin', 'runtime', 'workers'] as const,
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

/** 现场查询所有 Host（builtin + registered）的 worker 快照。 */
export function useWorkers() {
  return useQuery({
    queryKey: adminRuntimeKeys.workers,
    queryFn: () => workerApi.listResources(),
  });
}

/** 定向停止目标 Host 上的 worker。 */
export function useStopWorker() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { runtimeHostId: string; workerKey: string }) =>
      workerApi.stopWorker(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: adminRuntimeKeys.workers });
      qc.invalidateQueries({ queryKey: adminRuntimeKeys.stats });
    },
  });
}
