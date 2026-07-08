import { apiGet, apiPost } from '@/lib/http';
import type {
  AdminWorkspaceResponse,
  AdminWorkspaceListResponse,
  CreateWorkspaceRequest,
  WorkspaceCapabilitiesResponse,
  WorkspaceResponse,
  WorkspaceListResponse,
  WorkspaceGitBranchListResponse,
  UpdateWorkspaceRequest,
  WorkspaceFileListResponse,
  WorkspaceFileReadResponse,
  WorkspaceChangedFilesResponse,
  WorkspaceFileDiffResponse,
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

  listGitBranches: (gitUrl: string) =>
    apiGet<WorkspaceGitBranchListResponse>(
      `/api/v1/workspaces/git-branches/list?gitUrl=${encodeURIComponent(gitUrl)}`,
    ),

  rename: (id: string, data: UpdateWorkspaceInput) =>
    apiPost<WorkspaceResponse>('/api/v1/workspaces/update', { id, ...data }),

  delete: (id: string) =>
    apiPost('/api/v1/workspaces/remove', { id }),

  listFiles: (id: string, path: string) => {
    const params = new URLSearchParams({ id });
    if (path) params.set('path', path);
    return apiGet<WorkspaceFileListResponse>(`/api/v1/workspaces/files/list?${params.toString()}`);
  },

  readFile: (id: string, path: string) => {
    const params = new URLSearchParams({ id, path });
    return apiGet<WorkspaceFileReadResponse>(`/api/v1/workspaces/files/read?${params.toString()}`);
  },

  listChangedFiles: (id: string) =>
    apiGet<WorkspaceChangedFilesResponse>(
      `/api/v1/workspaces/files/changes?id=${encodeURIComponent(id)}`,
    ),

  readFileDiff: (id: string, path: string) => {
    const params = new URLSearchParams({ id, path });
    return apiGet<WorkspaceFileDiffResponse>(`/api/v1/workspaces/files/diff?${params.toString()}`);
  },
};
