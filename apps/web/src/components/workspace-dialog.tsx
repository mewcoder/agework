import { useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";
import { FolderOpenIcon } from "lucide-react";
import { FormDialog } from "@/components/form-dialog";
import { DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { Workspace } from "@/hooks/use-workspace";
import {
  useCreateWorkspace,
  useRenameWorkspace,
  useWorkspaceCapabilities,
} from "@/hooks/use-workspace";
import type { UpdateWorkspaceInput } from "@/api/workspaces";
import type {
  WorkspaceIsolationScope,
  WorkspaceRuntimeType,
} from "@agework/shared/api";
import { errorMessage } from "@/utils/error";
import { normalizeFilesystemPath } from "@/utils/path";
import { useRuntimes } from "@/hooks/use-runtime";
import type { Runtime } from "@/hooks/use-runtime";
interface WorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspace?: Workspace;
  onCreated?: (workspace: Workspace) => void;
  onUpdate?: (id: string, data: UpdateWorkspaceInput) => Promise<Workspace>;
  submitLabel?: string;
}

const PROJECT_NAME_MAX_LENGTH = 20;
const PROJECT_DESCRIPTION_MAX_LENGTH = 60;
const RUNTIME_TYPES = ["local", "docker", "opensandbox"] as const;
const ISOLATION_SCOPES = ["user", "workspace"] as const;
const PLACEMENT_MODES = ["managed", "registered"] as const;
type PlacementMode = (typeof PLACEMENT_MODES)[number];

/** 只列出已完成配对注册的机器(runtimeType 未知的配对码不可选;builtin 全局运行环境
 *  走上面的 runtimeType/isolationScope 下拉,不在这个"选择已配对机器"的列表里出现)。 */
function eligibleRuntimes(runtimes: Runtime[]): Runtime[] {
  return runtimes.filter(
    (runtime) => runtime.runtimeType !== null && runtime.source !== "builtin"
  );
}

function defaultWorkspaceName(): string {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `工作空间${mm}${dd}`;
}

function detectPathHint(): string {
  if (typeof navigator === "undefined") return "/Users/name/code/project";
  return navigator.platform?.toLowerCase().startsWith("win")
    ? "C:\\Users\\name\\code\\project"
    : "/Users/name/code/project";
}

function hasNativeDirectoryPicker(): boolean {
  if (typeof window === "undefined") return false;
  const win = window as DirectoryPickerWindow;
  return !!win.agework?.selectDirectory;
}

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: () => Promise<{ name?: string }>;
  agework?: {
    selectDirectory?: () => Promise<string | undefined>;
  };
};

const workspaceDialogFormSchema = z
  .object({
    name: z
      .string()
      .refine((value) => value.trim().length > 0, {
        message: "请输入名称",
      })
      .refine((value) => value.trim().length <= PROJECT_NAME_MAX_LENGTH, {
        message: `名称最多 ${PROJECT_NAME_MAX_LENGTH} 个字`,
      }),
    description: z
      .string()
      .refine(
        (value) =>
          value.trim().length <= PROJECT_DESCRIPTION_MAX_LENGTH,
        {
          message: `描述最多 ${PROJECT_DESCRIPTION_MAX_LENGTH} 个字`,
        },
      )
      .optional(),
    useGit: z.boolean(),
    useCustomPath: z.boolean(),
    placementMode: z.enum(PLACEMENT_MODES),
    runtimeType: z.enum(RUNTIME_TYPES),
    isolationScope: z.enum(ISOLATION_SCOPES),
    gitUrl: z.string().optional(),
    rootPath: z.string().optional(),
    runtimeId: z.string().optional(),
  })
  .superRefine((values, ctx) => {
    if (values.placementMode === "registered") {
      if (!values.runtimeId) {
        ctx.addIssue({
          code: "custom",
          path: ["runtimeId"],
          message: "请选择运行环境",
        });
      }
      if (!values.rootPath?.trim()) {
        ctx.addIssue({
          code: "custom",
          path: ["rootPath"],
          message: "请填写该运行环境上的绝对路径",
        });
      }
      return;
    }
    if (values.useGit && !values.gitUrl?.trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["gitUrl"],
        message: "请输入 Git 地址",
      });
    }
    if (values.useCustomPath && !values.rootPath?.trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["rootPath"],
        message: "请选择目录",
      });
    }
    if (
      values.useCustomPath &&
      values.runtimeType !== "local" &&
      values.isolationScope !== "workspace"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["isolationScope"],
        message: "沙箱指定本地目录时必须选择工作空间独立",
      });
    }
  });

