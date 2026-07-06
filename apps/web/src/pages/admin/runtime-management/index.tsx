import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import {
  PlusIcon,
  Trash2,
  RefreshCwIcon,
  CheckCircle2Icon,
  XCircleIcon,
} from 'lucide-react';
import { FormDialog } from '@/components/form-dialog';
import { ConfirmDeleteDialog } from '@/components/confirm-delete-dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  SettingsSection,
  SettingsItem,
} from '@/components/settings/settings-section';
import { useConfirmDelete } from '@/hooks/use-confirm-delete';
import {
  useCreateRuntime,
  useDeleteRuntime,
  useAdminRuntimes,
  useDetectEnv,
  useUpdateEnvConfigOverride,
  type CreateRuntimeResponse,
  type Runtime,
} from '@/hooks/use-runtime';
import type { AgentEnvStatus } from '@agework/shared/api';
import type { AgentType } from '@agework/shared';
import { cn } from '@/lib/utils';
import { formatDateTime } from '@/utils/format';
import { errorMessage } from '@/utils/error';
import { IssuedRuntimeTokenDialog } from '@/pages/settings/runtime/issued-runtime-token-dialog';

const NAME_MAX_LENGTH = 40;

const createRuntimeFormSchema = z.object({
  name: z.string().refine((value) => value.trim().length > 0, {
    message: '请输入名称',
  }),
});

type CreateRuntimeFormValues = z.infer<typeof createRuntimeFormSchema>;

function runtimeTypeLabel(runtimeType: string | null) {
  switch (runtimeType) {
    case 'local':
      return '本地';
    case 'docker':
      return 'Docker';
    case 'opensandbox':
      return 'OpenSandbox';
    default:
      return '待配对';
  }
}

// ── 单个 Agent CLI 环境行 ─────────────────────────────────────────────

function AgentEnvItem({
  agentType,
  status,
  runtimeId,
  overridePath,
}: {
  agentType: AgentType;
  status: AgentEnvStatus | null;
  runtimeId: string;
  overridePath: string | undefined;
}) {
  return (
    <SettingsItem
      title={
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="w-16 justify-center">
            {agentType}
          </Badge>
          {status?.resolvedPath ? (
            <span
              className="truncate font-mono text-xs"
              title={status.resolvedPath}
            >
              {status.resolvedPath}
            </span>
          ) : (
            <span className="text-sm text-muted-foreground">
              {status ? '未找到 CLI' : '未检测'}
            </span>
          )}
        </div>
      }
      description={
        <div className="flex flex-wrap items-center gap-2">
          {status?.resolvedPath && (
            <Badge variant={status.source === 'custom' ? 'default' : 'outline'}>
              {status.source === 'custom' ? '覆盖' : '系统'}
            </Badge>
          )}
          {status?.version && (
            <span className="text-xs">v{status.version}</span>
          )}
          {status && (
            <span
              className={cn(
                'flex items-center gap-1 text-xs',
                status.authAvailable ? 'text-green-600' : 'text-destructive',
              )}
            >
              {status.authAvailable ? (
                <CheckCircle2Icon className="size-3" />
              ) : (
                <XCircleIcon className="size-3" />
              )}
              {status.authAvailable ? '已认证' : '未认证'}
            </span>
          )}
        </div>
      }
    >
      <OverrideEditor
        runtimeId={runtimeId}
        agentType={agentType}
        currentOverride={overridePath}
      />
    </SettingsItem>
  );
}

function OverrideEditor({
  runtimeId,
  agentType,
  currentOverride,
}: {
  runtimeId: string;
  agentType: AgentType;
  currentOverride: string | undefined;
}) {
  const [value, setValue] = useState(currentOverride ?? '');
  const [editing, setEditing] = useState(false);
  const mutation = useUpdateEnvConfigOverride();

  const handleSave = () => {
    mutation.mutate(
      { id: runtimeId, agentType, executablePath: value.trim() },
      { onSuccess: () => setEditing(false) },
    );
  };

  if (editing) {
    return (
      <div className="flex items-center gap-1">
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="留空清除"
          className="h-7 w-36 text-xs"
          autoFocus
        />
        <Button
          size="sm"
          className="h-7"
          disabled={mutation.isPending}
          onClick={handleSave}
        >
          保存
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7"
          onClick={() => setEditing(false)}
        >
          取消
        </Button>
      </div>
    );
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 text-xs"
      onClick={() => {
        setValue(currentOverride ?? '');
        setEditing(true);
      }}
    >
      {currentOverride ? '修改覆盖' : '设置覆盖'}
    </Button>
  );
}

// ── 单个 Runtime 区块 ─────────────────────────────────────────────────

