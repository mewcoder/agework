import { apiGet, apiPost } from '@/lib/http';
import type {
  AdminWorkspaceResponse,
  AdminWorkspaceListResponse,
  CreateWorkspaceRequest,
  WorkspaceCapabilitiesResponse,
  WorkspaceResponse,
  WorkspaceListResponse,
  UpdateWorkspaceRequest,
} from '@agework/shared/api';

export type { WorkspaceResponse as Workspace };
export type { AdminWorkspaceResponse as WorkspaceWithUser };
export type UpdateWorkspaceInput = Omit<UpdateWorkspaceRequest, 'id'>;

export const workspacesApi = {
  list: () => apiGet<WorkspaceListResponse>('/api/v1/workspaces/list'),

  capabilities: () =>
    apiGet<WorkspaceCapabilitiesResponse>('/api/v1/workspaces/capabilities'),

  all: (params?: { pageNo?: number; pageSize?: number }) => {
    const query = new URLSearchParams();
    if (params?.pageNo) query.set('pageNo', String(params.pageNo));
    if (params?.pageSize) query.set('pageSize', String(params.pageSize));
    const qs = query.toString();
    return apiGet<AdminWorkspaceListResponse>(`/api/v1/admin/workspaces/list${qs ? `?${qs}` : ''}`);
  },

  create: (body: CreateWorkspaceRequest) =>
    apiPost<WorkspaceResponse>('/api/v1/workspaces/create', body),

  rename: (id: string, data: UpdateWorkspaceInput) =>
    apiPost<WorkspaceResponse>('/api/v1/workspaces/update', { id, ...data }),

  delete: (id: string) =>
    apiPost('/api/v1/workspaces/remove', { id }),
};
