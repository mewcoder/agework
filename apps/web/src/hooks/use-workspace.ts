import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { workspacesApi } from '@/api/workspaces';
import { conversationKeys } from '@/lib/conversations-cache';
import type { UpdateWorkspaceInput } from '@/api/workspaces';
import type { CreateWorkspaceRequest } from '@agework/shared/api';
export type { Workspace, WorkspaceWithUser } from '@/api/workspaces';

/** workspace 相关 react-query 键的唯一 factory:define 与 invalidate 共用,不再各写一遍数组字面量。 */
const workspaceKeys = {
  all: ['workspaces'] as const,
  capabilities: ['workspaces', 'capabilities'] as const,
  files: (id: string | undefined, path: string) => ['workspace-files', id, path],
  filesRoot: (id: string | undefined) => ['workspace-files', id],
  file: (id: string | undefined, path: string | undefined) => ['workspace-file', id, path],
  fileRoot: (id: string | undefined) => ['workspace-file', id],
  changes: (id: string | undefined) => ['workspace-changes', id],
  diff: (id: string | undefined, path: string | undefined) => ['workspace-file-diff', id, path],
  diffRoot: (id: string | undefined) => ['workspace-file-diff', id],
};

export function useWorkspaces() {
  return useQuery({
    queryKey: workspaceKeys.all,
    queryFn: () => workspacesApi.list(),
    select: (data) => data.list,
  });
}

export function useWorkspaceCapabilities() {
  return useQuery({
    queryKey: workspaceKeys.capabilities,
    queryFn: () => workspacesApi.capabilities(),
  });
}

export function useCreateWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (data: CreateWorkspaceRequest) => workspacesApi.create(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: workspaceKeys.all }),
  });
}

export function useRenameWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: ({ id, ...data }: { id: string } & UpdateWorkspaceInput) =>
      workspacesApi.rename(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: workspaceKeys.all }),
  });
}

export function useDeleteWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => workspacesApi.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: workspaceKeys.all });
      qc.invalidateQueries({ queryKey: conversationKeys.all });
    },
  });
}

/** 纯浏览器场景下,让 server(和浏览器同一台机器时)用系统文件管理器打开工作空间根目录。 */
export function useOpenWorkspaceInFileManager() {
  return useMutation({
    mutationFn: (id: string) => workspacesApi.openInFileManager(id),
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
    queryKey: workspaceKeys.files(workspaceId, path),
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
    queryKey: workspaceKeys.file(workspaceId, path),
    queryFn: () => workspacesApi.readFile(workspaceId!, path!),
    enabled: !!workspaceId && !!path,
    retry: false,
  });
}

/** 刷新文件树和当前打开文件。 */
export function useRefreshWorkspaceFiles(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: workspaceKeys.filesRoot(workspaceId) });
    qc.invalidateQueries({ queryKey: workspaceKeys.fileRoot(workspaceId) });
  };
}

// ── 变更查看(diff) ──

/** 列出工作区未提交变更(仅本地 git 仓库,非 local/非 git 由接口返回 400)。 */
export function useWorkspaceChanges(
  workspaceId: string | undefined,
  enabled: boolean,
) {
  return useQuery({
    queryKey: workspaceKeys.changes(workspaceId),
    queryFn: () => workspacesApi.listChangedFiles(workspaceId!),
    enabled: !!workspaceId && enabled,
    retry: false,
  });
}

/** 读取单个文件的 before/after 用于行级 diff(选中文件时才 enabled)。 */
export function useWorkspaceFileDiff(
  workspaceId: string | undefined,
  path: string | undefined,
) {
  return useQuery({
    queryKey: workspaceKeys.diff(workspaceId, path),
    queryFn: () => workspacesApi.readFileDiff(workspaceId!, path!),
    enabled: !!workspaceId && !!path,
    retry: false,
  });
}

/** 刷新变更列表与已打开的 diff。 */
export function useRefreshWorkspaceChanges(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: workspaceKeys.changes(workspaceId) });
    qc.invalidateQueries({ queryKey: workspaceKeys.diffRoot(workspaceId) });
  };
}
