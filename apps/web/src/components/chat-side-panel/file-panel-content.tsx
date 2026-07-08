import { RefreshCw } from "lucide-react";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FileTreeNode } from "@/components/workspace-file-panel/workspace-file-tree";
import { WorkspaceFilePreview } from "@/components/workspace-file-panel/workspace-file-preview";
import { useWorkspaceFiles, useWorkspaces, useRefreshWorkspaceFiles } from "@/hooks/use-workspace";
import { useChatSidePanelStore } from "@/stores/chat-side-panel-store";

export type FilePanelContentProps = {
  workspaceId: string;
};

export function FilePanelContent({ workspaceId }: FilePanelContentProps) {
  const treeOpen = useChatSidePanelStore((s) => s.treeOpen);
  const selectedFilePath = useChatSidePanelStore((s) => s.selectedFilePath);
  const setSelectedFilePath = useChatSidePanelStore((s) => s.setSelectedFilePath);
  const addFileTab = useChatSidePanelStore((s) => s.addFileTab);
  const { data: workspaces = [] } = useWorkspaces();
  const workspace = workspaces.find((w) => w.id === workspaceId);
  const workspaceName = workspace?.name;
  const rootPath = workspace?.rootPath;
  const refresh = useRefreshWorkspaceFiles(workspaceId);

  // 根目录列表(面板打开时立即加载)
  const { error: rootError } = useWorkspaceFiles(workspaceId, "", true);

  function handleSelectFile(path: string) {
    setSelectedFilePath(path);
    addFileTab(path);
  }

  if (rootError) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <div className="text-center">
          <p className="text-sm text-muted-foreground">
            {rootError instanceof Error
              ? rootError.message
              : "无法加载文件列表"}
          </p>
        </div>
      </div>
    );
  }

  if (!treeOpen) {
    // 文件树折叠时：预览占满
    return (
      <div className="h-full">
        <WorkspaceFilePreview workspaceId={workspaceId} path={selectedFilePath} />
      </div>
    );
  }

  // 树和预览左右分栏，可拖拽比例
  return (
    <ResizablePanelGroup orientation="horizontal" className="h-full">
      <ResizablePanel defaultSize="35%" minSize="20%" maxSize="60%">
        <div className="flex h-full flex-col">
          {/* 根目录行 + 刷新按钮 */}
          <div className="flex shrink-0 items-center justify-between border-b border-border/40 px-1 py-0.5">
            <span className="min-w-0 truncate px-1 text-[11px] font-medium text-muted-foreground" title={rootPath}>
              {rootPath ?? workspaceName ?? "根目录"}
            </span>
            <TooltipIconButton
              tooltip="刷新文件列表"
              side="left"
              className="size-5"
              onClick={refresh}
            >
              <RefreshCw className="size-3" />
            </TooltipIconButton>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="py-1">
              <FileTreeNode
                workspaceId={workspaceId}
                path=""
                level={0}
                selectedPath={selectedFilePath}
                onSelect={handleSelectFile}
                rootLabel={workspaceName}
                defaultOpen
              />
            </div>
          </ScrollArea>
        </div>
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize="65%" minSize="30%">
        <WorkspaceFilePreview workspaceId={workspaceId} path={selectedFilePath} />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
