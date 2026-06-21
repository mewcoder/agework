import { memo } from "react";
import {
  ActionBarPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { CheckIcon, CopyIcon, PencilIcon } from "lucide-react";
import { UserMessageAttachments } from "@/components/assistant-ui/attachment";
import { BranchPicker } from "@/components/assistant-ui/branch-picker";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { Button } from "@/components/ui/button";
import { type GroupableMessagePart } from "@/components/assistant-ui/thread-utils";
import { useCopyMessageText } from "@/hooks/use-copy-message";

function UserCopyButton() {
  const messageParts = useAuiState((s) => s.message.parts as readonly GroupableMessagePart[]);
  const { copied, handleCopy } = useCopyMessageText(messageParts);

  return (
    <TooltipIconButton tooltip="复制" onClick={handleCopy}>
      {copied ? <CheckIcon /> : <CopyIcon />}
    </TooltipIconButton>
  );
}

function UserActionBar() {
  return (
    <div className="flex items-center gap-1 text-muted-foreground">
      <UserCopyButton />
      <ActionBarPrimitive.Root hideWhenRunning className="contents">
        <ActionBarPrimitive.Edit asChild>
          <TooltipIconButton tooltip="编辑" className="aui-user-action-edit">
            <PencilIcon />
          </TooltipIconButton>
        </ActionBarPrimitive.Edit>
      </ActionBarPrimitive.Root>
    </div>
  );
}

export const UserMessage = memo(function UserMessage() {
  const createdAt = useAuiState((s) => s.message.createdAt);
  const timeText = createdAt
    ? new Date(createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      className="group/user-msg grid animate-in auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start px-2 duration-150 [contain-intrinsic-size:auto_60px] [content-visibility:auto] fade-in slide-in-from-bottom-1 [&:where(>*)]:col-start-2"
      data-role="user"
    >
      <UserMessageAttachments />

      <div className="aui-user-message-content-wrapper col-start-2 min-w-0">
        <div className="aui-user-message-content rounded-xl bg-muted-foreground/6 px-4 py-2 text-[15px] leading-6 wrap-break-word text-foreground empty:hidden dark:bg-muted-foreground/10">
          <MessagePrimitive.Parts />
        </div>
      </div>

      <div className="relative col-start-2 h-7 min-w-0">
        <div className="absolute inset-y-0 right-0 flex items-center gap-1 whitespace-nowrap opacity-0 transition-opacity group-hover/user-msg:opacity-100">
          {timeText && (
            <span className="mr-1 text-xs text-muted-foreground tabular-nums">{timeText}</span>
          )}
          <UserActionBar />
        </div>
      </div>

      <BranchPicker
        data-slot="aui_user-branch-picker"
        className="col-span-full col-start-1 -me-1 justify-end"
      />
    </MessagePrimitive.Root>
  );
});

export function EditComposer() {
  return (
    <MessagePrimitive.Root
      data-slot="aui_edit-composer-wrapper"
      className="flex flex-col px-2"
    >
      <ComposerPrimitive.Root className="aui-edit-composer-root ms-auto flex w-full max-w-[85%] flex-col rounded-2xl bg-muted">
        <ComposerPrimitive.Input
          className="aui-edit-composer-input min-h-14 w-full resize-none bg-transparent p-4 text-[15px] leading-6 text-foreground outline-none"
          autoFocus
        />
        <div className="aui-edit-composer-footer mx-3 mb-3 flex items-center gap-2 self-end">
          <ComposerPrimitive.Cancel asChild>
            <Button variant="ghost" size="sm">
              取消
            </Button>
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send asChild>
            <Button size="sm">更新</Button>
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
    </MessagePrimitive.Root>
  );
}
