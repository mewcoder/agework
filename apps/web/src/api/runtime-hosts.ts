import { apiGet, apiPost } from "@/lib/http";
import type { WorkerSnapshot } from "@agework/shared/protocol";
import type {
  CreateHostDirectoryRequest,
  CreateHostDirectoryResponse,
  CreateRuntimeHostRequest,
  CreateRuntimeHostResponse,
  DetectEnvResponse,
  InstallCliRequest,
  ListHostDirectoryRequest,
  HostDirectoryResponse,
  RuntimeHostResponse,
  UpdateEnvConfigOverrideRequest,
} from "@agework/shared/api";

export type { RuntimeHostResponse as RuntimeHost };
export type { CreateRuntimeHostResponse };

export const runtimeHostsApi = {
  list: () => apiGet<{ list: RuntimeHostResponse[] }>("/api/v1/runtime-hosts/list"),

  /** admin: 列出全部 RuntimeHost Host（builtin + 所有用户的 registered）。 */
  adminList: () =>
    apiGet<{ list: RuntimeHostResponse[] }>("/api/v1/admin/runtime-hosts/list"),

  create: (body: CreateRuntimeHostRequest) =>
    apiPost<CreateRuntimeHostResponse>("/api/v1/admin/runtime-hosts/create", body),

  delete: (id: string) => apiPost("/api/v1/admin/runtime-hosts/delete", { id }),

  /** admin: 覆盖 runtime 的 CLI 路径（per-agent）。 */
  updateEnvConfigOverride: (body: UpdateEnvConfigOverrideRequest) =>
    apiPost("/api/v1/admin/runtime-hosts/update-env-config", body),

  /** admin: 触发 runtime 重新检测本机 CLI 环境。 */
  detectEnv: (id: string) =>
    apiPost<DetectEnvResponse>("/api/v1/admin/runtime-hosts/detect-env", { id }),

  /** admin: 一键安装 runtime 独立 CLI（仅支持 native runtimeType）。 */
  installCli: (body: InstallCliRequest) =>
    apiPost<DetectEnvResponse>("/api/v1/admin/runtime-hosts/install-cli", body),

  /** 列出某个 runtime 上 path 下的子目录（不含文件）。 */
  listDirectory: (params: ListHostDirectoryRequest) => {
    const query = new URLSearchParams({ runtimeHostId: params.runtimeHostId });
    if (params.path) query.set("path", params.path);
    return apiGet<HostDirectoryResponse>(
      `/api/v1/runtime-hosts/directories/list?${query.toString()}`
    );
  },

  /** 在某个 runtime 上新建目录。 */
  createDirectory: (body: CreateHostDirectoryRequest) =>
    apiPost<CreateHostDirectoryResponse>(
      "/api/v1/runtime-hosts/directories/create",
      body
    ),
};

// ── worker 子资源(admin 诊断面:host 上的 worker 现场)─────────────────

export type { WorkerSnapshot };

/** live workers 列表响应（无分页，现场快照）。 */
export interface LiveWorkerListResponse {
  list: WorkerSnapshot[];
}

export const workerApi = {
  /** 现场查询所有 Host（builtin + registered）的 worker 快照。 */
  list: () =>
    apiGet<LiveWorkerListResponse>("/api/v1/admin/runtime-hosts/workers/list"),
  /** 定向停止 worker:runtimeHostId 选 Host,workerId 定位其上的 worker。 */
  stopWorker: (input: { runtimeHostId: string; workerId: string }) =>
    apiPost<{ ok: boolean }>("/api/v1/admin/runtime-hosts/workers/stop", input),
};
