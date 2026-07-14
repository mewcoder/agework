import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { runtimeHostsApi, workerApi } from "@/api/runtime-hosts";
import type {
  CreateHostDirectoryRequest,
  CreateRuntimeHostRequest,
  InstallCliRequest,
  UpdateEnvConfigOverrideRequest,
} from "@agework/shared/api";
export type { RuntimeHost, CreateRuntimeHostResponse } from "@/api/runtime-hosts";

/** runtime 相关 react-query 键的唯一 factory:define 与 invalidate 共用。 */
const runtimeHostKeys = {
  all: ["runtime-hosts"] as const,
  adminAll: ["admin-runtime-hosts"] as const,
  directory: (runtimeHostId: string | undefined, path: string | undefined) => [
    "host-directory",
    runtimeHostId,
    path ?? null,
  ],
};

export function useRuntimeHosts() {
  return useQuery({
    queryKey: runtimeHostKeys.all,
    queryFn: () => runtimeHostsApi.list(),
    select: (data) => data.list,
  });
}

/** admin: 列出全部 RuntimeHost Host（builtin + 所有用户的 registered）。 */
export function useAdminRuntimeHosts() {
  return useQuery({
    queryKey: runtimeHostKeys.adminAll,
    queryFn: () => runtimeHostsApi.adminList(),
    select: (data) => data.list,
  });
}

export function useCreateRuntimeHost() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (data: CreateRuntimeHostRequest) => runtimeHostsApi.create(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: runtimeHostKeys.all }),
  });
}

export function useDeleteRuntimeHost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => runtimeHostsApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: runtimeHostKeys.all }),
  });
}

/** admin: 覆盖 runtime 的 CLI 路径（per-agent）。 */
export function useUpdateEnvConfigOverride() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateEnvConfigOverrideRequest) =>
      runtimeHostsApi.updateEnvConfigOverride(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: runtimeHostKeys.adminAll }),
  });
}

/** admin: 触发 runtime 重新检测本机 CLI 环境。 */
export function useDetectEnv() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => runtimeHostsApi.detectEnv(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: runtimeHostKeys.adminAll }),
  });
}

/** admin: 一键安装 runtime 独立 CLI（仅支持 native runtimeType）。 */
export function useInstallCli() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (data: InstallCliRequest) => runtimeHostsApi.installCli(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: runtimeHostKeys.adminAll }),
  });
}

/** 列出 runtime 上 path 下的子目录（不含文件），供目录浏览弹层用。 */
export function useHostDirectory(
  runtimeHostId: string | undefined,
  path: string | undefined,
  enabled: boolean
) {
  return useQuery({
    queryKey: runtimeHostKeys.directory(runtimeHostId, path),
    queryFn: () =>
      runtimeHostsApi.listDirectory({ runtimeHostId: runtimeHostId!, path }),
    enabled: enabled && !!runtimeHostId,
    // 导航时保留上一个目录的数据，避免闪烁
    placeholderData: (prev) => prev,
  });
}

/** 在 runtime 上新建目录,供目录浏览弹层用。 */
export function useCreateHostDirectory() {
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: CreateHostDirectoryRequest) =>
      runtimeHostsApi.createDirectory(body),
  });
}

// ── worker 子资源 hooks(admin 诊断面)────────────────────────────────

/** admin worker 子资源 react-query 键的唯一 factory:define 与 invalidate 共用。 */
const adminWorkerKeys = {
  workers: ["admin", "runtime-hosts", "workers"] as const,
};

/** 现场查询所有 Host（builtin + registered）的 worker 快照。 */
export function useWorkers() {
  return useQuery({
    queryKey: adminWorkerKeys.workers,
    queryFn: () => workerApi.list(),
  });
}

/** 定向停止目标 Host 上的 worker。 */
export function useStopWorker() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { runtimeHostId: string; workerKey: string }) =>
      workerApi.stopWorker(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: adminWorkerKeys.workers });
    },
  });
}
