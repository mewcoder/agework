import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { runtimesApi } from '@/api/runtimes';
import type {
  CreateRuntimeRequest,
  InstallCliRequest,
  UpdateEnvConfigOverrideRequest,
} from '@agework/shared/api';
export type { Runtime, CreateRuntimeResponse } from '@/api/runtimes';

export function useRuntimes() {
  return useQuery({
    queryKey: ['runtimes'],
    queryFn: () => runtimesApi.list(),
    select: (data) => data.list,
  });
}

/** admin: 列出全部 Runtime（builtin + 所有用户的 registered）。 */
export function useAdminRuntimes() {
  return useQuery({
    queryKey: ['admin-runtimes'],
    queryFn: () => runtimesApi.adminList(),
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

/** admin: 覆盖 runtime 的 CLI 路径（per-agent）。 */
export function useUpdateEnvConfigOverride() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateEnvConfigOverrideRequest) =>
      runtimesApi.updateEnvConfigOverride(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-runtimes'] }),
  });
}

/** admin: 触发 runtime 重新检测本机 CLI 环境。 */
export function useDetectEnv() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => runtimesApi.detectEnv(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-runtimes'] }),
  });
}

/** admin: 一键安装 runtime 独立 CLI（仅支持 local runtime）。 */
export function useInstallCli() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (data: InstallCliRequest) => runtimesApi.installCli(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-runtimes'] }),
  });
}
