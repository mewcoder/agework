import { useState } from "react";
import { PanelRightClose, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FileTreeNode } from "./workspace-file-tree";
import { WorkspaceFilePreview } from "./workspace-file-preview";
import { useWorkspaceFiles, useRefreshWorkspaceFiles } from "@/hooks/use-workspace";

export type WorkspaceFilePanelProps = {
  workspaceId: string;
  onClose: () => void;
};

export function WorkspaceFilePanel({
  workspaceId,
  onClose,
}: WorkspaceFilePanelProps) {
  const [selectedPath, setSelectedPath] = useState<string | undefined>();
  const refresh = useRefreshWorkspaceFiles(workspaceId);

  // 根目录列表(面板打开时立即加载)
  const { error: rootError } = useWorkspaceFiles(workspaceId, "", true);

  return (
    <div className="flex h-full w-80 flex-col border-l border-border/50 bg-background">
      {/* 标题栏 */}
      <div className="flex h-[52px] shrink-0 items-center justify-between border-b border-border/50 px-3">
        <span className="text-sm font-medium text-foreground">文件</span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={refresh}
            title="刷新"
          >
            <RefreshCw className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={onClose}
            title="关闭面板"
          >
            <PanelRightClose className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* 错误态:worker 不在线 */}
      {rootError && (
        <div className="flex flex-1 items-center justify-center p-4">
          <div className="text-center">
            <p className="text-sm text-muted-foreground">
              {rootError instanceof Error
                ? rootError.message
                : "无法加载文件列表"}
            </p>
          </div>
        </div>
      )}

      {/* 树 + 预览分栏 */}
      {!rootError && (
        <>
          <div className="flex min-h-0 flex-1 flex-col">
            {/* 文件树 */}
            <div className="h-1/2 min-h-0 border-b border-border/50">
              <ScrollArea className="h-full">
                <div className="py-1">
                  <FileTreeNode
                    workspaceId={workspaceId}
                    path=""
                    level={0}
                    selectedPath={selectedPath}
                    onSelect={setSelectedPath}
                  />
                </div>
              </ScrollArea>
            </div>

            {/* 文件预览 */}
            <div className="min-h-0 flex-1">
              <WorkspaceFilePreview
                workspaceId={workspaceId}
                path={selectedPath}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