function RuntimeSection({
  runtime,
  onDelete,
}: {
  runtime: Runtime;
  onDelete: (rt: Runtime) => void;
}) {
  const detectMutation = useDetectEnv();
  const env = runtime.envStatus;

  return (
    <SettingsSection>
      {/* Runtime 标题行 */}
      <SettingsItem
        title={
          <div className="flex items-center gap-2">
            <span className="font-medium">{runtime.name}</span>
            <Badge variant="outline">
              {runtimeTypeLabel(runtime.runtimeType)}
            </Badge>
            <Badge
              variant={runtime.source === 'builtin' ? 'secondary' : 'outline'}
            >
              {runtime.source === 'builtin' ? '内置' : '注册'}
            </Badge>
            <Badge
              variant={runtime.status === 'online' ? 'default' : 'secondary'}
            >
              {runtime.status === 'online' ? '在线' : '离线'}
            </Badge>
          </div>
        }
        description={
          <div className="flex items-center gap-3">
            {runtime.lastHeartbeatAt && (
              <span>心跳 {formatDateTime(runtime.lastHeartbeatAt)}</span>
            )}
            {env?.detectedAt && (
              <span>检测于 {formatDateTime(env.detectedAt)}</span>
            )}
          </div>
        }
      >
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            className="h-7"
            disabled={detectMutation.isPending}
            onClick={() => detectMutation.mutate(runtime.id)}
          >
            <RefreshCwIcon
              className={cn(
                'size-3.5',
                detectMutation.isPending && 'animate-spin',
              )}
            />
            重新检测
          </Button>
          {runtime.source !== 'builtin' && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-destructive"
              aria-label={`删除运行环境 ${runtime.name}`}
              onClick={() => onDelete(runtime)}
            >
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
      </SettingsItem>

      {/* Claude CLI 行 */}
      <AgentEnvItem
        agentType="claude"
        status={env?.claude ?? null}
        runtimeId={runtime.id}
        overridePath={runtime.envConfigOverride?.claude?.executablePath}
      />

      {/* Codex CLI 行 */}
      <AgentEnvItem
        agentType="codex"
        status={env?.codex ?? null}
        runtimeId={runtime.id}
        overridePath={runtime.envConfigOverride?.codex?.executablePath}
      />
    </SettingsSection>
  );
}

// ── 主面板 ────────────────────────────────────────────────────────────

/** Admin「运行环境管理」：Runtime 列表 + create/delete + CLI 路径覆盖/重检。 */
export function AdminRuntimeManagementPanel({
  showHeader = true,
}: {
  showHeader?: boolean;
}) {
  const { data: runtimes = [], isLoading } = useAdminRuntimes();
  const deleteRuntime = useDeleteRuntime();
  const deleteDialog = useConfirmDelete<Runtime>();
  const [createOpen, setCreateOpen] = useState(false);
  const [issuedToken, setIssuedToken] = useState<CreateRuntimeResponse | null>(
    null,
  );

  return (
    <div className="space-y-6">
      <div
        className={cn(
          'flex items-center gap-3',
          showHeader ? 'justify-between' : 'justify-end',
        )}
      >
        {showHeader && (
          <div>
            <h2 className="text-lg font-semibold">运行环境</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              管理所有 Runtime，添加机器、注销配对、CLI 路径覆盖与重新检测
            </p>
          </div>
        )}
        <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
          <PlusIcon data-icon="inline-start" />
          添加机器
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2].map((i) => (
            <div
              key={i}
              className="h-20 animate-pulse rounded-lg border bg-card"
            />
          ))}
        </div>
      ) : runtimes.length === 0 ? (
        <SettingsSection>
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            暂无运行环境
          </div>
        </SettingsSection>
      ) : (
        <div className="space-y-3">
          {runtimes.map((rt) => (
            <RuntimeSection
              key={rt.id}
              runtime={rt}
              onDelete={(target) => deleteDialog.requestDelete(target)}
            />
          ))}
        </div>
      )}

      <CreateRuntimeDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={setIssuedToken}
      />

      <IssuedRuntimeTokenDialog
        result={issuedToken}
        onOpenChange={(open) => {
          if (!open) setIssuedToken(null);
        }}
      />

      <ConfirmDeleteDialog
        open={deleteDialog.isOpen}
        onOpenChange={deleteDialog.onOpenChange}
        onConfirm={() => {
          if (!deleteDialog.target) return;
          deleteRuntime.mutate(deleteDialog.target.id, {
            onSuccess: () => deleteDialog.cancelDelete(),
          });
        }}
        isPending={deleteRuntime.isPending}
        title="确认删除运行环境？"
        targetName={deleteDialog.target?.name}
        description={
          deleteDialog.target
            ? `将撤销「${deleteDialog.target.name}」的配对，该机器上的 agework-runtime 进程会在下次心跳时退出，此操作不可撤销`
            : undefined
        }
        confirmLabel="删除"
        pendingLabel="删除中…"
      />
    </div>
  );
}

function CreateRuntimeDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (result: CreateRuntimeResponse) => void;
}) {
  const formId = 'create-runtime-form';
  const [submitError, setSubmitError] = useState<string | null>(null);
  const createRuntime = useCreateRuntime();
  const form = useForm<CreateRuntimeFormValues>({
    resolver: zodResolver(createRuntimeFormSchema),
    defaultValues: { name: '' },
  });

  function handleSubmit(values: CreateRuntimeFormValues) {
    setSubmitError(null);
    createRuntime.mutate(
      { name: values.name.trim() },
      {
        onSuccess: (result) => {
          form.reset({ name: '' });
          onOpenChange(false);
          onCreated(result);
        },
        onError: (error) =>
          setSubmitError(errorMessage(error, '添加运行环境失败')),
      },
    );
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) form.reset({ name: '' });
        onOpenChange(next);
      }}
      title="添加机器"
      description="给这台机器起个名字，创建后会生成一次性配对命令"
      formId={formId}
      isPending={createRuntime.isPending}
      submitLabel="创建"
    >
      <form id={formId} onSubmit={form.handleSubmit(handleSubmit)}>
        <FieldGroup>
          <Controller
            name="name"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="runtime-name">名称</FieldLabel>
                <Input
                  {...field}
                  id="runtime-name"
                  aria-invalid={fieldState.invalid}
                  maxLength={NAME_MAX_LENGTH}
                  placeholder="如 mac-studio"
                  autoComplete="off"
                  autoFocus
                />
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              </Field>
            )}
          />
          {submitError && <FieldError>{submitError}</FieldError>}
        </FieldGroup>
      </form>
    </FormDialog>
  );
}
