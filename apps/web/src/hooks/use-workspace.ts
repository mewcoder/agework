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

// ── 文件预览 ──

/** 列出一层目录(懒加载,展开时 enabled 才为 true)。 */
export function useWorkspaceFiles(
  workspaceId: string | undefined,
  path: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ['workspace-files', workspaceId, path],
    queryFn: () => workspacesApi.listFiles(workspaceId!, path),
    enabled: !!workspaceId && enabled,
    retry: false,
  });
}

/** 读取文件内容。 */
export function useWorkspaceFileContent(
  workspaceId: string | undefined,
  path: string | undefined,
) {
  return useQuery({
    queryKey: ['workspace-file', workspaceId, path],
    queryFn: () => workspacesApi.readFile(workspaceId!, path!),
    enabled: !!workspaceId && !!path,
    retry: false,
  });
}

/** 刷新文件树和当前打开文件。 */
export function useRefreshWorkspaceFiles(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['workspace-files', workspaceId] });
    qc.invalidateQueries({ queryKey: ['workspace-file', workspaceId] });
  };
}
