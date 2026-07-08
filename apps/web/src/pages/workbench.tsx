import { useContext, type ContextType } from "react";
import { Outlet } from "@tanstack/react-router";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { PanelRight } from "lucide-react";
import { Thread } from "@/components/assistant-ui/thread";
import { ChatHeader } from "@/components/assistant-ui/chat-header";
import { WorkbenchSidebar } from "@/components/sidebar";
import { ChatSidePanel } from "@/components/chat-side-panel/chat-side-panel";
import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import {
  SidebarProvider,
  SidebarInset,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { useSelectionStore } from "@/stores/selection-store";
import { useConversations } from "@/hooks/use-conversation";
import { useChatSidePanelStore } from "@/stores/chat-side-panel-store";
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
  const panelOpen = useChatSidePanelStore((s) => s.panelOpen);
  const togglePanel = useChatSidePanelStore((s) => s.togglePanel);

  const conversation = conversationsData?.conversations.find(
    (c) => c.conversationId === selectedConversationId,
  );
  const workspaceId = conversation?.workspaceId ?? selectedWorkspaceId;

  const showNewChatTrigger =
    selectedConversationId === undefined && (isMobile || state === "collapsed");
  const needsNativeCollapsedOffset = nativeClient && !isMobile && state === "collapsed";

  // 未选工作空间或移动端时不显示文件面板入口
  const canShowPanel = !!workspaceId && !isMobile;
  const showPanel = panelOpen && canShowPanel && !!workspaceId;

  return (
    <SidebarInset className="relative min-h-0 overflow-hidden shadow-none ring-1 ring-border/60">
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
      <ResizablePanelGroup
        key={showPanel ? "with-panel" : "without-panel"}
        orientation="horizontal"
        className="flex min-h-0 flex-1"
      >
        {/* 聊天区（ChatHeader 在这里，不贯通到面板） */}
        <ResizablePanel defaultSize={showPanel ? "50%" : "100%"}>
          <div className="flex h-full flex-col">
            {selectedConversationId !== undefined ? (
              <ChatHeader
                rightSlot={
                  canShowPanel ? (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="no-drag text-muted-foreground hover:text-foreground"
                      onClick={togglePanel}
                      title={panelOpen ? "关闭侧边栏" : "打开侧边栏"}
                    >
                      <PanelRight className="size-4" />
                    </Button>
                  ) : undefined
                }
              />
            ) : null}
            <div className="min-h-0 flex-1">
              <AssistantRuntimeProvider runtime={runtime}>
                <Thread />
              </AssistantRuntimeProvider>
            </div>
          </div>
        </ResizablePanel>

        {/* 面板区 */}
        {showPanel && workspaceId ? (
          <>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize="50%" minSize="15%" maxSize="70%">
              <ChatSidePanel workspaceId={workspaceId} />
            </ResizablePanel>
          </>
        ) : null}
      </ResizablePanelGroup>
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
