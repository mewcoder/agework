import { useState } from "react";
import type { RuntimeTarget } from "@/api/runtime";
import { useRuntimeResources, useStopRuntimeResource } from "@/hooks/runtime-hooks";
import {
  DataTable,
  DataTableActions,
  DataTableBadge,
  DataTableButton,
  DataTableText,
  type DataTableColumnDef,
} from "@/components/data-table";
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { useBooleanConfirmDelete } from "@/hooks/use-confirm-delete";
import { usePagination } from "@/hooks/use-pagination";
import { PaginationBar } from "@/components/pagination-bar";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDateTime } from "@/utils/format";

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "全部状态" },
  { value: "running", label: "运行中" },
  { value: "stopped", label: "已停止" },
];

function statusLabel(status: string) {
  return STATUS_OPTIONS.find((o) => o.value === status)?.label ?? status;
}

function statusVariant(status: string) {
  if (status === "running") return "default" as const;
  if (status === "stopped") return "secondary" as const;
  return "outline" as const;
}

export function WorkspaceRuntimesPanel({ showHeader = true }: { showHeader?: boolean }) {
  const [status, setStatus] = useState<string>("all");
  const [stoppingId, setStoppingId] = useState<string | null>(null);
  const stopDialog = useBooleanConfirmDelete();
  const [pendingStopId, setPendingStopId] = useState<string | null>(null);
  const { pageNo, setPageNo, pageSize, goPrev, goNext } = usePagination();

  const { data, isLoading } = useRuntimeResources(
    status === "all" ? undefined : status,
    pageNo,
    pageSize,
  );
  const stopMutation = useStopRuntimeResource();

  const items = data?.list ?? [];
  const total = data?.total ?? 0;

  function handleStop(id: string) {
    setPendingStopId(id);
    stopDialog.open();
  }

  async function confirmStop() {
    if (!pendingStopId) return;
    setStoppingId(pendingStopId);
    stopDialog.close();
    try {
      await stopMutation.mutateAsync(pendingStopId);
    } finally {
      setStoppingId(null);
      setPendingStopId(null);
    }
  }

  const columns: DataTableColumnDef<RuntimeTarget>[] = [
    {
      id: "isolationScope",
      header: "隔离级别",
      meta: { headerClassName: "pl-4", cellClassName: "pl-4" },
      cell: ({ row }) => (
        <DataTableBadge variant="outline">{row.original.isolationScope}</DataTableBadge>
      ),
    },
    {
      id: "owner",
      header: "所有者",
      cell: ({ row }) => (
        <DataTableText
          className="max-w-[200px]"
          title={row.original.ownerId}
        >
          {row.original.ownerId}
        </DataTableText>
      ),
    },
    {
      id: "runtimeType",
      header: "类型",
      cell: ({ row }) => (
        <DataTableBadge variant="outline">{row.original.runtimeType}</DataTableBadge>
      ),
    },
    {
      id: "workspaceCount",
      header: "关联工作空间",
      cell: ({ row }) => (
        <DataTableText>{row.original.workspaceRuntimes?.length ?? 0}</DataTableText>
      ),
    },
    {
      id: "status",
      header: "状态",
      cell: ({ row }) => (
        <DataTableBadge variant={statusVariant(row.original.status)}>
          {statusLabel(row.original.status)}
        </DataTableBadge>
      ),
    },
    {
      id: "createdAt",
      header: "创建时间",
      cell: ({ row }) => <DataTableText>{formatDateTime(row.original.createdAt)}</DataTableText>,
    },
    {
      id: "updatedAt",
      header: "更新时间",
      cell: ({ row }) => <DataTableText>{formatDateTime(row.original.updatedAt)}</DataTableText>,
    },
    {
      id: "actions",
      header: "操作",
      meta: { headerClassName: "pr-4 text-right", cellClassName: "pr-4 text-right" },
      cell: ({ row }) => (
        <DataTableActions>
          {row.original.status === "running" && (
            <DataTableButton
              disabled={stoppingId === row.original.id}
              onClick={() => handleStop(row.original.id)}
            >
              {stoppingId === row.original.id ? "停止中…" : "停止"}
            </DataTableButton>
          )}
        </DataTableActions>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      {showHeader && (
        <div>
          <h2 className="text-lg font-semibold">执行环境管理</h2>
          <p className="text-sm text-muted-foreground mt-0.5">查看和管理工作空间执行环境资源</p>
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <Select
          value={status}
          onValueChange={(value) => {
            setStatus(value ?? "all");
            setPageNo(1);
          }}
        >
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {STATUS_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      <DataTable
        columns={columns}
        data={items}
        isLoading={isLoading}
        emptyText="暂无执行环境资源"
        tableClassName="min-w-[960px]"
        getRowId={(resource) => resource.id}
      />

      <PaginationBar
        pageNo={pageNo}
        pageSize={pageSize}
        total={total}
        onPrev={() => goPrev()}
        onNext={() => goNext(total)}
      />

      <ConfirmDeleteDialog
        open={stopDialog.isOpen}
        onOpenChange={(open) => {
          if (!open) stopDialog.close();
        }}
        onConfirm={confirmStop}
        title="确认停止执行环境？"
        description="确定要停止此执行环境资源吗？停止后需要重新启动才能使用。"
        confirmLabel="停止"
      />
    </div>
  );
}
