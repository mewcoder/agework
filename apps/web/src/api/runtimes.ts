import { apiGet, apiPost } from '@/lib/http';
import type {
  CreateRuntimeDirectoryRequest,
  CreateRuntimeDirectoryResponse,
  CreateRuntimeRequest,
  CreateRuntimeResponse,
  DetectEnvResponse,
  InstallCliRequest,
  ListRuntimeDirectoryRequest,
  RuntimeDirectoryResponse,
  RuntimeResponse,
  UpdateEnvConfigOverrideRequest,
} from '@agework/shared/api';

export type { RuntimeResponse as Runtime };
export type { CreateRuntimeResponse };

export const runtimesApi = {
  list: () => apiGet<{ list: RuntimeResponse[] }>('/api/v1/runtimes/list'),

  /** admin: 列出全部 Runtime（managed + 所有用户的 registered）。 */
  adminList: () =>
    apiGet<{ list: RuntimeResponse[] }>('/api/v1/admin/runtimes/list'),

  create: (body: CreateRuntimeRequest) =>
    apiPost<CreateRuntimeResponse>('/api/v1/runtimes/create', body),

  delete: (id: string) => apiPost('/api/v1/runtimes/delete', { id }),

  /** admin: 覆盖 runtime 的 CLI 路径（per-agent）。 */
  updateEnvConfigOverride: (body: UpdateEnvConfigOverrideRequest) =>
    apiPost('/api/v1/admin/runtimes/env-config', body),

  /** admin: 触发 runtime 重新检测本机 CLI 环境。 */
  detectEnv: (id: string) =>
    apiPost<DetectEnvResponse>('/api/v1/admin/runtimes/detect-env', { id }),

  /** admin: 一键安装 runtime 独立 CLI（仅支持 local runtime）。 */
  installCli: (body: InstallCliRequest) =>
    apiPost<DetectEnvResponse>('/api/v1/admin/runtimes/install-cli', body),

  /** 列出某个 runtime 上 path 下的子目录（不含文件）。 */
  listDirectory: (params: ListRuntimeDirectoryRequest) => {
    const query = new URLSearchParams({ runtimeId: params.runtimeId });
    if (params.path) query.set('path', params.path);
    return apiGet<RuntimeDirectoryResponse>(
      `/api/v1/runtimes/directories/list?${query.toString()}`
    );
  },

  /** 在某个 runtime 上新建目录。 */
  createDirectory: (body: CreateRuntimeDirectoryRequest) =>
    apiPost<CreateRuntimeDirectoryResponse>(
      '/api/v1/runtimes/directories/create',
      body
    ),
};
