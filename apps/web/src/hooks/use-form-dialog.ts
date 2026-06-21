import { useState, useCallback } from "react";

/**
 * 表单弹窗状态管理 hook
 *
 * 统一管理新建/编辑弹窗的打开/关闭状态和编辑目标对象
 *
 * @example
 * const formDialog = useFormDialog<ModelProvider>();
 *
 * // 新建按钮
 * <Button onClick={formDialog.openCreate}>新建</Button>
 *
 * // 编辑按钮
 * <Button onClick={() => formDialog.openEdit(item)}>编辑</Button>
 *
 * // 弹窗组件
 * <Dialog open={formDialog.open} onOpenChange={formDialog.onOpenChange}>
 *   <ModelProviderForm
 *     key={formDialog.target?.id ?? 'create'}
 *     defaultValues={formDialog.target}
 *     isEditing={formDialog.isEditing}
 *   />
 * </Dialog>
 */
export function useFormDialog<T>() {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<T | undefined>();

  const openCreate = useCallback(() => {
    setTarget(undefined);
    setOpen(true);
  }, []);

  const openEdit = useCallback((item: T) => {
    setTarget(item);
    setOpen(true);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setTarget(undefined);
  }, []);

  /** 适配 Dialog 的 onOpenChange 回调 */
  const onOpenChange = useCallback(
    (isOpen: boolean) => {
      if (!isOpen) {
        close();
      } else {
        setOpen(true);
      }
    },
    [close],
  );

  return {
    /** 弹窗是否打开 */
    open,
    /** 编辑目标对象，undefined 表示新建模式 */
    target,
    /** 是否处于编辑模式 */
    isEditing: target !== undefined,
    /** 打开新建弹窗 */
    openCreate,
    /** 打开编辑弹窗 */
    openEdit,
    /** 关闭弹窗并重置状态 */
    close,
    /** Dialog onOpenChange 回调 */
    onOpenChange,
  };
}
