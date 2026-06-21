import { useMemo } from 'react';
import { PencilIcon, Trash2 } from 'lucide-react';
import { WorkspaceDialog } from '@/components/workspace-dialog';
import { ConfirmDeleteDialog, useConfirmDelete } from '@/components/confirm-delete-dialog';
import { useFormDialog } from '@/hooks/use-form-dialog';
import {
  DataTable,
  DataTableActionButton,
  DataTableActions,
  DataTableEmpty,
  DataTableText,
  type DataTableColumnDef,
} from '@/components/data-table';
import {
  useDeleteWorkspace,
  useWorkspaces,
  type Workspace,
} from '@/hooks/use-workspaces';
import { useConversations } from '@/hooks/use-conversations';
import { formatDateTime } from '@/utils/format';
import { SettingsPageHeader } from '@/components/settings/settings-panel';

export function WorkspaceSettings() {
  const { data: workspaces = [], isLoading } = useWorkspaces();
  const { data: conversationsData, isLoading: isConversationsLoading } = useConversations();
  const removeWorkspace = useDeleteWorkspace();
  const formDialog = useFormDialog<Workspace>();
  const deleteDialog = useConfirmDelete<Workspace>();
  const conversationCountsByWorkspace = useMemo(() => {
    const counts = new Map<string, number>();
    for (const conversation of conversationsData?.conversations ?? []) {
      counts.set(conversation.workspaceId, (counts.get(conversation.workspaceId) ?? 0) + 1);
    }
    return counts;
  }, [conversationsData?.conversations]);

  const columns: DataTableColumnDef<Workspace>[] = [
    {
      id: 'name',
      header: '名称',
      meta: { headerClassName: 'pl-4', cellClassName: 'pl-4' },
      cell: ({ row }) => (
        <DataTableText className="font-medium">{row.original.name}</DataTableText>
      ),
    },
    {
      id: 'description',
      header: '描述',
      cell: ({ row }) =>
        row.original.description ? (
          <DataTableText
            className="max-w-[260px]"
            title={row.original.description}
          >
            {row.original.description}
          </DataTableText>
        ) : (
          <DataTableEmpty />
        ),
    },
    {
      id: 'gitUrl',
      header: 'Git 信息',
      cell: ({ row }) =>
        row.original.gitUrl ? (
          <DataTableText
            className="max-w-[260px]"
            title={row.original.gitUrl}
          >
            {row.original.gitUrl}
          </DataTableText>
        ) : (
          <DataTableEmpty />
        ),
    },
    {
      id: 'conversationCount',
      header: '对话数量',
      cell: ({ row }) => (
        <DataTableText>
          {isConversationsLoading
            ? '…'
            : (conversationCountsByWorkspace.get(row.original.id) ?? 0)}
        </DataTableText>
      ),
    },
    {
      id: 'createdAt',
      header: '创建时间',
      cell: ({ row }) => <DataTableText>{formatDateTime(row.original.createdAt)}</DataTableText>,
    },
    {
      id: 'actions',
      header: '操作',
      meta: { headerClassName: 'pr-4 text-right', cellClassName: 'pr-4 text-right' },
      cell: ({ row }) => (
        <DataTableActions>
          <DataTableActionButton
            aria-label={`编辑工作空间 ${row.original.name}`}
            onClick={() => formDialog.openEdit(row.original)}
          >
            <PencilIcon />
          </DataTableActionButton>
          <DataTableActionButton
            tone="destructive"
            aria-label={`移除工作空间 ${row.original.name}`}
            onClick={() => deleteDialog.requestDelete(row.original)}
          >
            <Trash2 />
          </DataTableActionButton>
        </DataTableActions>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <SettingsPageHeader
        title="工作空间"
        description="查看当前账号创建的所有工作空间"
      />

      <DataTable
        columns={columns}
        data={workspaces}
        isLoading={isLoading}
        emptyText="暂无工作空间"
        tableClassName="min-w-[760px]"
        wrapperClassName="max-h-[calc(100vh-280px)] overflow-auto rounded-lg border overscroll-contain"
        getRowId={(workspace) => workspace.id}
      />

      <WorkspaceDialog
        open={formDialog.open}
        onOpenChange={formDialog.onOpenChange}
        workspace={formDialog.target}
        submitLabel="保存"
      />

      <ConfirmDeleteDialog
        open={deleteDialog.isOpen}
        onOpenChange={deleteDialog.onOpenChange}
        onConfirm={() => {
          if (!deleteDialog.target) return;
          removeWorkspace.mutate(deleteDialog.target.id, {
            onSuccess: () => deleteDialog.cancelDelete(),
          });
        }}
        isPending={removeWorkspace.isPending}
        title="确认移除工作空间？"
        targetName={deleteDialog.target?.name}
        description={deleteDialog.target ? `将移除工作空间「${deleteDialog.target.name}」及其所有对话，此操作不可撤销` : undefined}
        confirmLabel="移除"
        pendingLabel="移除中…"
      />
    </div>
  );
}
