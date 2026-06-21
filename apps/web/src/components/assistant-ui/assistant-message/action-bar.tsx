import {
  ActionBarMorePrimitive,
  ActionBarPrimitive,
} from "@assistant-ui/react";
import {
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  MoreHorizontalIcon,
  RefreshCwIcon,
} from "lucide-react";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { useRunDurationText } from "@/hooks/use-run-duration-text";
import { type GroupableMessagePart } from "@/components/assistant-ui/thread-utils";
import { useCopyMessageText } from "@/hooks/use-copy-message";

export function RunDuration() {
  const text = useRunDurationText();
  if (text == null) return null;

  return (
    <span className="text-xs text-muted-foreground tabular-nums">
      耗时：{text}
    </span>
  );
}

function AssistantCopyButton({
  messageParts,
  processTitleTextParts,
}: {
  messageParts: readonly GroupableMessagePart[];
  processTitleTextParts: WeakSet<GroupableMessagePart> | null;
}) {
  const { copied, handleCopy } = useCopyMessageText(messageParts, processTitleTextParts);

  return (
    <TooltipIconButton tooltip="复制" onClick={handleCopy}>
      {copied ? <CheckIcon /> : <CopyIcon />}
    </TooltipIconButton>
  );
}

export function AssistantActionBar({
  messageParts,
  processTitleTextParts,
}: {
  messageParts: readonly GroupableMessagePart[];
  processTitleTextParts: WeakSet<GroupableMessagePart> | null;
}) {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-assistant-action-bar-root col-start-3 row-start-2 -ms-1 flex gap-1 text-muted-foreground"
    >
      <AssistantCopyButton
        messageParts={messageParts}
        processTitleTextParts={processTitleTextParts}
      />
      <ActionBarPrimitive.Reload asChild>
        <TooltipIconButton tooltip="重新生成">
          <RefreshCwIcon />
        </TooltipIconButton>
      </ActionBarPrimitive.Reload>
      <ActionBarMorePrimitive.Root>
        <ActionBarMorePrimitive.Trigger asChild>
          <TooltipIconButton
            tooltip="更多"
            className="data-[state=open]:bg-accent"
          >
            <MoreHorizontalIcon />
          </TooltipIconButton>
        </ActionBarMorePrimitive.Trigger>
        <ActionBarMorePrimitive.Content
          side="bottom"
          align="start"
          className="aui-action-bar-more-content z-50 min-w-32 overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          <ActionBarPrimitive.ExportMarkdown asChild>
            <ActionBarMorePrimitive.Item className="aui-action-bar-more-item flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground">
              <DownloadIcon className="size-4" />
              导出为 Markdown
            </ActionBarMorePrimitive.Item>
          </ActionBarPrimitive.ExportMarkdown>
        </ActionBarMorePrimitive.Content>
      </ActionBarMorePrimitive.Root>
    </ActionBarPrimitive.Root>
  );
}
