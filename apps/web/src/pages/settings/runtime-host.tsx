import {
  DataTable,
  DataTableBadge,
  DataTableEmpty,
  DataTableText,
  type DataTableColumnDef,
} from "@/components/data-table";
import { useRuntimeHosts, type RuntimeHost } from "@/hooks/use-runtime-host";
import { SettingsPageHeader } from "@/components/settings/settings-panel";
import { formatDateTime } from "@/utils/format";

function runtimeTypeLabel(runtimeType: string | null) {
  switch (runtimeType) {
    case "native":
      return "本地";
    case "docker":
      return "Docker";
    case "opensandbox":
      return "OpenSandbox";
    default:
      return "待配对";
  }
}

/** 用户侧「运行节点」：纯只读列表，展示当前可用的 RuntimeHost。 */
export function RuntimeHostSettings() {
  const { data: runtimes = [], isLoading } = useRuntimeHosts();

  const columns: DataTableColumnDef<RuntimeHost>[] = [
    {
      id: "name",
      header: "名称",
      meta: { headerClassName: "pl-4", cellClassName: "pl-4" },
      cell: ({ row }) => (
        <DataTableText className="font-medium">
          {row.original.name}
        </DataTableText>
      ),
    },
    {
      id: "runtimeType",
      header: "运行方式",
      cell: ({ row }) => (
        <DataTableText>
          {Object.keys(row.original.capabilities ?? {})
            .map(runtimeTypeLabel)
            .join(" / ") || "待配对"}
        </DataTableText>
      ),
    },
    {
      id: "status",
      header: "状态",
      cell: ({ row }) => (
        <DataTableBadge
          variant={row.original.status === "online" ? "default" : "secondary"}
        >
          {row.original.status === "online" ? "在线" : "离线"}
        </DataTableBadge>
      ),
    },
    {
      id: "lastHeartbeatAt",
      header: "最近心跳",
      cell: ({ row }) =>
        row.original.lastHeartbeatAt ? (
          <DataTableText>
            {formatDateTime(row.original.lastHeartbeatAt)}
          </DataTableText>
        ) : (
          <DataTableEmpty />
        ),
    },
    {
      id: "createdAt",
      header: "创建时间",
      cell: ({ row }) => (
        <DataTableText>{formatDateTime(row.original.createdAt)}</DataTableText>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <SettingsPageHeader
        title="运行节点"
        description="查看当前可用的运行节点"
      />

      <DataTable
        columns={columns}
        data={runtimes}
        isLoading={isLoading}
        emptyText="暂无运行节点"
        tableClassName="min-w-[640px]"
        wrapperClassName="max-h-[calc(100vh-280px)] overflow-auto rounded-lg border overscroll-contain"
        getRowId={(runtime) => runtime.id}
      />
    </div>
  );
}
