import { apiGet, apiPost } from '@/lib/http';
import type {
  CreateRuntimeRequest,
  CreateRuntimeResponse,
  DetectEnvResponse,
  RuntimeResponse,
  UpdateEnvConfigOverrideRequest,
} from '@agework/shared/api';

export type { RuntimeResponse as Runtime };
export type { CreateRuntimeResponse };

export const runtimesApi = {
  list: () => apiGet<{ list: RuntimeResponse[] }>('/api/v1/runtimes/list'),

  /** admin: 列出全部 Runtime（builtin + 所有用户的 registered）。 */
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
};
