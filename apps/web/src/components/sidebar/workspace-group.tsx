import { memo, useMemo, useState } from "react";
import {
  Container,
  Folder,
  FolderDot,
  FolderGit2,
  FolderOpen,
  FolderOpenDot,
  MessageCirclePlus,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";
import { WorkspaceDialog } from "@/components/workspace-dialog";
import { ConfirmDeleteDialog, useConfirmDelete } from "@/components/confirm-delete-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import type { Workspace } from "@/hooks/use-workspace";
import type { Conversation, ConversationSortKey } from "@/hooks/use-conversations";
import { getRegularConversations } from "@/hooks/use-conversations";
import { ConversationListItem } from "./conversation-list-item";
import { formatDateTime } from "@/utils/format";
import { cn } from "@/lib/utils";

type DeleteTarget = { type: "workspace"; id: string; name: string };

const DEFAULT_VISIBLE_CONVERSATION_COUNT = 5;

interface WorkspaceGroupProps {
  workspace: Workspace;
  conversations: Conversation[];
  activeConversationId?: string;
  open?: boolean;
  sortKey: ConversationSortKey;
  onOpenChange?: (open: boolean) => void;
  onDeleteWorkspace?: (workspaceId: string) => void;
  onNewConversation?: (workspaceId: string) => void;
  onConversationArchived?: (conversation: Conversation) => void;
}

export const WorkspaceGroup = memo(function WorkspaceGroup({
  workspace,
  conversations,
  activeConversationId,
  open = true,
  sortKey,
  onOpenChange,
  onDeleteWorkspace,
  onNewConversation,
  onConversationArchived,
}: WorkspaceGroupProps) {
  const [showAllConversations, setShowAllConversations] = useState(false);
  const deleteDialog = useConfirmDelete<DeleteTarget>();
  const [editDialogOpen, setEditDialogOpen] = useState(false);

  // 归档会话不在侧边栏显示，统一在「设置 → 已归档对话」管理
  const regularConversations = useMemo(
    () => getRegularConversations(conversations),
    [conversations],
  );

  const visibleConversations = showAllConversations
    ? regularConversations
    : regularConversations.slice(0, DEFAULT_VISIBLE_CONVERSATION_COUNT);
  const hiddenConversationCount = regularConversations.length - visibleConversations.length;
  const hasHiddenConversations =
    regularConversations.length > DEFAULT_VISIBLE_CONVERSATION_COUNT;

  function handleConfirmDelete() {
    if (!deleteDialog.target) return;
    onDeleteWorkspace?.(deleteDialog.target.id);
    deleteDialog.cancelDelete();
  }

  return (
    <>
      <Collapsible open={open} onOpenChange={onOpenChange} className="group/collapsible">
        <SidebarMenuItem className="py-1 select-none">
          <SidebarMenuButton
            render={<CollapsibleTrigger />}
            tooltip={{
              side: "right",
              align: "start",
              sideOffset: 12,
              arrowClassName: "hidden",
              hidden: false,
              className:
                "flex min-w-56 max-w-80 flex-col items-start gap-2 bg-popover px-3 py-2.5 text-left text-popover-foreground shadow-lg ring-1 ring-border",
              children: <WorkspaceHoverDetails workspace={workspace} />,
            }}
            className="h-7 rounded-md pl-4 pr-16 text-sm font-normal text-sidebar-foreground/90 hover:bg-transparent hover:text-sidebar-foreground data-open:hover:bg-transparent"
          >
            {workspace.runtimeType === "sandbox" ? (
              open ? (
                <FolderOpenDot className="size-4 shrink-0" />
              ) : (
                <FolderDot className="size-4 shrink-0" />
              )
            ) : workspace.gitUrl ? (
              <FolderGit2 className="size-4 shrink-0" />
            ) : open ? (
              <FolderOpen className="size-4 shrink-0" />
            ) : (
              <Folder className="size-4 shrink-0" />
            )}
            <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
          </SidebarMenuButton>

          <DropdownMenu>
            <DropdownMenuTrigger render={
              <SidebarMenuAction
                showOnHover
                type="button"
                aria-label={`管理 ${workspace.name}`}
                className="top-1 right-10"
              >
                <MoreHorizontal className="size-4" />
              </SidebarMenuAction>
            } />
            <DropdownMenuContent side="bottom" align="start">
              <DropdownMenuGroup>
                <DropdownMenuItem
                  className="text-sm"
                  onClick={() => setEditDialogOpen(true)}
                >
                  <Pencil /> 编辑
                </DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem
                  className="text-sm"
                  variant="destructive"
                  onClick={(e) => {
                    e.preventDefault();
                    deleteDialog.requestDelete({ type: "workspace", id: workspace.id, name: workspace.name });
                  }}
                >
                  <Trash2 /> 移除
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <Tooltip>
            <TooltipTrigger render={
              <SidebarMenuAction
                showOnHover
                type="button"
                aria-label="新建对话"
                onClick={() => onNewConversation?.(workspace.id)}
                className="top-1 right-4"
              >
                <MessageCirclePlus className="size-4" />
              </SidebarMenuAction>
            } />
            <TooltipContent side="bottom">新建对话</TooltipContent>
          </Tooltip>

          <CollapsibleContent>
            <SidebarMenuSub className="mx-0 w-full translate-x-0 gap-0 border-l-0 px-0 py-0">
              {visibleConversations.map((conversation) => (
                <ConversationListItem
                  key={conversation.conversationId}
                  conversation={conversation}
                  activeConversationId={activeConversationId}
                  sortKey={sortKey}
                  workspaceName={workspace.name}
                  onConversationArchived={onConversationArchived}
                />
              ))}
              {hasHiddenConversations && (
                <SidebarMenuSubItem>
                  <button
                    type="button"
                    aria-expanded={showAllConversations}
                    title={
                      showAllConversations
                        ? "收起对话列表"
                        : `还有 ${hiddenConversationCount} 个对话`
                    }
                    onClick={() => setShowAllConversations((value) => !value)}
                    className="flex h-6 w-full items-center rounded-md pl-10 text-xs text-muted-foreground outline-hidden transition-colors hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                  >
                    <span className="truncate">
                      {showAllConversations ? "收起" : "展开"}
                    </span>
                  </button>
                </SidebarMenuSubItem>
              )}

              {regularConversations.length === 0 && (
                <SidebarMenuSubItem>
                  <span className="block pl-10 py-1 text-sm text-muted-foreground">
                    暂无对话
                  </span>
                </SidebarMenuSubItem>
              )}
            </SidebarMenuSub>
          </CollapsibleContent>
        </SidebarMenuItem>
      </Collapsible>

      <WorkspaceDialog
        open={editDialogOpen}
        onOpenChange={setEditDialogOpen}
        workspace={workspace}
      />

      <ConfirmDeleteDialog
        open={deleteDialog.isOpen}
        onOpenChange={deleteDialog.onOpenChange}
        onConfirm={handleConfirmDelete}
        title="确认移除工作空间？"
        targetName={deleteDialog.target?.name}
        description={deleteDialog.target ? `将移除工作空间「${deleteDialog.target.name}」及其所有对话，此操作不可撤销。` : undefined}
        confirmLabel="移除"
      />
    </>
  );
});

function WorkspaceHoverDetails({ workspace }: { workspace: Workspace }) {
  return (
    <>
      <div className="flex w-full min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-popover-foreground">
          {workspace.name}
        </span>
        {workspace.runtimeType === "sandbox" && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
            <Container className="size-3" />
            {sandboxEngineLabel(workspace.sandboxEngine)}
          </span>
        )}
      </div>
      <WorkspaceHoverRow label="环境" value={runtimeLabel(workspace)} />
      <WorkspaceHoverRow label="路径" value={workspace.rootPath} mono />
      {workspace.gitUrl && (
        <WorkspaceHoverRow label="Git" value={workspace.gitUrl} mono />
      )}
      {workspace.description && (
        <WorkspaceHoverRow label="描述" value={workspace.description} multiline />
      )}
      <WorkspaceHoverRow
        label="更新"
        value={formatDateTime(workspace.updatedAt) || "-"}
      />
    </>
  );
}

function WorkspaceHoverRow({
  label,
  value,
  mono,
  multiline,
}: {
  label: string;
  value: string;
  mono?: boolean;
  multiline?: boolean;
}) {
  return (
    <div className="grid w-full grid-cols-[2.75rem_minmax(0,1fr)] items-start gap-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={cn(
          "min-w-0 text-popover-foreground",
          multiline
            ? "line-clamp-4 whitespace-pre-wrap"
            : mono
              ? "truncate font-mono text-[11px]"
              : "truncate",
        )}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}

function runtimeLabel(workspace: Workspace) {
  if (workspace.runtimeType === "local") return "本地";
  return `容器 · ${isolationScopeLabel(workspace.isolationScope)}`;
}

function isolationScopeLabel(scope: Workspace["isolationScope"]) {
  if (scope === "workspace") return "工作空间隔离";
  if (scope === "user") return "用户共享";
  return "默认隔离";
}

function sandboxEngineLabel(engine: Workspace["sandboxEngine"]) {
  const labels: Record<string, string> = {
    docker: "Docker",
    opensandbox: "OpenSandbox",
  };
  return engine ? (labels[engine] ?? engine) : "容器";
}
