import { memo, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  Archive,
  Folder,
  Loader2,
  MoreHorizontal,
  Pencil,
} from "lucide-react";
import { AgentIcon } from "@/components/icons/agent";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import type { Conversation, ConversationSortKey } from "@/hooks/use-conversation";
import { useArchiveConversation } from "@/hooks/use-conversation";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "@/utils/format";
import { useRunSessionStore } from "@/stores/run-session-store";
import { RenameConversationDialog } from "@/components/rename-conversation-dialog";

interface ConversationListItemProps {
  conversation: Conversation;
  activeConversationId?: string;
  sortKey: ConversationSortKey;
  workspaceName?: string;
  onConversationArchived?: (conversation: Conversation) => void;
}

export const ConversationListItem = memo(function ConversationListItem({
  conversation,
  activeConversationId,
  sortKey,
  workspaceName,
  onConversationArchived,
}: ConversationListItemProps) {
  const archiveConversation = useArchiveConversation();
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const isActive = conversation.conversationId === activeConversationId;
  const isPending = conversation.pendingUserAction === "question";
  const isRunning = conversation.runStatus === "running" && !isPending;
  const hasCompletedRun = useRunSessionStore((s) =>
    s.unacknowledgedCompletions.has(conversation.conversationId),
  );
  const hasFailedRun = conversation.runStatus === "error";
  const statusDot = isPending
    ? {
        label: "待处理",
        dotClass: "bg-amber-500",
        badgeClass: "border-amber-500/50 text-amber-600 dark:text-amber-400",
      }
    : hasFailedRun
    && !isRunning
    ? {
        label: "错误",
        dotClass: "bg-destructive",
        badgeClass: "border-destructive/50 text-destructive",
      }
    : hasCompletedRun && !isRunning
      ? {
          label: "已完成",
          dotClass: "bg-sky-500",
          badgeClass: "border-sky-500/50 text-sky-600 dark:text-sky-400",
        }
      : null;

  return (
    <SidebarMenuSubItem className="group/subitem relative min-w-0 select-none">
      <Tooltip>
        <TooltipTrigger render={
          <SidebarMenuSubButton
            render={
              <Link
                to="/c/$conversationId"
                params={{ conversationId: conversation.conversationId }}
                aria-current={isActive ? "page" : undefined}
              />
            }
            isActive={isActive}
            className="h-8 w-full translate-x-0 rounded-md pl-10 pr-9 text-sm font-normal text-sidebar-foreground/90 hover:bg-sidebar-accent/70 data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground"
          >
          <span className="flex w-full min-w-0 flex-1 items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-left">
              {conversation.title ?? "New Chat"}
            </span>
            {statusDot ? (
              <>
                <span
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center",
                    "group-hover/subitem:hidden group-focus-within/subitem:hidden",
                  )}
                >
                  <span
                    aria-label={statusDot.label}
                    className={cn(
                      "size-2 rounded-full shadow-[0_0_0_3px_color-mix(in_oklch,var(--sidebar-accent)_68%,transparent)]",
                      statusDot.dotClass,
                    )}
                  />
                </span>
                <Badge
                  variant="outline"
                  className={cn(
                    "hidden h-4 text-[10px] leading-none group-hover/subitem:inline-flex group-focus-within/subitem:inline-flex",
                    statusDot.badgeClass,
                  )}
                >
                  {statusDot.label}
                </Badge>
              </>
            ) : isRunning ? (
              <Loader2 className="shrink-0 size-4 animate-spin [animation-duration:2s] text-muted-foreground" />
            ) : (
              !isActive && (
                <span className="shrink-0 text-xs font-normal text-muted-foreground group-focus-within/subitem:hidden group-hover/subitem:hidden">
                  {formatRelativeTime(conversation[sortKey])}
                </span>
              )
            )}
          </span>
      </SidebarMenuSubButton>
        } />
        <TooltipContent
          side="right"
          align="start"
          sideOffset={12}
          arrowClassName="hidden"
          className="flex min-w-44 max-w-72 flex-col items-start gap-1.5 bg-popover px-3 py-2.5 text-left text-popover-foreground shadow-lg ring-1 ring-border"
        >
          <span className="text-sm font-normal text-sidebar-foreground/90">
            {conversation.title ?? "New Chat"}
          </span>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Folder className="size-3.5" />
            {workspaceName}
          </span>
          <span className="text-[11px] text-muted-foreground/70">
            {formatRelativeTime(conversation.updatedAt)}
          </span>
        </TooltipContent>
      </Tooltip>
      <span
        className="pointer-events-none absolute left-4 top-1/2 flex size-3 -translate-y-1/2 items-center justify-center"
      >
        <AgentIcon agent={conversation.agentType} size={12} />
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger render={
          <button
            type="button"
            aria-label="对话操作"
            className={cn(
              "absolute right-4 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 outline-hidden transition-[color,opacity] hover:text-sidebar-foreground focus-visible:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:opacity-100 active:text-sidebar-foreground group-hover/subitem:opacity-100 data-open:opacity-100 data-open:text-sidebar-foreground [&>svg]:size-4",
            )}
          >
            <MoreHorizontal />
          </button>
        } />
        <DropdownMenuContent side="bottom" align="start">
          <DropdownMenuItem
            className="text-sm"
            onClick={() => {
              setRenameDialogOpen(true);
            }}
          >
            <Pencil /> 重命名
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-sm"
            onClick={(e) => {
              e.preventDefault();
              archiveConversation.mutate(conversation.conversationId, {
                onSuccess: () => onConversationArchived?.(conversation),
              });
            }}
          >
            <Archive /> 归档
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <RenameConversationDialog
        open={renameDialogOpen}
        onOpenChange={setRenameDialogOpen}
        conversationId={conversation.conversationId}
        currentTitle={conversation.title ?? "新对话"}
      />
    </SidebarMenuSubItem>
  );
});
