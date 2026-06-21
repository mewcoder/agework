import { useState, useCallback } from "react";
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

/**
 * 删除确认弹窗状态管理 hook
 *
 * 用于管理删除确认弹窗的打开/关闭状态和目标对象
 *
 * @example
 * // 基于对象的删除
 * const deleteDialog = useConfirmDelete<ModelProvider>();
 * // 在删除按钮上：onClick={() => deleteDialog.requestDelete(item)}
 * // 传给组件：<ConfirmDeleteDialog open={deleteDialog.isOpen} onOpenChange={deleteDialog.onOpenChange} targetName={deleteDialog.target?.name} ... />
 *
 * @example
 * // 基于布尔值的删除（批量删除等场景）
 * const deleteDialog = useConfirmDelete();
 * // 在删除按钮上：onClick={() => deleteDialog.requestDelete()}
 * // 传给组件：<ConfirmDeleteDialog open={deleteDialog.isOpen} onOpenChange={deleteDialog.onOpenChange} description="将删除所有..." ... />
 */
export function useConfirmDelete<T extends object = object>() {
  const [target, setTarget] = useState<T | undefined>();

  const cancelDelete = useCallback(() => setTarget(undefined), []);

  /** 适配 AlertDialog 的 onOpenChange 回调 */
  const onOpenChange = useCallback(
    (isOpen: boolean) => {
      if (!isOpen) cancelDelete();
    },
    [cancelDelete],
  );

  return {
    /** 当前删除目标对象 */
    target,
    /** 弹窗是否打开 */
    isOpen: target !== undefined,
    /** 请求删除（传入目标对象） */
    requestDelete: (item: T) => setTarget(item),
    /** 取消删除 */
    cancelDelete,
    /** AlertDialog onOpenChange 回调 */
    onOpenChange,
  };
}

/**
 * 无目标对象的删除确认状态管理 hook
 *
 * 用于批量删除等不需要具体目标对象的场景
 *
 * @example
 * const { isOpen, open, close } = useBooleanConfirmDelete();
 * // 在删除按钮上：onClick={() => open()}
 * // 传给组件：<ConfirmDeleteDialog open={isOpen} description="将删除所有..." ... />
 */
export function useBooleanConfirmDelete() {
  const [isOpen, setIsOpen] = useState(false);

  return {
    isOpen,
    open: () => setIsOpen(true),
    close: () => setIsOpen(false),
  };
}
