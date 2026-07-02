import { Pencil, Trash2, Plus, Zap, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { AgentIcon } from '@/components/icons/agent';
import { ModelProviderDialog } from '@/components/settings/model-provider-dialog';
import { ConfirmDeleteDialog } from '@/components/confirm-delete-dialog';
import { useConfirmDelete } from '@/hooks/use-confirm-delete';
import { SettingsSection, SettingsItem } from '@/components/settings/settings-section';
import { useFormDialog } from '@/hooks/use-form-dialog';
import {
  useModelProviders,
  useCreateModelProvider,
  useUpdateModelProvider,
  useDeleteModelProvider,
  useTestModelProvider,
  type ModelProvider,
  type ProviderConfigValues,
} from '@/hooks/model-provider-hooks';
import { useAgentOptions } from '@/hooks/use-agent-options';
import { errorMessage } from '@/utils/error';
import { getBaseUrl, getModel } from '@/utils/model-provider';
import { showModelProviderTestToast } from '@/utils/model-provider';
import type { AgentType } from '@agework/shared';

function SystemModelProviderDescription(agent: AgentType): string {
  if (agent === 'claude') return '使用服务运行环境中的 Claude Code 配置';
  if (agent === 'codex') return '使用服务运行环境中的 Codex 配置';
  return '使用服务运行环境中的默认模型服务';
}

function ModelProviderDescription({
  model,
  baseUrl,
}: {
  model: string;
  baseUrl: string;
}) {
  if (!model && !baseUrl) return undefined;

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      {model && (
        <Badge
          variant="outline"
          className="h-5 max-w-full rounded-md px-1.5 font-mono text-[11px] font-medium"
          title={model}
        >
          <span className="truncate">{model}</span>
        </Badge>
      )}
      {baseUrl && <span className="truncate">{baseUrl}</span>}
    </div>
  );
}

function ModelProviderRow({
  modelProvider,
  agent,
  canManage,
  onEdit,
  onDelete,
}: {
  modelProvider: ModelProvider;
  agent: AgentType;
  canManage: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const testModelProvider = useTestModelProvider();
  const isSystem = modelProvider.modelProviderId.startsWith('system:');
  const baseUrl = getBaseUrl(modelProvider);
  const model = getModel(modelProvider);

  async function handleTest() {
    try {
      const result = await testModelProvider.mutateAsync(modelProvider.modelProviderId);
      if (result.success) {
        showModelProviderTestToast('success', `${modelProvider.name}: ${result.latency}ms`);
      } else {
        showModelProviderTestToast(
          'error',
          result.error ?? `${modelProvider.name}: 连接失败`,
        );
      }
    } catch (error) {
      showModelProviderTestToast('error', errorMessage(error, '连接测试失败'));
    }
  }

  const title = modelProvider.name;

  const description = isSystem
    ? SystemModelProviderDescription(agent)
    : <ModelProviderDescription model={model} baseUrl={baseUrl} />;

  const actions = (
    <div className="flex items-center gap-1">
      {!isSystem && (
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-foreground"
          onClick={handleTest}
          disabled={testModelProvider.isPending}
          title="测试连通性"
        >
          {testModelProvider.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Zap className="h-3.5 w-3.5" />
          )}
        </Button>
      )}
      {!isSystem && canManage && (
        <>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onEdit}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-destructive"
            onClick={onDelete}
            disabled={modelProvider.isEnabled}
            title={modelProvider.isEnabled ? '停用后可删除' : '删除模型服务'}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </>
      )}
    </div>
  );

  return (
    <SettingsItem title={title} description={description}>
      {actions}
    </SettingsItem>
  );
}

function ModelProviderList({ agent, canManage }: { agent: AgentType; canManage: boolean }) {
  const { data: modelProviders = [], isLoading } = useModelProviders(agent);
  const createModelProvider = useCreateModelProvider(agent);
  const updateModelProvider = useUpdateModelProvider(agent);
  const deleteModelProvider = useDeleteModelProvider(agent);

  const formDialog = useFormDialog<ModelProvider>();
  const deleteDialog = useConfirmDelete<ModelProvider>();

  async function handleSave(name: string, providerConfig: ProviderConfigValues) {
    if (formDialog.target) {
      await updateModelProvider.mutateAsync({
        modelProviderId: formDialog.target.modelProviderId,
        name,
        providerConfig,
      });
    } else {
      await createModelProvider.mutateAsync({ name, providerConfig });
    }
    formDialog.close();
  }

  if (isLoading) {
    return <div className="text-sm text-muted-foreground py-8 text-center">加载中...</div>;
  }

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="flex justify-end">
          <Button size="sm" onClick={formDialog.openCreate}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            新建模型服务
          </Button>
        </div>
      )}

      {modelProviders.length > 0 && (
        <SettingsSection>
          {modelProviders.map((modelProvider) => (
            <ModelProviderRow
              key={modelProvider.modelProviderId}
              modelProvider={modelProvider}
              agent={agent}
              canManage={canManage}
              onEdit={() => formDialog.openEdit(modelProvider)}
              onDelete={() => deleteDialog.requestDelete(modelProvider)}
            />
          ))}
        </SettingsSection>
      )}

      {modelProviders.length === 0 && (
        <SettingsSection>
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            暂无模型服务
          </div>
        </SettingsSection>
      )}

      <ModelProviderDialog
        open={formDialog.open}
        onOpenChange={formDialog.onOpenChange}
        agent={agent}
        modelProvider={formDialog.target}
        onSave={handleSave}
        isSaving={createModelProvider.isPending || updateModelProvider.isPending}
      />

      <ConfirmDeleteDialog
        open={deleteDialog.isOpen}
        onOpenChange={deleteDialog.onOpenChange}
        onConfirm={() => {
          if (!deleteDialog.target) return;
          deleteModelProvider.mutate(deleteDialog.target.modelProviderId, {
            onSuccess: () => deleteDialog.cancelDelete(),
          });
        }}
        isPending={deleteModelProvider.isPending}
        title="删除模型服务"
        targetName={deleteDialog.target?.name}
      />
    </div>
  );
}

export function ModelProvider({
  canManage = false,
  showHeader = true,
}: {
  canManage?: boolean;
  showHeader?: boolean;
}) {
  const { data: agentOptions, isLoading: isLoadingAgents } = useAgentOptions();
  const agents = agentOptions?.list ?? [];

  return (
    <div className={showHeader ? 'space-y-6' : 'space-y-0'}>
      {showHeader && (
        <div>
          <h2 className="text-lg font-semibold">模型服务</h2>
          <p className="text-sm text-muted-foreground mt-1">
            为每个 Agent 配置 API Key、模型和访问地址，可保存多个模型服务并随时切换
          </p>
        </div>
      )}

      <div className="space-y-6">
        {isLoadingAgents && (
          <div className="text-center text-sm text-muted-foreground">
            加载中...
          </div>
        )}
        {agents.map((agent) => (
          <section key={agent.id} className="space-y-3">
            <div className="flex items-center gap-2">
              <AgentIcon agent={agent.id} />
              <h3 className="text-sm font-medium">{agent.label}</h3>
            </div>
            <ModelProviderList agent={agent.id} canManage={canManage} />
          </section>
        ))}
      </div>
    </div>
  );
}
