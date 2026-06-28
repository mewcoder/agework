import { useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import {
  DataTable,
  DataTableActionButton,
  DataTableActions,
  DataTableButton,
  DataTableText,
  type DataTableColumnDef,
} from "@/components/data-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmDeleteDialog, useBooleanConfirmDelete } from "@/components/confirm-delete-dialog";
import {
  useConversations,
  useUnarchiveConversation,
  useDeleteConversation,
  useClearArchived,
  type Conversation,
} from "@/hooks/use-conversation";
import { useWorkspaces } from "@/hooks/use-workspace";
import { formatDateTime } from "@/utils/format";
import { SettingsPageHeader } from "@/components/settings/settings-panel";

export function ArchivedConversations({ showHeader = true }: { showHeader?: boolean }) {
  // 后端按 status=archived 直接返回，无需前端过滤
  const { data, isLoading } = useConversations("archived");
  const { data: workspaces = [] } = useWorkspaces();
  const unarchive = useUnarchiveConversation();
  const del = useDeleteConversation();
  const clearArchived = useClearArchived();
  const [query, setQuery] = useState("");
  const deleteAllDialog = useBooleanConfirmDelete();

  const archived = useMemo(() => {
    const list = [...(data?.conversations ?? [])].sort(
      (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
    );
    const q = query.trim().toLowerCase();
    return q
      ? list.filter((t) => (t.title ?? "").toLowerCase().includes(q))
      : list;
  }, [data, query]);

  const workspaceName = (id: string) =>
    workspaces.find((p) => p.id === id)?.name ?? id;

  const handleDeleteAll = () => {
    clearArchived.mutate();
    deleteAllDialog.close();
  };

  const columns: DataTableColumnDef<Conversation>[] = [
    {
      id: "title",
      header: "对话",
      meta: { headerClassName: "pl-4", cellClassName: "pl-4" },
      cell: ({ row }) => (
        <DataTableText className="max-w-[320px] font-medium">
          {row.original.title ?? "New Chat"}
        </DataTableText>
      ),
    },
    {
      id: "workspace",
      header: "工作空间",
      cell: ({ row }) => (
        <DataTableText className="max-w-[220px]">
          {workspaceName(row.original.workspaceId)}
        </DataTableText>
      ),
    },
    {
      id: "updatedAt",
      header: "归档时间",
      cell: ({ row }) => <DataTableText>{formatDateTime(row.original.updatedAt)}</DataTableText>,
    },
    {
      id: "actions",
      header: "操作",
      meta: { headerClassName: "pr-4 text-right", cellClassName: "pr-4 text-right" },
      cell: ({ row }) => (
        <DataTableActions>
          <DataTableButton
            onClick={() => unarchive.mutate(row.original.conversationId)}
          >
            取消归档
          </DataTableButton>
          <DataTableActionButton
            tone="destructive"
            aria-label="删除"
            onClick={() => del.mutate(row.original.conversationId)}
          >
            <Trash2 />
          </DataTableActionButton>
        </DataTableActions>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      {showHeader && (
        <SettingsPageHeader
          title="已归档对话"
          description="查看和恢复已归档的对话"
        />
      )}

      <div className="flex justify-end">
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <Button
            variant="destructive"
            disabled={archived.length === 0}
            onClick={() => deleteAllDialog.open()}
          >
            删除所有
          </Button>
          <Input
            placeholder="搜索已归档对话"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8 min-w-0 flex-1 sm:w-80"
          />
        </div>
      </div>

      <DataTable
        columns={columns}
        data={archived}
        isLoading={isLoading}
        emptyText={query ? "没有匹配的已归档对话" : "暂无已归档对话"}
        tableClassName="min-w-[680px]"
        wrapperClassName="max-h-[calc(100vh-320px)] overflow-auto rounded-lg border overscroll-contain"
        getRowId={(conversation) => conversation.conversationId}
      />

      <ConfirmDeleteDialog
        open={deleteAllDialog.isOpen}
        onOpenChange={(open) => {
          if (!open) deleteAllDialog.close();
        }}
        onConfirm={handleDeleteAll}
        title="确认删除全部已归档对话？"
        description={`将永久删除 ${archived.length} 个已归档对话，此操作不可撤销`}
        confirmLabel="全部删除"
      />
    </div>
  );
}
