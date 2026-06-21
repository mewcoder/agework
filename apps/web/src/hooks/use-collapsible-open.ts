import { useCallback, useState } from "react";

/**
 * 受控 / 非受控折叠状态的通用 Hook。
 * 消除 ToolFallbackRoot、ReasoningRoot 中重复的 controlled/uncontrolled 逻辑。
 */
export function useCollapsibleOpen(
  controlledOpen: boolean | undefined,
  controlledOnOpenChange: ((open: boolean) => void) | undefined,
  defaultOpen: boolean,
) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);

  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : uncontrolledOpen;

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!isControlled) {
        setUncontrolledOpen(open);
      }
      controlledOnOpenChange?.(open);
    },
    [isControlled, controlledOnOpenChange],
  );

  return { isOpen, handleOpenChange };
}
