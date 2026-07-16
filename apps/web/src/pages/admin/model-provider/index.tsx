import { PlusIcon } from "lucide-react";
import {
  ModelProviderDialog,
  type ModelProviderSaveValues,
} from "@/components/settings/model-provider-dialog";
import { Button } from "@/components/ui/button";
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { useConfirmDelete } from "@/hooks/use-confirm-delete";
import { useFormDialog } from "@/hooks/use-form-dialog";
import {
  DataTable,
  DataTableBadge,
  DataTableText,
  type DataTableColumnDef,
} from "@/components/data-table";
import { AgentIcon } from "@/components/icons/agent";
import {
  useCreateModelProvider,
  useAdminModelProviders,
  useDeleteModelProvider,
  useSetModelProviderEnabled,
  useUpdateModelProvider,
  type ModelProvider,
} from "@/hooks/model-provider-hooks";
import { cn } from "@/lib/utils";
import { API_FORMAT_AGENT_TYPES, isApiFormat } from "@agework/shared";
import {
  agentLabel,
  apiFormatLabel,
  getBaseUrl,
  getModel,
} from "@/utils/model-provider";
import {
  ModelProviderActions,
  ModelProviderValue,
} from "./model-provider-row";

export function ModelProviderPanel({
  showHeader = true,
}: {
  showHeader?: boolean;
}) {
  const { data: modelProviders = [], isLoading } = useAdminModelProviders();
  const createModelProvider = useCreateModelProvider();
  const updateModelProvider = useUpdateModelProvider();
  const setModelProviderEnabled = useSetModelProviderEnabled();
  const deleteModelProvider = useDeleteModelProvider();

  const formDialog = useFormDialog<ModelProvider>();
  const deleteDialog = useConfirmDelete<ModelProvider>();

  async function handleSave(values: ModelProviderSaveValues) {
    if (formDialog.target) {
      await updateModelProvider.mutateAsync({
        modelProviderId: formDialog.target.modelProviderId,
        name: values.name,
        providerConfig: values.providerConfig,
      });
    } else {
      await createModelProvider.mutateAsync(values);
    }
    formDialog.close();
  }

  function handleDelete() {
    if (!deleteDialog.target) return;
    deleteModelProvider.mutate(deleteDialog.target.modelProviderId, {
      onSuccess: () => deleteDialog.cancelDelete(),
    });
  }

  const columns: DataTableColumnDef<ModelProvider>[] = [
    {
      id: "name",
      header: "名称",
      meta: { headerClassName: "pl-4", cellClassName: "pl-4" },
      cell: ({ row }) => (
        <div className="flex min-w-0 items-center gap-2">
          <DataTableText className="font-medium">{row.original.name}</DataTableText>
        </div>
      ),
    },
    {
      id: "apiFormat",
      header: "API 格式",
      cell: ({ row }) => (
        <DataTableBadge variant="outline">
          {apiFormatLabel(row.original.apiFormat)}
        </DataTableBadge>
      ),
    },
    {
      id: "agents",
      header: "适用 Agent",
      cell: ({ row }) => {
        const agentTypes = isApiFormat(row.original.apiFormat)
          ? API_FORMAT_AGENT_TYPES[row.original.apiFormat]
          : [];
        return (
          <div className="flex items-center gap-2">
            {agentTypes.map((agentType) => (
              <div key={agentType} className="flex items-center gap-1" title={agentLabel(agentType)}>
                <AgentIcon agent={agentType} />
                <DataTableText>{agentLabel(agentType)}</DataTableText>
              </div>
            ))}
          </div>
        );
      },
    },
    {
      id: "model",
      header: "Model ID",
      cell: ({ row }) => <ModelProviderValue value={getModel(row.original)} variant="tag" />,
    },
    {
      id: "baseUrl",
      header: "BaseURL",
      cell: ({ row }) => <ModelProviderValue value={getBaseUrl(row.original)} />,
    },
    {
      id: "enabled",
      header: "启用状态",
      cell: ({ row }) =>
        row.original.isEnabled ? (
          <DataTableBadge variant="default">已启用</DataTableBadge>
        ) : (
          <DataTableBadge variant="outline">未启用</DataTableBadge>
        ),
    },
    {
      id: "actions",
      header: "操作",
      meta: { headerClassName: "pr-4 text-right", cellClassName: "pr-4 text-right" },
      cell: ({ row }) => {
        const modelProvider = row.original;

        return (
          <ModelProviderActions
            modelProvider={modelProvider}
            isTogglingEnabled={setModelProviderEnabled.isPending}
            onToggleEnabled={() =>
              setModelProviderEnabled.mutate({
                modelProviderId: modelProvider.modelProviderId,
                isEnabled: !modelProvider.isEnabled,
              })
            }
            onEdit={() => formDialog.openEdit(modelProvider)}
            onDelete={() => deleteDialog.requestDelete(modelProvider)}
          />
        );
      },
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div
        className={cn(
          "flex items-center gap-3",
          showHeader ? "justify-between" : "justify-end",
        )}
      >
        {showHeader && (
          <div>
            <h2 className="text-lg font-semibold">模型服务</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              管理全局模型服务，含 API Key、模型和访问地址
            </p>
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="sm" onClick={formDialog.openCreate}>
            <PlusIcon data-icon="inline-start" />
            新建模型服务
          </Button>
        </div>
      </div>

      <DataTable
        columns={columns}
        data={modelProviders}
        isLoading={isLoading}
        emptyText="暂无模型服务"
        tableClassName="min-w-[960px]"
        getRowId={(modelProvider) => modelProvider.modelProviderId}
      />

      <ModelProviderDialog
        open={formDialog.open}
        onOpenChange={formDialog.onOpenChange}
        modelProvider={formDialog.target}
        onSave={handleSave}
        isSaving={
          formDialog.target
            ? updateModelProvider.isPending
            : createModelProvider.isPending
        }
      />

      <ConfirmDeleteDialog
        open={deleteDialog.isOpen}
        onOpenChange={deleteDialog.onOpenChange}
        onConfirm={handleDelete}
        isPending={deleteModelProvider.isPending}
        title="删除模型服务"
        targetName={deleteDialog.target?.name}
      />
    </div>
  );
}
