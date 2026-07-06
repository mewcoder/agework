import { useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";
import { PlusIcon, Trash2 } from "lucide-react";
import { FormDialog } from "@/components/form-dialog";
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import {
  DataTable,
  DataTableActionButton,
  DataTableActions,
  DataTableBadge,
  DataTableEmpty,
  DataTableText,
  type DataTableColumnDef,
} from "@/components/data-table";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useConfirmDelete } from "@/hooks/use-confirm-delete";
import {
  useCreateRuntime,
  useDeleteRuntime,
  useRuntimes,
  type CreateRuntimeResponse,
  type Runtime,
} from "@/hooks/use-runtime";
import { SettingsPageHeader } from "@/components/settings/settings-panel";
import { formatDateTime } from "@/utils/format";
import { errorMessage } from "@/utils/error";
import { IssuedRuntimeTokenDialog } from "./runtime/issued-runtime-token-dialog";

const NAME_MAX_LENGTH = 40;

const createRuntimeFormSchema = z.object({
  name: z.string().refine((value) => value.trim().length > 0, {
    message: "请输入名称",
  }),
});

type CreateRuntimeFormValues = z.infer<typeof createRuntimeFormSchema>;

function runtimeTypeLabel(runtimeType: string | null) {
  switch (runtimeType) {
    case "local":
      return "本地";
    case "docker":
      return "Docker";
    case "opensandbox":
      return "OpenSandbox";
    default:
      return "待配对";
  }
}

export function RuntimeSettings() {
  const { data: runtimes = [], isLoading } = useRuntimes();
  const deleteRuntime = useDeleteRuntime();
  const deleteDialog = useConfirmDelete<Runtime>();
  const [createOpen, setCreateOpen] = useState(false);
  const [issuedToken, setIssuedToken] = useState<CreateRuntimeResponse | null>(
    null
  );

  const columns: DataTableColumnDef<Runtime>[] = [
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
        <DataTableText>{runtimeTypeLabel(row.original.runtimeType)}</DataTableText>
      ),
    },
    {
      id: "status",
      header: "状态",
      cell: ({ row }) => (
        <DataTableBadge variant={row.original.status === "online" ? "default" : "secondary"}>
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
    {
      id: "actions",
      header: "操作",
      meta: { headerClassName: "pr-4 text-right", cellClassName: "pr-4 text-right" },
      cell: ({ row }) => {
        // builtin 是全局内置运行环境，所有人可用、不可删除，不渲染删除按钮。
        if (row.original.source === "builtin") return null;
        return (
          <DataTableActions>
            <DataTableActionButton
              tone="destructive"
              aria-label={`删除运行环境 ${row.original.name}`}
              onClick={() => deleteDialog.requestDelete(row.original)}
            >
              <Trash2 />
            </DataTableActionButton>
          </DataTableActions>
        );
      },
    },
  ];

  return (
    <div className="space-y-6">
      <SettingsPageHeader
        title="我的运行环境"
        description="添加远程机器作为 Registered Runtime，配对后可在其上运行 Agent"
      />

      <div className="flex justify-end">
        <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
          <PlusIcon className="mr-1 h-3.5 w-3.5" />
          添加机器
        </Button>
      </div>

      <DataTable
        columns={columns}
        data={runtimes}
        isLoading={isLoading}
        emptyText="暂无运行环境"
        tableClassName="min-w-[640px]"
        wrapperClassName="max-h-[calc(100vh-280px)] overflow-auto rounded-lg border overscroll-contain"
        getRowId={(runtime) => runtime.id}
      />

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
  const formId = "create-runtime-form";
  const [submitError, setSubmitError] = useState<string | null>(null);
  const createRuntime = useCreateRuntime();
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
          setSubmitError(errorMessage(error, "添加运行环境失败")),
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
