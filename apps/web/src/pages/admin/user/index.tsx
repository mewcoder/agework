import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CheckIcon,
  KeyRoundIcon,
  PowerIcon,
  PowerOffIcon,
  Trash2Icon,
} from "lucide-react";
import {
  usersApi,
  type PasswordIssueResponse,
  type User,
} from "@/api/users";
import { useAuthStore } from "@/stores/auth-store";
import { ConfirmDeleteDialog, useConfirmDelete } from "@/components/confirm-delete-dialog";
import { Button } from "@/components/ui/button";
import {
  DataTable,
  DataTableActionButton,
  DataTableActions,
  DataTableBadge,
  DataTableText,
  type DataTableColumnDef,
} from "@/components/data-table";
import { usePagination } from "@/hooks/use-pagination";
import { PaginationBar } from "@/components/pagination-bar";
import { cn } from "@/lib/utils";
import { formatDateTime } from "@/utils/format";
import { roleLabel } from "@/utils/auth";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { CreateUserDialogForm } from "./create-user-dialog";
import { IssuedPasswordDialog } from "./issued-password-dialog";

function statusLabel(status: User["status"]) {
  if (status === "pending") return "待审批";
  if (status === "disabled") return "已停用";
  return "正常";
}

function statusVariant(status: User["status"]) {
  if (status === "pending") return "outline" as const;
  if (status === "disabled") return "destructive" as const;
  return "secondary" as const;
}

function canManage(currentRole: string | undefined, target: User) {
  if (target.role === "super_admin") return false;
  if (currentRole === "super_admin") return true;
  return target.role === "user";
}