type WorkspaceDialogFormValues = z.infer<typeof workspaceDialogFormSchema>;

export function WorkspaceDialog({
  open,
  onOpenChange,
  workspace,
  onCreated,
  onUpdate,
  submitLabel,
}: WorkspaceDialogProps) {
  const isEdit = !!workspace;
  const formId = `workspace-dialog-form-${workspace?.id ?? "new"}`;

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? "编辑工作空间" : "新建工作空间"}
      description={isEdit
        ? "更新工作空间在列表和对话中的显示信息"
        : "创建后可在该工作空间中启动 Agent 对话"}
      footer="none"
    >
      <WorkspaceDialogForm
        key={workspace?.id ?? "new-workspace"}
        workspace={workspace}
        onOpenChange={onOpenChange}
        onCreated={onCreated}
        onUpdate={onUpdate}
        formId={formId}
        submitLabel={submitLabel}
      />
    </FormDialog>
  );
}

function WorkspaceDialogForm({
  workspace,
  onOpenChange,
  onCreated,
  onUpdate,
  formId,
  submitLabel,
}: {
  workspace?: Workspace;
  onOpenChange: (open: boolean) => void;
  onCreated?: (workspace: Workspace) => void;
  onUpdate?: (id: string, data: UpdateWorkspaceInput) => Promise<Workspace>;
  formId: string;
  submitLabel?: string;
}) {
  const isEdit = !!workspace;
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [directoryPickerError, setDirectoryPickerError] = useState<string | null>(null);
  const [customUpdatePending, setCustomUpdatePending] = useState(false);
  const createWorkspace = useCreateWorkspace();
  const renameWorkspace = useRenameWorkspace();
  const { data: capabilities } = useWorkspaceCapabilities();
  const { data: runtimes = [] } = useRuntimes();
  const registeredRuntimes = eligibleRuntimes(runtimes);
  const form = useForm<WorkspaceDialogFormValues>({
    resolver: zodResolver(workspaceDialogFormSchema),
    defaultValues: {
      name: workspace?.name ?? defaultWorkspaceName(),
      description: workspace?.description ?? "",
      useGit: false,
      useCustomPath: false,
      placementMode: "managed",
      runtimeType: "local",
      isolationScope: "user",
      gitUrl: "",
      rootPath: "",
      runtimeId: undefined,
    },
  });

  useEffect(() => {
    if (isEdit || !capabilities) return;
    const current = form.getValues("runtimeType");
    const next = capabilities.allowedRuntimeTypes.includes(current)
      ? current
      : capabilities.runtimeType;
    if (next !== current) form.setValue("runtimeType", next);
    const allowedScopes = capabilities.allowedIsolationScopes;
    const currentScope = form.getValues("isolationScope");
    const nextScope = allowedScopes.includes(currentScope)
      ? currentScope
      : capabilities.isolationScope;
    if (nextScope !== currentScope) {
      form.setValue("isolationScope", nextScope);
    }
  }, [capabilities, form, isEdit]);

  async function handleSubmit(values: WorkspaceDialogFormValues) {
    const name = values.name.trim();
    const description = values.description?.trim();
    if (!name) return;
    setSubmitError(null);

    if (isEdit) {
      if (onUpdate) {
        setCustomUpdatePending(true);
        try {
          await onUpdate(workspace.id, { name, description: description || null });
          onOpenChange(false);
        } catch (error) {
          setSubmitError(errorMessage(error, "保存工作空间失败"));
        } finally {
          setCustomUpdatePending(false);
        }
        return;
      }

      renameWorkspace.mutate(
        { id: workspace.id, name, description: description || null },
        {
          onSuccess: () => onOpenChange(false),
          onError: (error) =>
            setSubmitError(errorMessage(error, "保存工作空间失败")),
        },
      );
      return;
    }

    if (values.placementMode === "registered") {
      const selectedRuntime = registeredRuntimes.find(
        (runtime) => runtime.id === values.runtimeId,
      );
      createWorkspace.mutate(
        {
          name,
          description: description || undefined,
          rootPath: normalizeFilesystemPath(values.rootPath ?? ""),
          runtimeId: values.runtimeId,
          isolationScope:
            selectedRuntime?.runtimeType !== "local"
              ? values.isolationScope
              : undefined,
        },
        {
          onSuccess: (created) => {
            onOpenChange(false);
            onCreated?.(created);
          },
          onError: (error) =>
            setSubmitError(errorMessage(error, "创建工作空间失败")),
        },
      );
      return;
    }

    const gitUrl = values.useGit ? values.gitUrl?.trim() : undefined;
    const rootPath = values.useCustomPath
      ? normalizeFilesystemPath(values.rootPath ?? "")
      : undefined;
    const runtimeType = values.runtimeType;
    const isolationScope =
      runtimeType !== "local" ? values.isolationScope : undefined;
    createWorkspace.mutate(
      {
        name,
        description: description || undefined,
        gitUrl,
        rootPath,
        runtimeType,
        isolationScope,
      },
      {
        onSuccess: (created) => {
          onOpenChange(false);
          onCreated?.(created);
        },
        onError: (error) =>
          setSubmitError(errorMessage(error, "创建工作空间失败")),
      },
    );
  }

  async function handleSelectDirectory(onChange: (path: string) => void) {
    const pickerWindow = window as DirectoryPickerWindow;
    const nativePath = await pickerWindow.agework?.selectDirectory?.();
    if (nativePath) {
      setDirectoryPickerError(null);
      onChange(nativePath);
      form.trigger("rootPath");
      return;
    }

    if (pickerWindow.showDirectoryPicker) {
      try {
        const directory = await pickerWindow.showDirectoryPicker();
        setDirectoryPickerError(
          directory.name
            ? `已选择「${directory.name}」，浏览器无法获取绝对路径，请手动输入`
            : "浏览器无法获取绝对路径，请手动输入",
        );
      } catch (error) {
        if ((error as DOMException).name !== "AbortError") {
          setDirectoryPickerError("无法选择目录，请手动输入绝对路径");
        }
      }
      return;
    }

    setDirectoryPickerError("当前环境不支持目录选择，请手动输入绝对路径");
  }

  function getRootPathDescription() {
    if (directoryPickerError) return directoryPickerError;
    return "选择或输入 API 服务器可访问的绝对路径";
  }

  const isPending =
    createWorkspace.isPending || renameWorkspace.isPending || customUpdatePending;
  const nameValue = form.watch("name") ?? "";
  const useGit = form.watch("useGit");
  const useCustomPath = form.watch("useCustomPath");
  const placementMode = form.watch("placementMode");
  const runtimeType = form.watch("runtimeType");
  const isolationScope = form.watch("isolationScope");
  const rootPathValue = form.watch("rootPath") ?? "";
  const runtimeId = form.watch("runtimeId");
  const showPlacementToggle = !isEdit && registeredRuntimes.length > 0;
  const selectedRuntime = registeredRuntimes.find((r) => r.id === runtimeId);
  const selectedRuntimeIsolationScopes =
    selectedRuntime?.capabilities?.isolationScopes ?? [];
  const canSubmitRegistered =
    !!runtimeId &&
    !!rootPathValue.trim() &&
    (selectedRuntime?.runtimeType === "local" ||
      selectedRuntimeIsolationScopes.includes(isolationScope));
  /** managed 场景下,当前 runtimeType 对应的 builtin runtime(浏览目录接口按 runtime 维度调用,
   *  builtin 也有固定的 runtime id)。 */
  const browserDisabled =
    placementMode === "registered" && selectedRuntime?.status !== "online";

  useEffect(() => {
    if (isEdit || !selectedRuntime || selectedRuntime.runtimeType === "local") {
      return;
    }
    const allowedScopes = selectedRuntime.capabilities?.isolationScopes ?? [];
    if (!allowedScopes.includes(isolationScope)) {
      const fallback = allowedScopes[0];
      if (fallback) form.setValue("isolationScope", fallback as never);
    }
  }, [isEdit, form, selectedRuntime, isolationScope]);

  const allowedRuntimeTypes =
    capabilities?.allowedRuntimeTypes ?? [capabilities?.runtimeType ?? "local"];
  const allowedIsolationScopes =
    capabilities?.allowedIsolationScopes ?? [
      capabilities?.isolationScope ?? "user",
    ];
  const canSelectRuntimeType = allowedRuntimeTypes.length > 1;
  const canSelectIsolationScope =
    runtimeType !== "local" && allowedIsolationScopes.length > 1;
  const canSubmitRuntimeType =
    isEdit || (capabilities && allowedRuntimeTypes.includes(runtimeType));
  const canSubmitIsolationScope =
    isEdit ||
    runtimeType === "local" ||
    (capabilities &&
      allowedIsolationScopes.includes(isolationScope));
  const canShowLocalDirectoryOption = canOfferLocalDirectory(
    runtimeType,
    allowedIsolationScopes
  );
  const isLocalDirectorySelectionValid = supportsLocalDirectory(
    runtimeType,
    isolationScope
  );

  // 通过 formId 关联 FormDialog 的 submit 按钮；
  // disabled 条件通过在 form 外面设置 FormDialog 的 submitDisabled prop 传递。
  // 但 FormDialog 的 submitDisabled 是在 WorkspaceDialog 层面设置的，
  // 而 form.watch 的值在 WorkspaceDialogForm 里。
  // 解决方案：form 内部渲染 DialogFooter，绕过 FormDialog 的 footer。
  // 这意味着我们需要让 FormDialog 不渲染自己的 footer，
  // 让 children 里包含 form + footer。

  return (
    <>
      <form id={formId} onSubmit={form.handleSubmit(handleSubmit)}>
        <FieldGroup>
          <Controller
            name="name"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="workspace-name">名称</FieldLabel>
                <Input
                  {...field}
                  id="workspace-name"
                  aria-invalid={fieldState.invalid}
                  maxLength={PROJECT_NAME_MAX_LENGTH}
                  placeholder="输入名称"
                  autoComplete="off"
                  autoFocus
                />
                {fieldState.invalid && (
                  <FieldError errors={[fieldState.error]} />
                )}
              </Field>
            )}
          />

          <Controller
            name="description"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor="workspace-description">描述</FieldLabel>
                <Input
                  {...field}
                  id="workspace-description"
                  aria-invalid={fieldState.invalid}
                  maxLength={PROJECT_DESCRIPTION_MAX_LENGTH}
                  placeholder="输入描述（可选）"
                  autoComplete="off"
                />
                {fieldState.invalid && (
                  <FieldError errors={[fieldState.error]} />
                )}
              </Field>
            )}
          />

          {showPlacementToggle && (
            <Controller
              name="placementMode"
              control={form.control}
              render={({ field }) => (
                <Field>
                  <FieldLabel>运行位置</FieldLabel>
                  <ToggleGroup
                    variant="segment"
                    spacing={0}
                    value={field.value ? [field.value] : []}
                    onValueChange={(value) => {
                      const v = value[0];
                      if (!v || !isPlacementMode(v)) return;
                      field.onChange(v);
                    }}
                    className="grid w-full grid-cols-2"
                  >
                    <ToggleGroupItem value="managed" className="w-full">
                      平台托管
                    </ToggleGroupItem>
                    <ToggleGroupItem value="registered" className="w-full">
                      我的运行环境
                    </ToggleGroupItem>
                  </ToggleGroup>
                </Field>
              )}
            />
          )}

          {isEdit ? (
            workspace.gitUrl && (
              <Field data-disabled>
                <FieldLabel htmlFor="workspace-git">Git 地址</FieldLabel>
                <Input
                  id="workspace-git"
                  value={workspace.gitUrl}
                  readOnly
                  disabled
                />
              </Field>
            )
          ) : placementMode === "registered" ? (
            <>
              <Controller
                name="runtimeId"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel>选择机器</FieldLabel>
                    <ToggleGroup
                      variant="segment"
                      spacing={0}
                      value={field.value ? [field.value] : []}
                      onValueChange={(value) => {
                        const v = value[0];
                        if (!v) return;
                        field.onChange(v);
                      }}
                      className="grid w-full grid-cols-1"
                    >
                      {registeredRuntimes.map((runtime) => (
                        <ToggleGroupItem
                          key={runtime.id}
                          value={runtime.id}
                          className="w-full justify-between"
                        >
                          <span>{runtime.name}</span>
                          <span className="text-xs text-muted-foreground">
                            {runtimeTypeLabel(
                              runtime.runtimeType as WorkspaceRuntimeType
                            )}
                            {" · "}
                            {runtime.status === "online" ? "在线" : "离线"}
                          </span>
                        </ToggleGroupItem>
                      ))}
                    </ToggleGroup>
                    {fieldState.invalid && (
                      <FieldError errors={[fieldState.error]} />
                    )}
                  </Field>
                )}
              />

              {selectedRuntime && selectedRuntime.runtimeType !== "local" && (
                <Controller
                  name="isolationScope"
                  control={form.control}
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid}>
                      <FieldLabel>沙箱隔离级别</FieldLabel>
                      <ToggleGroup
                        variant="segment"
                        spacing={0}
                        value={field.value ? [field.value] : []}
                        onValueChange={(value) => {
                          const v = value[0];
                          if (!v || !isIsolationScope(v)) return;
                          field.onChange(v);
                        }}
                        className="grid w-full grid-cols-2"
                      >
                        {selectedRuntimeIsolationScopes.map((scope) => (
                          <ToggleGroupItem
                            key={scope}
                            value={scope}
                            className="w-full"
                          >
                            {scope === "user" ? "用户" : "工作空间"}
                          </ToggleGroupItem>
                        ))}
                      </ToggleGroup>
                      {fieldState.invalid && (
                        <FieldError errors={[fieldState.error]} />
                      )}
                    </Field>
                  )}
                />
              )}

              <Controller
                name="rootPath"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="workspace-remote-root-path">
                      目录
                    </FieldLabel>
                    <div className="flex items-center gap-2">
                      <Input
                        {...field}
                        id="workspace-remote-root-path"
                        aria-invalid={fieldState.invalid}
                        placeholder="该运行环境上的绝对路径"
                        autoComplete="off"
                        onBlur={() => {
                          const normalized = normalizeFilesystemPath(
                            field.value ?? ""
                          );
                          if (normalized !== field.value) {
                            field.onChange(normalized);
                          }
                        }}
                      />
                    </div>
                    <FieldDescription>
                      {browserDisabled
                        ? "该运行环境未连接,暂时无法浏览,请手动填写绝对路径"
                        : "选择或填写该运行环境上的绝对路径"}
                    </FieldDescription>
                    {fieldState.invalid && (
                      <FieldError errors={[fieldState.error]} />
                    )}
                  </Field>
                )}
              />
            </>
          ) : (
            <>
              {canSelectRuntimeType && (
                <Controller
                  name="runtimeType"
                  control={form.control}
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid}>
                      <FieldLabel>运行环境</FieldLabel>
                      <ToggleGroup
                        variant="segment"
                        spacing={0}
                        value={field.value ? [field.value] : []}
                        onValueChange={(value) => {
                          const v = value[0];
                          if (!v || !isWorkspaceRuntimeType(v)) return;
                          const next = resolveRuntimeTypeChange({
                            runtimeType: v,
                            currentScope: form.getValues("isolationScope"),
                            useCustomPath: form.getValues("useCustomPath"),
                            allowedScopes: allowedIsolationScopes,
                            defaultScope:
                              capabilities?.isolationScope ?? "user",
                          });
                          field.onChange(v);
                          form.setValue(
                            "isolationScope",
                            next.isolationScope
                          );
                          if (!next.useCustomPath) {
                            form.setValue("useCustomPath", false);
                          }
                        }}
                        className={
                          allowedRuntimeTypes.length === 3
                            ? "grid w-full grid-cols-3"
                            : "grid w-full grid-cols-2"
                        }
                      >
                        {allowedRuntimeTypes.map((type) => (
                          <ToggleGroupItem
                            key={type}
                            value={type}
                            className="w-full"
                          >
                            {runtimeTypeLabel(type)}
                          </ToggleGroupItem>
                        ))}
                      </ToggleGroup>
                      {fieldState.invalid && (
                        <FieldError errors={[fieldState.error]} />
                      )}
                    </Field>
                  )}
                />
              )}

              {canSelectIsolationScope && (
                <Controller
                  name="isolationScope"
                  control={form.control}
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid}>
                      <FieldLabel>沙箱隔离级别</FieldLabel>
                      <ToggleGroup
                        variant="segment"
                        spacing={0}
                        value={field.value ? [field.value] : []}
                        onValueChange={(value) => {
                          const v = value[0];
                          if (!v || !isIsolationScope(v)) return;
                          field.onChange(v);
                          if (
                            v !== "workspace" &&
                            form.getValues("useCustomPath")
                          ) {
                            form.setValue("useCustomPath", false);
                          }
                        }}
                        className="grid w-full grid-cols-2"
                      >
                        {allowedIsolationScopes.map((scope) => (
                          <ToggleGroupItem
                            key={scope}
                            value={scope}
                            className="w-full"
                          >
                            {scope === "user" ? "用户" : "工作空间"}
                          </ToggleGroupItem>
                        ))}
                      </ToggleGroup>
                      <FieldDescription>
                        {getIsolationScopeDescription(field.value)}
                      </FieldDescription>
                      {fieldState.invalid && (
                        <FieldError errors={[fieldState.error]} />
                      )}
                    </Field>
                  )}
                />
              )}

              <Field>
                {canShowLocalDirectoryOption && (
                <div className="flex items-center gap-2">
                  <Controller
                    name="useCustomPath"
                    control={form.control}
                    render={({ field: cb }) => (
                      <>
                        <Checkbox
                          id="use-custom-path"
                          checked={cb.value}
                          onCheckedChange={(checked) => {
                            const nextChecked = !!checked;
                            cb.onChange(nextChecked);
                            if (nextChecked) {
                              form.setValue("useGit", false);
                              const nextScope =
                                runtimeType !== "local" &&
                                allowedIsolationScopes.includes("workspace")
                                  ? "workspace"
                                  : undefined;
                              if (nextScope) {
                                form.setValue("isolationScope", nextScope);
                              }
                            }
                          }}
                        />
                        <label
                          htmlFor="use-custom-path"
                          className="text-sm cursor-pointer"
                        >
                          指定本地目录
                        </label>
                      </>
                    )}
                  />
                </div>
                )}

                {useCustomPath && (
                  <Controller
                    name="rootPath"
                    control={form.control}
                    render={({ field, fieldState }) => {
                      const showPicker = hasNativeDirectoryPicker();
                      return (
                      <Field data-invalid={fieldState.invalid} className="mt-2">
                        <div className="flex items-center gap-2">
                          <div className="relative flex-1">
                            <Input
                              {...field}
                              id="workspace-root-path"
                              aria-invalid={fieldState.invalid}
                              placeholder={detectPathHint()}
                              autoComplete="off"
                              className={showPicker ? "pr-10" : ""}
                              onChange={(event) => {
                                setDirectoryPickerError(null);
                                field.onChange(event);
                              }}
                              onBlur={() => {
                                const normalized = normalizeFilesystemPath(field.value ?? "");
                                if (normalized !== field.value) {
                                  field.onChange(normalized);
                                }
                              }}
                            />
                            {showPicker && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="absolute right-1 top-1/2 size-7 -translate-y-1/2 text-muted-foreground"
                                aria-label="选择目录"
                                onClick={() => handleSelectDirectory(field.onChange)}
                              >
                                <FolderOpenIcon className="size-4" />
                              </Button>
                            )}
                          </div>
                        </div>
                        <FieldDescription>
                          {getRootPathDescription()}
                        </FieldDescription>
                        {fieldState.invalid && (
                          <FieldError errors={[fieldState.error]} />
                        )}
                      </Field>
                      );
                    }}
                  />
                )}

                <div className="mt-3 flex items-center gap-2">
                  <Controller
                    name="useGit"
                    control={form.control}
                    render={({ field: cb }) => (
                      <>
                        <Checkbox
                          id="use-git"
                          checked={cb.value}
                          onCheckedChange={(checked) => {
                            cb.onChange(!!checked);
                            if (checked) form.setValue("useCustomPath", false);
                          }}
                        />
                        <label
                          htmlFor="use-git"
                          className="text-sm cursor-pointer"
                        >
                          从 Git 仓库克隆
                        </label>
                      </>
                    )}
                  />
                </div>

                {useGit && (
                  <Controller
                    name="gitUrl"
                    control={form.control}
                    render={({ field, fieldState }) => (
                      <Field data-invalid={fieldState.invalid} className="mt-2">
                        <Input
                          {...field}
                          id="workspace-git"
                          aria-invalid={fieldState.invalid}
                          placeholder="https://github.com/user/repo.git"
                          autoComplete="off"
                        />
                        <FieldDescription>支持 HTTPS 或 SSH 地址</FieldDescription>
                        {fieldState.invalid && (
                          <FieldError errors={[fieldState.error]} />
                        )}
                      </Field>
                    )}
                  />
                )}
              </Field>
            </>
          )}

          {submitError && <FieldError>{submitError}</FieldError>}
        </FieldGroup>
      </form>

      {useGit && isPending && (
        <FieldDescription>
          正在克隆仓库，可能需要几分钟，请勿关闭该窗口...
        </FieldDescription>
      )}

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={() => onOpenChange(false)}
          disabled={isPending}
        >
          取消
        </Button>
        <Button
          type="submit"
          form={formId}
          disabled={
            !nameValue.trim() ||
            isPending ||
            (placementMode === "registered"
              ? !canSubmitRegistered
              : !canSubmitRuntimeType ||
                !canSubmitIsolationScope ||
                (useCustomPath &&
                  (!isLocalDirectorySelectionValid || !rootPathValue.trim())))
          }
        >
          {isPending
            ? useGit
              ? "克隆中..."
              : "保存中..."
            : (submitLabel ?? (isEdit ? "保存" : "创建"))}
        </Button>
      </DialogFooter>

    </>
  );
}

