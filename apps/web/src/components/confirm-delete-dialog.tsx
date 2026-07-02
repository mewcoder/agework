import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/**
 * 通用删除确认弹窗组件
 *
 * 支持两种模式：
 * 1. 基于对象：传入 target 对象，自动显示 name
 * 2. 基于布尔值：不传 target，使用自定义 description
 */
export interface ConfirmDeleteDialogProps {
  /** 弹窗是否打开 */
  open: boolean;
  /** 弹窗开关回调 */
  onOpenChange: (open: boolean) => void;
  /** 确认删除回调 */
  onConfirm: () => void;
  /** 是否正在删除 */
  isPending?: boolean;
  /** 弹窗标题，默认 "确认删除？" */
  title?: string;
  /** 删除对象名称（基于对象模式） */
  targetName?: string;
  /** 自定义描述文案（基于布尔值模式，优先级高于 targetName） */
  description?: string;
  /** 确认按钮文案，默认 "删除" */
  confirmLabel?: string;
  /** 删除中按钮文案，默认 "删除中..." */
  pendingLabel?: string;
}

export function ConfirmDeleteDialog({
  open,
  onOpenChange,
  onConfirm,
  isPending = false,
  title = "确认删除？",
  targetName,
  description,
  confirmLabel = "删除",
  pendingLabel = "删除中...",
}: ConfirmDeleteDialogProps) {
  const displayDescription =
    description ?? (targetName ? `确认删除「${targetName}」？此操作不可恢复` : "确认删除？此操作不可恢复");

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{displayDescription}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>取消</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={isPending}
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
          >
            {isPending ? pendingLabel : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
