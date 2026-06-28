import { useQuery } from "@tanstack/react-query";
import { workspacesApi, type WorkspaceWithUser } from "@/api/workspaces";
import {
  DataTable,
  DataTableBadge,
  DataTableEmpty,
  DataTableText,
  type DataTableColumnDef,
} from "@/components/data-table";
import { usePagination } from "@/hooks/use-pagination";
import { PaginationBar } from "@/components/pagination-bar";
import { formatDateTime } from "@/utils/format";

export function WorkspacesPanel({
  showHeader = true,
}: {
  showHeader?: boolean;
}) {
  const { pageNo, pageSize, goPrev, goNext } = usePagination();

  const { data, isLoading } = useQuery({
    queryKey: ["admin", "workspaces", pageNo],
    queryFn: () => workspacesApi.all({ pageNo, pageSize }),
  });

  const workspaces = data?.list ?? [];
  const total = data?.total ?? 0;

  const columns: DataTableColumnDef<WorkspaceWithUser>[] = [
    {
      id: "name",
      header: "名称",
      meta: { headerClassName: "pl-4", cellClassName: "pl-4" },
      cell: ({ row }) => (
        <DataTableText className="font-medium">{row.original.name}</DataTableText>
      ),
    },
    {
      id: "owner",
      header: "所属用户",
      cell: ({ row }) =>
        row.original.user?.username ? (
          <DataTableText>{row.original.user.username}</DataTableText>
        ) : (
          <DataTableEmpty>未归属</DataTableEmpty>
        ),
    },
    {
      id: "status",
      header: "状态",
      cell: ({ row }) => (
        <DataTableBadge variant={row.original.directoryStatus === "ready" ? "secondary" : "destructive"}>
          {row.original.directoryStatus === "ready" ? "正常" : row.original.directoryStatus}
        </DataTableBadge>
      ),
    },
    {
      id: "description",
      header: "描述",
      cell: ({ row }) =>
        row.original.description ? (
          <DataTableText className="max-w-[260px]" title={row.original.description}>
            {row.original.description}
          </DataTableText>
        ) : (
          <DataTableEmpty />
        ),
    },
    {
      id: "gitUrl",
      header: "Git 信息",
      cell: ({ row }) =>
        row.original.gitUrl ? (
          <DataTableText className="max-w-[260px]" title={row.original.gitUrl}>
            {row.original.gitUrl}
          </DataTableText>
        ) : (
          <DataTableEmpty />
        ),
    },
    {
      id: "rootPath",
      header: "工作目录",
      cell: ({ row }) => (
        <DataTableText className="max-w-[220px]" title={row.original.rootPath}>
          {row.original.rootPath}
        </DataTableText>
      ),
    },
    {
      id: "conversationCount",
      header: "对话数",
      cell: ({ row }) => <DataTableText>{row.original.conversationCount ?? 0}</DataTableText>,
    },
    {
      id: "updatedAt",
      header: "更新时间",
      meta: { headerClassName: "pr-4", cellClassName: "pr-4" },
      cell: ({ row }) => <DataTableText>{formatDateTime(row.original.updatedAt)}</DataTableText>,
    },
  ];

  return (
    <div className="space-y-4">
      {showHeader && (
        <div>
          <h2 className="text-lg font-semibold">工作空间总览</h2>
          <p className="text-sm text-muted-foreground mt-0.5">查看所有用户的工作空间</p>
        </div>
      )}

      <DataTable
        columns={columns}
        data={workspaces}
        isLoading={isLoading}
        emptyText="暂无工作空间"
        tableClassName="min-w-[980px]"
        getRowId={(workspace) => workspace.id}
      />

      <PaginationBar
        pageNo={pageNo}
        pageSize={pageSize}
        total={total}
        onPrev={() => goPrev(total)}
        onNext={() => goNext(total)}
      />
    </div>
  );
}
