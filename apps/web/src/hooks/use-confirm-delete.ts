import { useState, useCallback } from "react";

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