function isWorkspaceRuntimeType(value: string): value is WorkspaceRuntimeType {
  return RUNTIME_TYPES.includes(value as WorkspaceRuntimeType);
}

function isPlacementMode(value: string): value is PlacementMode {
  return PLACEMENT_MODES.includes(value as PlacementMode);
}

function runtimeTypeLabel(type: WorkspaceRuntimeType) {
  switch (type) {
    case "local":
      return "本地";
    case "docker":
      return "Docker";
    case "opensandbox":
      return "OpenSandbox";
  }
}

function isIsolationScope(
  value: string
): value is WorkspaceIsolationScope {
  return value === "user" || value === "workspace";
}

function getIsolationScopeDescription(scope: WorkspaceIsolationScope) {
  return scope === "user"
    ? "用户级沙箱会复用当前用户的隔离环境，适合共享依赖和缓存。"
    : "工作空间级沙箱会为该工作空间单独隔离环境，适合需要独立状态的项目。";
}

function supportsLocalDirectory(
  runtimeType: WorkspaceRuntimeType,
  isolationScope?: WorkspaceIsolationScope
) {
  return runtimeType === "local" || isolationScope === "workspace";
}

function canOfferLocalDirectory(
  runtimeType: WorkspaceRuntimeType,
  allowedScopes: WorkspaceIsolationScope[]
) {
  return runtimeType === "local" || allowedScopes.includes("workspace");
}

function resolveRuntimeTypeChange({
  runtimeType,
  currentScope,
  useCustomPath,
  allowedScopes,
  defaultScope,
}: {
  runtimeType: WorkspaceRuntimeType;
  currentScope: WorkspaceIsolationScope;
  useCustomPath: boolean;
  allowedScopes: WorkspaceIsolationScope[];
  defaultScope: WorkspaceIsolationScope;
}): {
  isolationScope: WorkspaceIsolationScope;
  useCustomPath: boolean;
} {
  if (runtimeType === "local") {
    return { isolationScope: "user", useCustomPath };
  }

  const fallbackScope = allowedScopes.includes(defaultScope)
    ? defaultScope
    : (allowedScopes[0] ?? "user");
  const isolationScope = allowedScopes.includes(currentScope)
    ? currentScope
    : fallbackScope;

  if (!useCustomPath) {
    return { isolationScope, useCustomPath };
  }

  if (allowedScopes.includes("workspace")) {
    return { isolationScope: "workspace", useCustomPath };
  }

  return { isolationScope, useCustomPath: false };
}
