import { useMemo, useState } from "react";
import type { WorkerSnapshot } from "@/api/runtime-hosts";
import { useWorkers, useStopWorker } from "@/hooks/use-runtime-host";
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
  { value: "starting", label: "启动中" },
  { value: "ready", label: "就绪" },
];

function statusLabel(status: string) {
  return STATUS_OPTIONS.find((o) => o.value === status)?.label ?? status;
}

function statusVariant(status: string) {
  if (status === "ready") return "default" as const;
  if (status === "starting") return "secondary" as const;
  return "outline" as const;
}

/** 同名 workerId 可能出现在不同 Host 上,行标识必须带 Host。 */
function workerRowId(worker: WorkerSnapshot) {
  return `${worker.runtimeHostId}:${worker.workerId}`;
}

export function WorkerPanel({ showHeader = true }: { showHeader?: boolean }) {
  const [status, setStatus] = useState<string>("all");
  const [stoppingId, setStoppingId] = useState<string | null>(null);
  const stopDialog = useBooleanConfirmDelete();
  const [pendingStop, setPendingStop] = useState<WorkerSnapshot | null>(null);
  const { pageNo, setPageNo, pageSize, goPrev, goNext } = usePagination();

  const { data, isLoading } = useWorkers();
  const stopMutation = useStopWorker();

  // 客户端筛选 + 分页（live 数据无服务端分页）
  const filtered = useMemo(() => {
    const all = data?.list ?? [];
    if (status === "all") return all;
    return all.filter((w) => w.status === status);
  }, [data, status]);

  const total = filtered.length;
  const items = useMemo(() => {
    const start = (pageNo - 1) * pageSize;
    return filtered.slice(start, start + pageSize);
  }, [filtered, pageNo, pageSize]);

  function handleStop(worker: WorkerSnapshot) {
    setPendingStop(worker);
    stopDialog.open();
  }

  async function confirmStop() {
    if (!pendingStop) return;
    setStoppingId(workerRowId(pendingStop));
    stopDialog.close();
    try {
      await stopMutation.mutateAsync({
        runtimeHostId: pendingStop.runtimeHostId,
        workerId: pendingStop.workerId,
      });
    } finally {
      setStoppingId(null);
      setPendingStop(null);
    }
  }

  const columns: DataTableColumnDef<WorkerSnapshot>[] = [
    {
      id: "scope",
      header: "运行范围",
      meta: { headerClassName: "pl-4", cellClassName: "pl-4" },
      cell: ({ row }) => (
        <DataTableBadge variant="outline">
          {row.original.runtimeType === "native" ? "host" : row.original.isolation.scope}
        </DataTableBadge>
      ),
    },
    {
      id: "subject",
      header: "隔离主体",
      cell: ({ row }) => (
        <DataTableText className="max-w-[200px]" title={row.original.isolation.subjectId}>
          {row.original.isolation.subjectId}
        </DataTableText>
      ),
    },
    {
      id: "runtimeType",
      header: "类型",
      cell: ({ row }) => (
        <DataTableBadge variant="outline">
          {row.original.runtimeType}
        </DataTableBadge>
      ),
    },
    {
      id: "runtimeHost",
      header: "Host",
      cell: ({ row }) => (
        <DataTableText
          className="max-w-[200px]"
          title={row.original.runtimeHostId}
        >
          {row.original.runtimeHostId}
        </DataTableText>
      ),
    },
    {
      id: "activeRuns",
      header: "活跃 Run",
      cell: ({ row }) => (
        <DataTableText>{row.original.runIds.length}</DataTableText>
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
      id: "lastSeenAt",
      header: "最后心跳",
      cell: ({ row }) => (
        <DataTableText>{formatDateTime(row.original.lastSeenAt)}</DataTableText>
      ),
    },
    {
      id: "actions",
      header: "操作",
      meta: {
        headerClassName: "pr-4 text-right",
        cellClassName: "pr-4 text-right",
      },
      cell: ({ row }) => (
        <DataTableActions>
          <DataTableButton
            disabled={stoppingId === workerRowId(row.original)}
            onClick={() => handleStop(row.original)}
          >
            {stoppingId === workerRowId(row.original) ? "停止中…" : "停止"}
          </DataTableButton>
        </DataTableActions>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      {showHeader && (
        <div>
          <h2 className="text-lg font-semibold">Worker 管理</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            查看和管理各用户 / 工作空间下常驻的 Worker
          </p>
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <Select
          items={STATUS_OPTIONS}
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
        emptyText="暂无运行中的 Worker"
        tableClassName="min-w-[960px]"
        getRowId={workerRowId}
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
        title="确认停止 Worker？"
        description="确定要停止此 Worker 吗？停止后需要重新启动才能使用。"
        confirmLabel="停止"
      />
    </div>
  );
}
