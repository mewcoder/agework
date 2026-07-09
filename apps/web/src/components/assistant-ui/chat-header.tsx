import { Folder, GitBranch } from "lucide-react";
import { type ReactNode } from "react";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { useSelectionStore } from "@/stores/selection-store";
import { useConversations } from "@/hooks/use-conversation";
import { useWorkspaces } from "@/hooks/use-workspace";
import { formatRelativeTime } from "@/utils/format";
import { cn } from "@/lib/utils";
import { useNativeClient } from "@/hooks/use-native-client";

export function ChatHeader({ rightSlot }: { rightSlot?: ReactNode }) {
  const { state, isMobile } = useSidebar();
  const nativeClient = useNativeClient();
  const selectedConversationId = useSelectionStore((s) => s.selectedConversationId);
  const selectedWorkspaceId = useSelectionStore((s) => s.selectedWorkspaceId);
  const { data: conversationsData } = useConversations(undefined, "updatedAt");
  const { data: workspaces = [] } = useWorkspaces();

  const conversation = conversationsData?.conversations.find((c) => c.conversationId === selectedConversationId);
  const workspaceId = conversation?.workspaceId ?? selectedWorkspaceId;
  const workspace = workspaces.find((p) => p.id === workspaceId);

  const workspaceName =
    workspace?.name ?? (workspaceId ? "工作空间加载中" : "未选择工作空间");
  const conversationTitle =
    conversation?.title ?? (selectedConversationId || selectedWorkspaceId ? "新对话" : "准备开始");
  const updatedAt = conversation?.updatedAt ? formatRelativeTime(conversation.updatedAt) : null;

  function scrollToConversationTop() {
    document
      .querySelector<HTMLElement>('[data-slot="aui_thread-viewport"]')
      ?.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <header
      className={cn(
        "flex h-[52px] shrink-0 items-center gap-2 border-b border-border/50 bg-background py-0 pr-4 select-none drag-region",
        state === "collapsed" && nativeClient
          ? "pl-[calc(var(--electron-titlebar-control-safe-area)+1rem)]"
          : "pl-4",
      )}
    >
      {(isMobile || state === "collapsed") && (
        <SidebarTrigger className="-ml-1 text-muted-foreground hover:text-foreground no-drag" />
      )}
      <div className="min-w-0 shrink no-drag">
        <h1
          className="min-w-0 truncate text-base leading-5 font-medium text-foreground"
          title={conversationTitle}
        >
          {conversationTitle}
        </h1>
        <span
          className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] leading-none text-muted-foreground"
          title={workspaceName}
        >
          <Folder className="size-3 shrink-0" />
          <span className="min-w-0 truncate">{workspaceName}</span>
          {workspace?.gitBranch && (
            <>
              <GitBranch className="size-3 shrink-0" />
              <span
                className="shrink-0 truncate"
                title={workspace.gitBranch}
              >
                {workspace.gitBranch}
              </span>
            </>
          )}
          {updatedAt && <span>{updatedAt}</span>}
        </span>
      </div>
      <div
        aria-hidden="true"
        title="回到顶部"
        className="-my-1 min-w-0 flex-1 self-stretch"
        onClick={scrollToConversationTop}
      />
      {rightSlot}
    </header>
  );
}
