import { useContext, useState, type ContextType } from "react";
import { Outlet } from "@tanstack/react-router";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { PanelRight, FolderTree } from "lucide-react";
import { Thread } from "@/components/assistant-ui/thread";
import { ChatHeader } from "@/components/assistant-ui/chat-header";
import { WorkbenchSidebar } from "@/components/sidebar";
import { WorkspaceFilePanel } from "@/components/workspace-file-panel/workspace-file-panel";
import { Button } from "@/components/ui/button";
import {
  SidebarProvider,
  SidebarInset,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { useSelectionStore } from "@/stores/selection-store";
import { useConversations } from "@/hooks/use-conversation";
import { AgentChatRuntimeProvider } from "@/components/agent-chat-runtime-context";
import { AgentChatRuntimeContext } from "@/components/agent-chat-runtime-context-value";
import { cn } from "@/lib/utils";
import { useNativeClient } from "@/hooks/use-native-client";

// Pathless route layout: keep the shared chat runtime mounted across
// / and /c/$conversationId so background conversation runtimes stay alive.
export function WorkbenchRuntimeLayout() {
  return (
    <AgentChatRuntimeProvider>
      <Outlet />
    </AgentChatRuntimeProvider>
  );
}

function WorkbenchContent({
  runtime,
}: {
  runtime: NonNullable<ContextType<typeof AgentChatRuntimeContext>>;
}) {
  const { state, isMobile } = useSidebar();
  const nativeClient = useNativeClient();
  const selectedConversationId = useSelectionStore((s) => s.selectedConversationId);
  const selectedWorkspaceId = useSelectionStore((s) => s.selectedWorkspaceId);
  const { data: conversationsData } = useConversations(undefined, "updatedAt");
  const [filePanelOpen, setFilePanelOpen] = useState(false);

  const conversation = conversationsData?.conversations.find(
    (c) => c.conversationId === selectedConversationId,
  );
  const workspaceId = conversation?.workspaceId ?? selectedWorkspaceId;

  const showNewChatTrigger =
    selectedConversationId === undefined && (isMobile || state === "collapsed");
  const needsNativeCollapsedOffset = nativeClient && !isMobile && state === "collapsed";

  // 未选工作空间或移动端时不显示文件面板入口
  const canShowFilePanel = !!workspaceId && !isMobile;

  return (
    <SidebarInset className="relative min-h-0 overflow-hidden shadow-none ring-1 ring-border/60">
      {selectedConversationId !== undefined ? (
        <ChatHeader
          rightSlot={
            canShowFilePanel ? (
              <Button
                variant="ghost"
                size="icon"
                className="size-7 no-drag"
                onClick={() => setFilePanelOpen((v) => !v)}
                title={filePanelOpen ? "关闭文件面板" : "打开文件面板"}
              >
                {filePanelOpen ? (
                  <PanelRight className="size-3.5" />
                ) : (
                  <FolderTree className="size-3.5" />
                )}
              </Button>
            ) : undefined
          }
        />
      ) : null}
      {showNewChatTrigger ? (
        <div
          className={cn(
            "absolute left-0 top-3 z-20 no-drag",
            needsNativeCollapsedOffset
              ? "pl-[calc(var(--electron-titlebar-control-safe-area)+0.75rem)]"
              : "pl-3",
          )}
        >
          <SidebarTrigger className="text-muted-foreground hover:text-foreground" />
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          <AssistantRuntimeProvider runtime={runtime}>
            <Thread />
          </AssistantRuntimeProvider>
        </div>
        {filePanelOpen && canShowFilePanel && workspaceId ? (
          <WorkspaceFilePanel
            workspaceId={workspaceId}
            onClose={() => setFilePanelOpen(false)}
          />
        ) : null}
      </div>
    </SidebarInset>
  );
}

export default function WorkbenchPage() {
  const runtime = useContext(AgentChatRuntimeContext);
  if (!runtime) {
    throw new Error("WorkbenchPage must be rendered inside AgentChatRuntimeProvider");
  }

  return (
    <SidebarProvider className="h-svh overflow-hidden">
      <WorkbenchSidebar
        variant="inset"
        className="[&_[data-slot=sidebar-inner]]:border-transparent [&_[data-slot=sidebar-inner]]:shadow-none"
      />
      <WorkbenchContent runtime={runtime} />
    </SidebarProvider>
  );
}
