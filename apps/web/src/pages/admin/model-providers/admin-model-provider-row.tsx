import { Loader2Icon, PencilIcon, Trash2Icon, ZapIcon } from "lucide-react";
import {
  DataTableActionButton,
  DataTableActions,
  DataTableBadge,
  DataTableButton,
  DataTableEmpty,
  DataTableText,
} from "@/components/data-table";
import {
  useAdminTestModelProvider,
  type ModelProvider,
} from "@/hooks/model-provider-hooks";
import { errorMessage } from "@/utils/error";
import { isEnvironmentModelProvider, showModelProviderTestToast } from "@/utils/model-provider";

export function ModelProviderValue({
  value,
  variant = "text",
}: {
  value: string;
  variant?: "text" | "tag";
}) {
  if (!value) return <DataTableEmpty />;

  if (variant === "tag") {
    return (
      <DataTableBadge
        variant="outline"
        className="max-w-[280px] rounded-md font-mono"
        title={value}
      >
        <span className="truncate">{value}</span>
      </DataTableBadge>
    );
  }

  return (
    <DataTableText
      mono
      className="max-w-[280px]"
      title={value}
    >
      {value}
    </DataTableText>
  );
}

export function AdminModelProviderActions({
  modelProvider,
  onToggleEnabled,
  onEdit,
  onDelete,
  isTogglingEnabled,
}: {
  modelProvider: ModelProvider;
  onToggleEnabled: () => void;
  onEdit: () => void;
  onDelete: () => void;
  isTogglingEnabled: boolean;
}) {
  const testModelProvider = useAdminTestModelProvider();
  const isEnvironment = isEnvironmentModelProvider(modelProvider);

  async function handleTest() {
    try {
      const result = await testModelProvider.mutateAsync(modelProvider.modelProviderId);
      if (result.success) {
        showModelProviderTestToast("success", `${modelProvider.name}: ${result.latency}ms`);
      } else {
        showModelProviderTestToast(
          "error",
          result.error ?? `${modelProvider.name}: 连接失败`,
        );
      }
    } catch (error) {
      showModelProviderTestToast("error", errorMessage(error, "连接测试失败"));
    }
  }

  return (
    <DataTableActions>
      <DataTableButton
        onClick={onToggleEnabled}
        disabled={isTogglingEnabled}
      >
        {modelProvider.isEnabled ? "停用" : "启用"}
      </DataTableButton>
      {!isEnvironment && (
        <>
          <DataTableActionButton
            onClick={handleTest}
            disabled={testModelProvider.isPending}
            title="测试连通性"
            aria-label={`测试 ${modelProvider.name}`}
          >
            {testModelProvider.isPending ? (
              <Loader2Icon className="animate-spin" />
            ) : (
              <ZapIcon />
            )}
          </DataTableActionButton>
          <DataTableActionButton
            onClick={onEdit}
            title="编辑模型服务"
            aria-label={`编辑 ${modelProvider.name}`}
          >
            <PencilIcon />
          </DataTableActionButton>
          <DataTableActionButton
            tone="destructive"
            onClick={onDelete}
            disabled={modelProvider.isEnabled}
            title={modelProvider.isEnabled ? "停用后可删除" : "删除模型服务"}
            aria-label={`删除 ${modelProvider.name}`}
          >
            <Trash2Icon />
          </DataTableActionButton>
        </>
      )}
    </DataTableActions>
  );
}
