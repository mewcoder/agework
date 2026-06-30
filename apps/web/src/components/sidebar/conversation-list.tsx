import { useEffect, useMemo, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  ChevronsDownUp,
  ChevronsUpDown,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderOpen,
  FolderPlus,
  MessageCirclePlus,
} from "lucide-react";
import { labels } from "@/utils/labels";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { useDeleteWorkspace, useWorkspaces } from "@/hooks/use-workspace";
import { useConversations, useConversationRunStatuses, getRegularConversations, type Conversation, type ConversationSortKey } from "@/hooks/use-conversation";
import { useConversationListView } from "@/hooks/use-conversation-list-view";
import { useConversationRunStatusMonitor } from "@/hooks/use-conversation-run-status-monitor";
import { useAgentChatContext } from "@/components/agent-chat-context";
import { IconActionButton } from "@/components/icon-action-button";
import { WorkspaceGroup } from "./workspace-group";
import { ConversationListItem } from "./conversation-list-item";
import { ConversationListMenu } from "./conversation-list-menu";
import { WorkspaceDialog } from "@/components/workspace-dialog";
import { loadSelectedWorkspaceId, useSelectionStore } from "@/stores/selection-store";

const EMPTY_CONVERSATIONS: Conversation[] = [];

export function ConversationList() {
  const routeConversationId = useRouterState({
    select: (s) => s.location.pathname.match(/\/c\/([^/]+)/)?.[1],
  });
  const { onNewConversation } = useAgentChatContext();
  const selectedConversationId = useSelectionStore((s) => s.selectedConversationId);
  const selectedWorkspaceId = useSelectionStore((s) => s.selectedWorkspaceId);
  const { data: workspaces = [] } = useWorkspaces();
  const queryClient = useQueryClient();
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
  const [workspacesVisible, setWorkspacesVisible] = useState(true);
  const [collapsedWorkspaceIds, setCollapsedWorkspaceIds] = useState<Set<string>>(
    () => new Set(),
  );
  const { viewMode, setViewMode, groupedSort, setGroupedSort, flatSort, setFlatSort } =
    useConversationListView();

  // 全部对话视图用 flatSort，工作空间视图 conversation 始终按 updatedAt
  const conversationSortKey: ConversationSortKey = viewMode === "flat" ? flatSort : "updatedAt";
  const activeConversationId = selectedConversationId ?? routeConversationId;
  const { data: conversationsData } = useConversations(undefined, conversationSortKey);
  const deleteWorkspace = useDeleteWorkspace();
  const conversations = conversationsData?.conversations ?? EMPTY_CONVERSATIONS;
  const backgroundRunningConversationIds = useMemo(
    () =>
      conversations
        .filter(
          (conversation) =>
            conversation.runStatus === "running" &&
            conversation.pendingUserAction !== "question" &&
            conversation.conversationId !== activeConversationId,
        )
        .map((conversation) => conversation.conversationId),
    [activeConversationId, conversations],
  );
  const { data: runStatusesData } = useConversationRunStatuses(
    backgroundRunningConversationIds,
  );

  useEffect(() => {
    const statuses = runStatusesData?.statuses;
    if (!statuses?.length) return;
    queryClient.setQueriesData<{ conversations: Conversation[] }>(
      { queryKey: ["conversations"] },
      (old) => {
        if (!old) return old;
        const statusById = new Map(
          statuses.map((status) => [status.conversationId, status]),
        );
        return {
          ...old,
          conversations: old.conversations.map((conversation) => {
            const status = statusById.get(conversation.conversationId);
            if (!status || status.updatedAt <= conversation.updatedAt) return conversation;
            return {
              ...conversation,
              runStatus: status.runStatus,
              pendingUserAction: status.pendingUserAction,
              updatedAt: status.updatedAt,
            };
          }),
        };
      },
    );
  }, [queryClient, runStatusesData]);

  useConversationRunStatusMonitor(conversations, activeConversationId);

  const storedWorkspaceId = loadSelectedWorkspaceId();
  const defaultWorkspaceId =
    workspaces.find((workspace) => workspace.id === storedWorkspaceId)?.id ??
    workspaces[0]?.id;
  const lastWorkspaceId =
    selectedWorkspaceId ??
    conversations.find((c) => c.conversationId === selectedConversationId)?.workspaceId ??
    defaultWorkspaceId;

  function handleNewChat(workspaceId = lastWorkspaceId) {
    onNewConversation(workspaceId);
  }

  const conversationsByWorkspace = useMemo(() => {
    const map = new Map<string, typeof conversations>();
    for (const conversation of conversations) {
      const list = map.get(conversation.workspaceId) ?? [];
      list.push(conversation);
      map.set(conversation.workspaceId, list);
    }
    return map;
  }, [conversations]);

  const regularConversations = useMemo(
    () => getRegularConversations(conversations),
    [conversations],
  );

  // 工作空间视图下，按活跃时间排序时项目按其内最新 conversation 的 updatedAt 排序
  const sortedWorkspaces = useMemo(() => {
    if (viewMode !== "grouped" || groupedSort !== "active") return workspaces;
    const workspaceLatestTime = new Map<string, number>();
    for (const conversation of regularConversations) {
      const t = Date.parse(conversation.updatedAt);
      if (Number.isNaN(t)) continue;
      const current = workspaceLatestTime.get(conversation.workspaceId) ?? 0;
      if (t > current) workspaceLatestTime.set(conversation.workspaceId, t);
    }
    return [...workspaces].sort((a, b) => {
      const aTime = workspaceLatestTime.get(a.id) ?? 0;
      const bTime = workspaceLatestTime.get(b.id) ?? 0;
      return bTime - aTime;
    });
  }, [workspaces, regularConversations, groupedSort, viewMode]);

  const workspaceIds = useMemo(
    () => sortedWorkspaces.map((workspace) => workspace.id),
    [sortedWorkspaces],
  );
  const hasWorkspaces = workspaceIds.length > 0;
  const allWorkspacesExpanded =
    hasWorkspaces && workspaceIds.every((workspaceId) => !collapsedWorkspaceIds.has(workspaceId));
  const workspaceToggleLabel = allWorkspacesExpanded
    ? "收起所有"
    : "展开所有";

  function handleWorkspaceOpenChange(workspaceId: string, open: boolean) {
    setCollapsedWorkspaceIds((current) => {
      const next = new Set(current);
      if (open) {
        next.delete(workspaceId);
      } else {
        next.add(workspaceId);
      }
      return next;
    });
  }

  function handleToggleAllWorkspaces() {
    setCollapsedWorkspaceIds((current) => {
      const next = new Set(current);
      if (allWorkspacesExpanded) {
        for (const workspaceId of workspaceIds) {
          next.add(workspaceId);
        }
      } else {
        for (const workspaceId of workspaceIds) {
          next.delete(workspaceId);
        }
      }
      return next;
    });
  }

  // 归档当前会话后它从侧边栏消失，跳到新对话
  function handleConversationArchived(conversation: Conversation) {
    if (conversation.conversationId === selectedConversationId || conversation.conversationId === routeConversationId) {
      onNewConversation(conversation.workspaceId);
    }
  }

  function handleDeleteWorkspace(workspaceId: string) {
    const workspaceConversations = conversationsByWorkspace.get(workspaceId) ?? [];
    deleteWorkspace.mutate(workspaceId, {
      onSuccess: () => {
        if (
          workspaceId === selectedWorkspaceId ||
          workspaceConversations.some((c) => c.conversationId === selectedConversationId)
        ) {
          onNewConversation();
        }
      },
    });
  }

  return (
    <>
      <SidebarGroup className="p-0">
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem className="mx-2 select-none">
              <SidebarMenuButton
                onClick={() => handleNewChat()}
                className="px-2 text-sm"
              >
                <MessageCirclePlus className="size-4" />
                <span>{labels.sidebar.newChat}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      <SidebarGroup className="min-h-0 flex-1 gap-0 overflow-hidden p-0 pt-4">
        <div className="group/workspace-header flex h-7 items-center px-3 text-sm text-muted-foreground select-none">
          <button
            type="button"
            aria-label={workspaceToggleLabel}
            disabled={viewMode !== "grouped" || !hasWorkspaces}
            onClick={() => setWorkspacesVisible((visible) => !visible)}
            className="group/workspace-trigger inline-flex min-w-0 flex-1 items-center gap-1 rounded-sm px-1 text-left text-[13px] font-medium text-sidebar-foreground/45 outline-hidden transition-colors hover:text-sidebar-foreground/65 focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:pointer-events-none disabled:opacity-70"
          >
            <span className="min-w-0 truncate">工作空间</span>
            {viewMode === "grouped" ? (
              workspacesVisible ? (
                <ChevronDownIcon className="size-3 shrink-0 text-sidebar-foreground/45 opacity-0 transition-opacity group-hover/workspace-trigger:opacity-100 group-focus-visible/workspace-trigger:opacity-100" />
              ) : (
                <ChevronRightIcon className="size-3 shrink-0 text-sidebar-foreground/45 opacity-0 transition-opacity group-hover/workspace-trigger:opacity-100 group-focus-visible/workspace-trigger:opacity-100" />
              )
            ) : null}
          </button>
          <div className="flex items-center gap-1">
            <IconActionButton
              tooltip="新建工作空间"
              onClick={() => setWorkspaceDialogOpen(true)}
            >
              <FolderPlus />
            </IconActionButton>
            {viewMode === "grouped" && (
              <IconActionButton
                tooltip={workspaceToggleLabel}
                onClick={handleToggleAllWorkspaces}
                disabled={!hasWorkspaces}
              >
                {allWorkspacesExpanded ? (
                  <ChevronsDownUp />
                ) : (
                  <ChevronsUpDown />
                )}
              </IconActionButton>
            )}
              <ConversationListMenu
                viewMode={viewMode}
                onSetViewMode={setViewMode}
                groupedSort={groupedSort}
                onSetGroupedSort={setGroupedSort}
                flatSort={flatSort}
                onSetFlatSort={setFlatSort}
              />
            </div>
        </div>

        {workspacesVisible && (
          <SidebarGroupContent className="aui-sidebar-scroll flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto">
            {workspaces.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-muted-foreground">
                <FolderOpen className="size-5 opacity-30" />
                <p className="text-sm">{labels.sidebar.emptyWorkspace}</p>
              </div>
            ) : viewMode === "flat" ? (
              <SidebarMenu className="gap-0">
                {regularConversations.length > 0 ? (
                  regularConversations.map((conversation) => (
                    <ConversationListItem
                      key={conversation.conversationId}
                      conversation={conversation}
                      activeConversationId={selectedConversationId}
                      sortKey={flatSort}
                      onConversationArchived={handleConversationArchived}
                    />
                  ))
                ) : (
                  <SidebarMenuItem>
                    <span className="block px-4 py-2 text-sm text-muted-foreground">
                      暂无对话
                    </span>
                  </SidebarMenuItem>
                )}
              </SidebarMenu>
            ) : (
              <SidebarMenu className="gap-1">
                {sortedWorkspaces.map((workspace) => (
                  <WorkspaceGroup
                    key={workspace.id}
                    workspace={workspace}
                    conversations={conversationsByWorkspace.get(workspace.id) ?? []}
                    activeConversationId={selectedConversationId}
                    open={!collapsedWorkspaceIds.has(workspace.id)}
                    sortKey="updatedAt"
                    onOpenChange={(open) => handleWorkspaceOpenChange(workspace.id, open)}
                    onDeleteWorkspace={handleDeleteWorkspace}
                    onNewConversation={handleNewChat}
                    onConversationArchived={handleConversationArchived}
                  />
                ))}
              </SidebarMenu>
            )}
          </SidebarGroupContent>
        )}
      </SidebarGroup>

      <WorkspaceDialog
        open={workspaceDialogOpen}
        onOpenChange={setWorkspaceDialogOpen}
        onCreated={(workspace) => {
          onNewConversation(workspace.id);
        }}
      />
    </>
  );
}
