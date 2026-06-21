import { useCallback } from "react";
import { SquareIcon } from "lucide-react";
import { useStopConversationRun } from "@/hooks/use-conversations";
import { Button } from "@/components/ui/button";

export function StopConversationRunButton({
  conversationId,
  className,
  iconClassName,
}: {
  conversationId?: string;
  className?: string;
  iconClassName?: string;
}) {
  const { mutate, isPending, variables } = useStopConversationRun();
  const isStopping = isPending && variables === conversationId;

  const handleStop = useCallback(() => {
    if (!conversationId || isStopping) return;
    mutate(conversationId);
  }, [isStopping, mutate, conversationId]);

  return (
    <Button
      type="button"
      variant="default"
      size="icon"
      className={className}
      aria-label="停止后台运行"
      title="停止"
      disabled={!conversationId || isStopping}
      onClick={handleStop}
    >
      <SquareIcon className={iconClassName ?? "size-3 fill-current"} />
    </Button>
  );
}
