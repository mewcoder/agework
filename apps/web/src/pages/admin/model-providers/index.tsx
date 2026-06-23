import { useMemo, useState } from "react";
import { PlusIcon } from "lucide-react";
import { ModelProviderDialog } from "@/components/settings/model-provider-dialog";
import { Button } from "@/components/ui/button";
import { ConfirmDeleteDialog, useConfirmDelete } from "@/components/confirm-delete-dialog";
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
  type ProviderConfigValues,
} from "@/hooks/model-provider-hooks";
import { cn } from "@/lib/utils";
import {
  agentLabel,
  isManagedAgent,
  type ManagedAgent,
  compareModelProviders,
  getBaseUrl,
  isSystemModelProvider,
  getModel,
} from "@/utils/model-provider";
import {
  AdminModelProviderActions,
  ModelProviderValue,
} from "./admin-model-provider-row";

function SystemStatusBadge({ modelProvider }: { modelProvider: ModelProvider }) {
  if (!isSystemModelProvider(modelProvider)) return null;

  const status = modelProvider.systemStatus;
  if (!status) return null;

  const isReady = status.commandAvailable && status.configAvailable;
  const label = isReady
    ? "本地可用"
    : status.commandAvailable
      ? "未检测到配置"
      : "未检测到本地 CLI";

  return (
    <DataTableBadge
      variant={isReady ? "default" : "outline"}
      title={`${status.command}: ${label}`}
    >
      {label}
    </DataTableBadge>
  );
}

export function AdminModelProvidersPanel({
  showHeader = true,
}: {
  showHeader?: boolean;
}) {
  const { data: claudeModelProviders = [], isLoading: isLoadingClaude } =
    useAdminModelProviders("claude");
  const { data: codexModelProviders = [], isLoading: isLoadingCodex } =
    useAdminModelProviders("codex");
  const createClaudeModelProvider = useCreateModelProvider("claude");
  const createCodexModelProvider = useCreateModelProvider("codex");
  const updateClaudeModelProvider = useUpdateModelProvider("claude");
  const updateCodexModelProvider = useUpdateModelProvider("codex");
  const setClaudeModelProviderEnabled = useSetModelProviderEnabled("claude");
  const setCodexModelProviderEnabled = useSetModelProviderEnabled("codex");
  const deleteClaudeModelProvider = useDeleteModelProvider("claude");
  const deleteCodexModelProvider = useDeleteModelProvider("codex");

  const formDialog = useFormDialog<ModelProvider>();
  const [dialogAgent, setDialogAgent] = useState<ManagedAgent>("claude");
  const deleteDialog = useConfirmDelete<ModelProvider>();

  const modelProviders = useMemo(
    () => [...claudeModelProviders, ...codexModelProviders].sort(compareModelProviders),
    [claudeModelProviders, codexModelProviders],
  );
  const isLoading = isLoadingClaude || isLoadingCodex;

  function openCreateDialog() {
    setDialogAgent("claude");
    formDialog.openCreate();
  }

  function openEditDialog(modelProvider: ModelProvider) {
    const agent = isManagedAgent(modelProvider.agentType) ? modelProvider.agentType : "claude";
    setDialogAgent(agent);
    formDialog.openEdit(modelProvider);
  }

  function createMutationFor(agent: ManagedAgent) {
    return agent === "claude" ? createClaudeModelProvider : createCodexModelProvider;
  }

  function updateMutationFor(agent: ManagedAgent) {
    return agent === "claude" ? updateClaudeModelProvider : updateCodexModelProvider;
  }

  function deleteMutationFor(agentType: string) {
    return agentType === "claude" ? deleteClaudeModelProvider : deleteCodexModelProvider;
  }

  function setEnabledMutationFor(agentType: string) {
    return agentType === "claude" ? setClaudeModelProviderEnabled : setCodexModelProviderEnabled;
  }

  async function handleSave(
    name: string,
    providerConfig: ProviderConfigValues,
    agent: ManagedAgent,
  ) {
    if (formDialog.target) {
      const agent = isManagedAgent(formDialog.target.agentType)
        ? formDialog.target.agentType
        : dialogAgent;
      await updateMutationFor(agent).mutateAsync({
        modelProviderId: formDialog.target.modelProviderId,
        name,
        providerConfig,
      });
    } else {
      await createMutationFor(agent).mutateAsync({ name, providerConfig });
    }
    formDialog.close();
  }

  function handleDelete() {
    if (!deleteDialog.target) return;
    deleteMutationFor(deleteDialog.target.agentType).mutate(deleteDialog.target.modelProviderId, {
      onSuccess: () => deleteDialog.cancelDelete(),
    });
  }

  const dialogMutation = formDialog.target
    ? updateMutationFor(
        isManagedAgent(formDialog.target.agentType) ? formDialog.target.agentType : dialogAgent,
      )
    : undefined;
  const isDialogSaving = formDialog.target
    ? dialogMutation?.isPending
    : createClaudeModelProvider.isPending || createCodexModelProvider.isPending;
  const deleteMutation = deleteDialog.target
    ? deleteMutationFor(deleteDialog.target.agentType)
    : deleteClaudeModelProvider;

  const columns: DataTableColumnDef<ModelProvider>[] = [
    {
      id: "name",
      header: "名称",
      meta: { headerClassName: "pl-4", cellClassName: "pl-4" },
      cell: ({ row }) => (
        <div className="flex min-w-0 items-center gap-2">
          <DataTableText className="font-medium">{row.original.name}</DataTableText>
          <SystemStatusBadge modelProvider={row.original} />
        </div>
      ),
    },
    {
      id: "agent",
      header: "Agent",
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          <AgentIcon agent={row.original.agentType} />
          <DataTableText className="font-medium">
            {agentLabel(row.original.agentType)}
          </DataTableText>
        </div>
      ),
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
        const setEnabledMutation = setEnabledMutationFor(modelProvider.agentType);

        return (
          <AdminModelProviderActions
            modelProvider={modelProvider}
            isTogglingEnabled={setEnabledMutation.isPending}
            onToggleEnabled={() =>
              setEnabledMutation.mutate({
                modelProviderId: modelProvider.modelProviderId,
                isEnabled: !modelProvider.isEnabled,
              })
            }
            onEdit={() => openEditDialog(modelProvider)}
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
          <Button size="sm" onClick={openCreateDialog}>
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
        tableClassName="min-w-[860px]"
        getRowId={(modelProvider) => modelProvider.modelProviderId}
      />

      <ModelProviderDialog
        open={formDialog.open}
        onOpenChange={formDialog.onOpenChange}
        agent={dialogAgent}
        modelProvider={formDialog.target}
        onSave={handleSave}
        isSaving={isDialogSaving}
        allowAgentSelect
      />

      <ConfirmDeleteDialog
        open={deleteDialog.isOpen}
        onOpenChange={deleteDialog.onOpenChange}
        onConfirm={handleDelete}
        isPending={deleteMutation.isPending}
        title="删除模型服务"
        targetName={deleteDialog.target?.name}
      />
    </div>
  );
}