export function UsersPanel({
  showHeader = true,
}: {
  showHeader?: boolean;
}) {
  const qc = useQueryClient();
  const currentUser = useAuthStore((s) => s.user);
  const { pageNo, pageSize, goPrev, goNext } = usePagination();

  const { data, isLoading } = useQuery({
    queryKey: ["admin", "users", pageNo],
    queryFn: () => usersApi.list({ pageNo, pageSize }),
  });

  const users = data?.list ?? [];
  const total = data?.total ?? 0;

  const [createOpen, setCreateOpen] = useState(false);
  const deleteDialog = useConfirmDelete<{ id: string; name: string }>();
  const [issuedPassword, setIssuedPassword] =
    useState<PasswordIssueResponse | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["admin", "users"] });

  const approveMutation = useMutation({
    mutationFn: (id: string) => usersApi.approve({ id }),
    onSuccess: invalidate,
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: "active" | "disabled" }) =>
      usersApi.update(id, { status }),
    onSuccess: invalidate,
  });

  const resetMutation = useMutation({
    mutationFn: (id: string) => usersApi.resetPassword({ id }),
    onSuccess: (result) => {
      setIssuedPassword(result);
      invalidate();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => usersApi.delete({ id }),
    onSuccess: () => {
      invalidate();
      deleteDialog.cancelDelete();
    },
  });

  const userColumns: DataTableColumnDef<User>[] = [
    {
      id: "username",
      header: "用户名",
      meta: { headerClassName: "pl-4", cellClassName: "pl-4" },
      cell: ({ row }) => {
        const u = row.original;
        const isSelf = u.id === currentUser?.id;

        return (
          <DataTableText className="font-medium">
            {u.username}
            {isSelf && (
              <span className="ml-2 text-xs text-muted-foreground">
                (你)
              </span>
            )}
          </DataTableText>
        );
      },
    },
    {
      id: "nickname",
      header: "昵称",
      cell: ({ row }) => (
        <DataTableText>{row.original.nickname ?? "—"}</DataTableText>
      ),
    },
    {
      id: "role",
      header: "角色",
      cell: ({ row }) => (
        <DataTableBadge
          variant={row.original.role === "super_admin" ? "default" : "outline"}
        >
          {roleLabel(row.original.role)}
        </DataTableBadge>
      ),
    },
    {
      id: "status",
      header: "状态",
      cell: ({ row }) => (
        <DataTableBadge variant={statusVariant(row.original.status)}>
          {statusLabel(row.original.status)}
        </DataTableBadge>
      ),
    },
    {
      id: "password",
      header: "密码",
      cell: ({ row }) => (
        <DataTableBadge
          variant={row.original.mustChangePassword ? "destructive" : "outline"}
        >
          {row.original.mustChangePassword ? "需改密" : "正式密码"}
        </DataTableBadge>
      ),
    },
    {
      id: "createdAt",
      header: "创建时间",
      cell: ({ row }) => <DataTableText>{formatDateTime(row.original.createdAt)}</DataTableText>,
    },
    {
      id: "actions",
      header: "操作",
      meta: { headerClassName: "pr-4 text-right", cellClassName: "pr-4 text-right" },
      cell: ({ row }) => {
        const u = row.original;
        const manageable = canManage(currentUser?.role, u);
        const isSelf = u.id === currentUser?.id;
        const canDelete = manageable && u.role === "user" && !isSelf;
        const nextStatus = u.status === "disabled" ? "active" : "disabled";

        return (
          <DataTableActions>
            {u.status === "pending" && manageable && (
              <Tooltip>
                <TooltipTrigger render={
                  <DataTableActionButton
                    aria-label={`审批用户 ${u.username}`}
                    disabled={approveMutation.isPending}
                    onClick={() => approveMutation.mutate(u.id)}
                  >
                    <CheckIcon />
                  </DataTableActionButton>
                } />
                <TooltipContent>审批通过</TooltipContent>
              </Tooltip>
            )}
            {manageable && u.status !== "pending" && (
              <Tooltip>
                <TooltipTrigger render={
                  <DataTableActionButton
                    aria-label={`生成用户 ${u.username} 的临时密码`}
                    disabled={resetMutation.isPending}
                    onClick={() => resetMutation.mutate(u.id)}
                  >
                    <KeyRoundIcon />
                  </DataTableActionButton>
                } />
                <TooltipContent>生成临时密码</TooltipContent>
              </Tooltip>
            )}
            {manageable && !isSelf && u.status !== "pending" && (
              <Tooltip>
                <TooltipTrigger render={
                  <DataTableActionButton
                    aria-label={`${nextStatus === "disabled" ? "停用" : "启用"}用户 ${u.username}`}
                    disabled={toggleMutation.isPending}
                    onClick={() =>
                      toggleMutation.mutate({
                        id: u.id,
                        status: nextStatus,
                      })
                    }
                  >
                    {nextStatus === "disabled" ? <PowerOffIcon /> : <PowerIcon />}
                  </DataTableActionButton>
                } />
                <TooltipContent>
                  {nextStatus === "disabled" ? "停用" : "启用"}
                </TooltipContent>
              </Tooltip>
            )}
            {canDelete && (
              <Tooltip>
                <TooltipTrigger render={
                  <DataTableActionButton
                    tone="destructive"
                    aria-label={`删除用户 ${u.username}`}
                    disabled={deleteMutation.isPending}
                    onClick={() => deleteDialog.requestDelete({ id: u.id, name: u.username })}
                  >
                    <Trash2Icon />
                  </DataTableActionButton>
                } />
                <TooltipContent>删除</TooltipContent>
              </Tooltip>
            )}
          </DataTableActions>
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
            <h2 className="text-lg font-semibold">用户管理</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              管理注册审批、账号状态和临时密码
            </p>
          </div>
        )}
        <Button onClick={() => setCreateOpen(true)}>新建用户</Button>
      </div>

      <DataTable
        columns={userColumns}
        data={users}
        isLoading={isLoading}
        emptyText="暂无用户"
        tableClassName="min-w-[720px]"
        getRowId={(u) => u.id}
      />

      <PaginationBar
        pageNo={pageNo}
        pageSize={pageSize}
        total={total}
        onPrev={() => goPrev(total)}
        onNext={() => goNext(total)}
      />

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>新建用户</DialogTitle>
            <DialogDescription>
              系统会生成一次性初始密码，用户首次登录后必须修改
            </DialogDescription>
          </DialogHeader>
          {createOpen && (
            <CreateUserDialogForm
              canCreateAdmin={currentUser?.role === "super_admin"}
              onCreated={setIssuedPassword}
              onOpenChange={setCreateOpen}
            />
          )}
        </DialogContent>
      </Dialog>

      <IssuedPasswordDialog
        result={issuedPassword}
        onOpenChange={(open) => {
          if (!open) setIssuedPassword(null);
        }}
      />

      <ConfirmDeleteDialog
        open={deleteDialog.isOpen}
        onOpenChange={deleteDialog.onOpenChange}
        onConfirm={() => {
          if (!deleteDialog.target) return;
          deleteMutation.mutate(deleteDialog.target.id);
        }}
        isPending={deleteMutation.isPending}
        title="确认删除用户？"
        targetName={deleteDialog.target?.name}
        description={deleteDialog.target ? `将删除用户「${deleteDialog.target.name}」，此操作不可撤销` : undefined}
      />
    </div>
  );
}
