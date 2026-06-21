import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

/**
 * 通用表单弹窗容器组件
 *
 * 封装了表单弹窗的外壳结构：Dialog + DialogHeader + DialogFooter
 * 内部表单内容通过 children 传入
 *
 * 当 footer="none" 时，不渲染内置 DialogFooter，children 自行管理 footer。
 * 适用于 submit 按钮的 disabled 条件需要从 form 内部控制的场景。
 *
 * @example
 * // 简单用法：FormDialog 自带取消+提交按钮
 * <FormDialog
 *   open={open}
 *   onOpenChange={onOpenChange}
 *   title="新建工作空间"
 *   formId="my-form"
 *   isPending={isPending}
 *   submitLabel="创建"
 * >
 *   <MyFormContent />
 * </FormDialog>
 *
 * // 自定义 footer：children 包含 form + DialogFooter
 * <FormDialog
 *   open={open}
 *   onOpenChange={onOpenChange}
 *   title="新建工作空间"
 *   footer="none"
 * >
 *   <MyFormWithFooter />
 * </FormDialog>
 */
export interface FormDialogProps {
  /** 弹窗是否打开 */
  open: boolean;
  /** 弹窗开关回调 */
  onOpenChange: (open: boolean) => void;
  /** 弹窗标题 */
  title: string;
  /** 弹窗描述 */
  description?: string;
  /** 表单 ID，用于关联提交按钮 */
  formId?: string;
  /** 是否正在提交 */
  isPending?: boolean;
  /** 提交按钮文案，默认 "保存" */
  submitLabel?: string;
  /** 提交按钮禁用条件 */
  submitDisabled?: boolean;
  /** "none" 则不渲染内置 footer，children 自行管理 */
  footer?: "default" | "none";
  /** 自定义 className */
  className?: string;
  /** 表单内容 */
  children: React.ReactNode;
}

export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  formId,
  isPending = false,
  submitLabel = "保存",
  submitDisabled = false,
  footer = "default",
  className,
  children,
}: FormDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={className ?? "sm:max-w-lg"}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        {open && children}

        {footer !== "none" && (
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
              disabled={submitDisabled || isPending}
            >
              {isPending ? "保存中..." : submitLabel}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
