import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { workspacesApi } from '@/api/workspaces';
import type { UpdateWorkspaceInput } from '@/api/workspaces';
import type { CreateWorkspaceRequest } from '@agework/shared/api';
export type { Workspace, WorkspaceWithUser } from '@/api/workspaces';

export function useWorkspaces() {
  return useQuery({
    queryKey: ['workspaces'],
    queryFn: () => workspacesApi.list(),
    select: (data) => data.list,
  });
}

export function useWorkspaceCapabilities() {
  return useQuery({
    queryKey: ['workspaces', 'capabilities'],
    queryFn: () => workspacesApi.capabilities(),
  });
}

export function useCreateWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (data: CreateWorkspaceRequest) => workspacesApi.create(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workspaces'] }),
  });
}

export function useRenameWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: ({ id, ...data }: { id: string } & UpdateWorkspaceInput) =>
      workspacesApi.rename(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workspaces'] }),
  });
}

export function useDeleteWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => workspacesApi.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workspaces'] });
      qc.invalidateQueries({ queryKey: ['conversations'] });
    },
  });
}
