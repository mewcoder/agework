import { useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";
import { PlusIcon, Trash2, RefreshCwIcon, PencilIcon } from "lucide-react";
import { FormDialog } from "@/components/form-dialog";
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  SettingsSection,
  SettingsItem,
} from "@/components/settings/settings-section";
import { AgentIcon } from "@/components/icons/agent";
import { useConfirmDelete } from "@/hooks/use-confirm-delete";
import {
  useCreateRuntimeHost,
  useDeleteRuntimeHost,
  useAdminRuntimeHosts,
  useDetectEnv,
  useUpdateEnvConfigOverride,
  useInstallCli,
  type CreateRuntimeHostResponse,
  type RuntimeHost,
} from "@/hooks/use-runtime-host";
import type { AgentEnvStatus } from "@agework/shared/api";
import type { AgentType } from "@agework/shared";
import { cn } from "@/lib/utils";
import { formatDateTime } from "@/utils/format";
import { errorMessage } from "@/utils/error";
import { IssuedHostTokenDialog } from "@/pages/settings/runtime-host/issued-host-token-dialog";

const NAME_MAX_LENGTH = 40;

const createRuntimeFormSchema = z.object({
  name: z.string().refine((value) => value.trim().length > 0, {
    message: "请输入名称",
  }),
});

type CreateRuntimeFormValues = z.infer<typeof createRuntimeFormSchema>;

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

// ── 单个 Agent CLI 环境行 ─────────────────────────────────────────────
//
// 复用 AgentIcon（系统组件）展示 agent 类型图标，
// 路径/版本放在 description 区，操作按钮通过 SettingsItem children 放置。
//
function AgentEnvItem({
  agentType,
  status,
  runtimeHostId,
  overridePath,
}: {
  agentType: AgentType;
  status: AgentEnvStatus | null;
  runtimeHostId: string;
  overridePath: string | undefined;
}) {
  return (
    <SettingsItem
      title={
        <div className="flex min-w-0 items-center gap-2">
          <AgentIcon agent={agentType} size={14} />
          <span className="font-medium">{agentType}</span>
        </div>
      }
      description={
        status?.resolvedPath ? (
          <span className="flex flex-wrap items-center gap-2">
            <Badge
              variant={status.source === "custom" ? "default" : "secondary"}
              className="shrink-0"
            >
              {status.source === "custom" ? "自定义" : "系统"}
            </Badge>
            {status.version && (
              <Badge variant="outline" className="shrink-0 font-mono">
                v{status.version}
              </Badge>
            )}
            <span
              className="truncate font-mono text-xs"
              title={status.resolvedPath}
            >
              {status.resolvedPath}
            </span>
          </span>
        ) : (
          <span>{status ? "未找到 CLI" : "未检测"}</span>
        )
      }
    >
      <div className="flex items-center gap-1.5">
        {status && !status.resolvedPath && (
          <AgentInstallButton runtimeHostId={runtimeHostId} agentType={agentType} />
        )}
        <OverrideEditor
          runtimeHostId={runtimeHostId}
          agentType={agentType}
          currentOverride={overridePath}
        />
      </div>
    </SettingsItem>
  );
}

function AgentInstallButton({
  runtimeHostId,
  agentType,
}: {
  runtimeHostId: string;
  agentType: AgentType;
}) {
  const installMutation = useInstallCli();

  return (
    <Button
      variant="outline"
      size="sm"
      className="h-7"
      disabled={installMutation.isPending}
      onClick={() => installMutation.mutate({ id: runtimeHostId, agentType })}
    >
      {installMutation.isPending ? "安装中…" : "安装"}
    </Button>
  );
}

