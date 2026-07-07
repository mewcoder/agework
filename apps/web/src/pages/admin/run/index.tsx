import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CircleAlertIcon, EyeIcon } from "lucide-react";
import {
  runsApi,
  type AdminRun,
  type RunStatus,
} from "@/api/runs";
import {
  DataTable,
  DataTableBadge,
  DataTableButton,
  DataTableEmpty,
  DataTableText,
  type DataTableColumnDef,
} from "@/components/data-table";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatDateTime } from "@/utils/format";
import { usePagination } from "@/hooks/use-pagination";
import { PaginationBar } from "@/components/pagination-bar";
import { STATUS_OPTIONS, statusLabel, statusVariant } from "./run-status";
import { RunDetailSheet } from "./run-detail-sheet";

export function RunPanel({ showHeader = true }: { showHeader?: boolean }) {
  const [status, setStatus] = useState<RunStatus | "all">("all");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const { pageNo, pageSize, goPrev, goNext, setPageNo } = usePagination();

  const { data, isLoading } = useQuery({
    queryKey: ["admin", "runs", status, pageNo],
    queryFn: () =>
      runsApi.adminList({
        status: status === "all" ? undefined : status,
        pageNo,
        pageSize,
      }),
  });

  const items: AdminRun[] = data?.list ?? [];
  const total = data?.total ?? 0;

  const columns: DataTableColumnDef<AdminRun>[] = [
    {
      id: "conversation",
      header: "对话",
      meta: { headerClassName: "pl-4", cellClassName: "pl-4" },
      cell: ({ row }) => {
        const run = row.original;

        return (
          <DataTableText
            className="font-medium"
            title={run.conversationTitle ?? run.conversationId}
          >
            {run.conversationTitle || run.conversationId}
          </DataTableText>
        );
      },
    },
    {
      id: "user",
      header: "用户",
      cell: ({ row }) =>
        row.original.username ? (
          <DataTableText>{row.original.username}</DataTableText>
        ) : (
          <DataTableEmpty />
        ),
    },
    {
      id: "agent",
      header: "Agent",
      cell: ({ row }) => <DataTableText>{row.original.agentType}</DataTableText>,
    },
    {
      id: "status",
      header: "状态",
      cell: ({ row }) => {
        const run = row.original;

        return run.error ? (
          <Tooltip>
            <TooltipTrigger render={
              <DataTableBadge
                variant={statusVariant(run.status)}
                className="cursor-default gap-1"
              >
                <CircleAlertIcon />
                {statusLabel(run.status)}
              </DataTableBadge>
            } />
            <TooltipContent className="max-w-xs whitespace-pre-wrap">
              {run.error}
            </TooltipContent>
          </Tooltip>
        ) : (
          <DataTableBadge variant={statusVariant(run.status)}>
            {statusLabel(run.status)}
          </DataTableBadge>
        );
      },
    },
    {
      id: "finishedAt",
      header: "结束时间",
      cell: ({ row }) => <DataTableText>{formatDateTime(row.original.finishedAt)}</DataTableText>,
    },
    {
      id: "actions",
      header: "操作",
      meta: { headerClassName: "pr-4 text-right", cellClassName: "pr-4 text-right" },
      cell: ({ row }) => (
        <DataTableButton
          variant="ghost"
          onClick={() => setSelectedRunId(row.original.id)}
        >
          <EyeIcon data-icon="inline-start" />
          详情
        </DataTableButton>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      {showHeader && (
        <div>
          <h2 className="text-lg font-semibold">运行记录</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            查看所有用户的 Agent 运行记录
          </p>
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <Select
          value={status}
          onValueChange={(value) => {
            setStatus(value as RunStatus | "all");
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
        emptyText="暂无运行记录"
        getRowId={(run) => run.id}
      />

      <PaginationBar
        pageNo={pageNo}
        pageSize={pageSize}
        total={total}
        onPrev={() => goPrev()}
        onNext={() => goNext(total)}
      />

      <RunDetailSheet
        runId={selectedRunId}
        open={selectedRunId !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedRunId(null);
        }}
      />
    </div>
  );
}