function OverrideEditor({
  runtimeHostId,
  agentType,
  currentOverride,
}: {
  runtimeHostId: string;
  agentType: AgentType;
  currentOverride: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(currentOverride ?? "");
  const overrideMutation = useUpdateEnvConfigOverride();

  const handleSave = () => {
    overrideMutation.mutate(
      { id: runtimeHostId, agentType, executablePath: value.trim() },
      { onSuccess: () => setOpen(false) }
    );
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setValue(currentOverride ?? "");
        setOpen(next);
      }}
    >
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label={`编辑 ${agentType} CLI 路径`}
          />
        }
      >
        <PencilIcon className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-3">
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            自定义可执行文件路径，留空清除覆盖
          </p>
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="如 /usr/local/bin/claude"
            className="h-8 text-xs"
            autoFocus
          />
          <div className="flex justify-end gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7"
              onClick={() => setOpen(false)}
            >
              取消
            </Button>
            <Button
              size="sm"
              className="h-7"
              disabled={overrideMutation.isPending}
              onClick={handleSave}
            >
              保存
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ── 单个 RuntimeHost 区块 ─────────────────────────────────────────────────
//
// 结构：
//   SettingsSection（卡片容器）
//     ├─ 自定义 header div（名称 + Badge | 右侧：时间 + 操作按钮）
//     ├─ AgentEnvItem（claude 行）
//     └─ AgentEnvItem（codex 行）
//
function RuntimeSection({
  runtime,
  onDelete,
}: {
  runtime: RuntimeHost;
  onDelete: (rt: RuntimeHost) => void;
}) {
  const detectMutation = useDetectEnv();
  const env = runtime.envStatus;
  const canDelete = runtime.source !== "builtin";
  const hasNative = runtime.capabilities?.native?.available === true;

  return (
    <SettingsSection>
      {/* 自定义 header：不用 SettingsItem（避免 flex-1 撑开右侧空隙） */}
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        {/* 左侧：名称 + Badge + 时间 */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{runtime.name}</span>
            <Badge
              variant={runtime.source === "builtin" ? "secondary" : "outline"}
            >
              {runtime.source === "builtin" ? "内置" : "注册"}
            </Badge>
            <Badge variant="outline">
              {Object.keys(runtime.capabilities ?? {})
                .map(runtimeTypeLabel)
                .join(" / ") || "待配对"}
            </Badge>
            <Badge
              variant={runtime.status === "online" ? "default" : "secondary"}
            >
              {runtime.status === "online" ? "在线" : "离线"}
            </Badge>
          </div>
          {env?.detectedAt && (
            <div className="mt-0.5 text-xs text-muted-foreground">
              检测于 {formatDateTime(env.detectedAt)}
            </div>
          )}
        </div>

        {/* 右侧：操作按钮 — 紧凑对齐 */}
        <div className="flex shrink-0 items-center gap-1.5">
          {hasNative && (
            <Button
              variant="outline"
              size="sm"
              className="h-7"
              disabled={detectMutation.isPending}
              onClick={() => detectMutation.mutate(runtime.id)}
            >
              <RefreshCwIcon
                className={cn(
                  "size-3.5",
                  detectMutation.isPending && "animate-spin"
                )}
              />
              检测 Agent
            </Button>
          )}
          {canDelete ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-destructive"
              aria-label={`删除运行节点 ${runtime.name}`}
              onClick={() => onDelete(runtime)}
            >
              <Trash2 className="size-3.5" />
            </Button>
          ) : null}
        </div>
      </div>

      {/* CLI 环境行 */}
      {hasNative ? (
        <>
          <AgentEnvItem
            agentType="claude"
            status={env?.claude ?? null}
            runtimeHostId={runtime.id}
            overridePath={runtime.envConfigOverride?.claude?.executablePath}
          />
          <AgentEnvItem
            agentType="codex"
            status={env?.codex ?? null}
            runtimeHostId={runtime.id}
            overridePath={runtime.envConfigOverride?.codex?.executablePath}
          />
        </>
      ) : null}
    </SettingsSection>
  );
}

// ── 主面板 ────────────────────────────────────────────────────────────

/** Admin「运行节点」：RuntimeHost 列表 + create/delete + CLI 路径覆盖/重检。 */
export function RuntimeHostPanel({ showHeader = true }: { showHeader?: boolean }) {
  const { data: runtimes = [], isLoading } = useAdminRuntimeHosts();
  const deleteRuntime = useDeleteRuntimeHost();
  const deleteDialog = useConfirmDelete<RuntimeHost>();
  const [createOpen, setCreateOpen] = useState(false);
  const [issuedToken, setIssuedToken] = useState<CreateRuntimeHostResponse | null>(
    null
  );

  return (
    <div className="space-y-6">
      <div
        className={cn(
          "flex items-center gap-3",
          showHeader ? "justify-between" : "justify-end"
        )}
      >
        {showHeader && (
          <div>
            <h2 className="text-lg font-semibold">运行节点</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              管理运行节点及 Agent CLI
            </p>
          </div>
        )}
        <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
          <PlusIcon data-icon="inline-start" />
          添加
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
            暂无运行节点
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

      <IssuedHostTokenDialog
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
        title="确认删除运行节点？"
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
  onCreated: (result: CreateRuntimeHostResponse) => void;
}) {
  const formId = "create-runtime-form";
  const [submitError, setSubmitError] = useState<string | null>(null);
  const createRuntime = useCreateRuntimeHost();
  const form = useForm<CreateRuntimeFormValues>({
    resolver: zodResolver(createRuntimeFormSchema),
    defaultValues: { name: "" },
  });

  function handleSubmit(values: CreateRuntimeFormValues) {
    setSubmitError(null);
    createRuntime.mutate(
      { name: values.name.trim() },
      {
        onSuccess: (result) => {
          form.reset({ name: "" });
          onOpenChange(false);
          onCreated(result);
        },
        onError: (error) =>
          setSubmitError(errorMessage(error, "添加运行节点失败")),
      }
    );
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) form.reset({ name: "" });
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
                {fieldState.invalid && (
                  <FieldError errors={[fieldState.error]} />
                )}
              </Field>
            )}
          />
          {submitError && <FieldError>{submitError}</FieldError>}
        </FieldGroup>
      </form>
    </FormDialog>
  );
}
