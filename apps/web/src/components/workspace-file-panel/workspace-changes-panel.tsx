import { useState } from "react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useWorkspaceChanges,
  useRefreshWorkspaceChanges,
} from "@/hooks/use-workspace";
import type { ChangedFileEntry } from "@agework/shared/api";
import { cn } from "@/lib/utils";
import { PanelTreeRefreshToolbar } from "./panel-tree-refresh-toolbar";
import { ChangeStatusBadge } from "./workspace-change-status";
import { WorkspaceFileDiffView } from "./workspace-file-diff-view";

/** 单个变更条目行。deleted 置灰不可点开。 */
function ChangeListItem({
  entry,
  selected,
  onSelect,
}: {
  entry: ChangedFileEntry;
  selected: boolean;
  onSelect: (entry: ChangedFileEntry) => void;
}) {
  const deleted = entry.status === "deleted";
  return (
    <button
      type="button"
      disabled={deleted}
      onClick={() => !deleted && onSelect(entry)}
      title={entry.oldPath ? `${entry.oldPath} → ${entry.path}` : entry.path}
      className={cn(
        "flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs transition-colors",
        deleted
          ? "cursor-default text-muted-foreground/50"
          : "hover:bg-accent/50",
        selected && !deleted && "bg-accent",
      )}
    >
      <ChangeStatusBadge status={entry.status} />
      <span className="min-w-0 flex-1 truncate">{entry.path}</span>
      {(entry.additions !== null || entry.deletions !== null) && (
        <span className="shrink-0 tabular-nums text-[10px]">
          {entry.additions !== null && (
            <span className="text-green-700 dark:text-green-400">
              +{entry.additions}
            </span>
          )}
          {entry.additions !== null && entry.deletions !== null && " "}
          {entry.deletions !== null && (
            <span className="text-destructive">-{entry.deletions}</span>
          )}
        </span>
      )}
    </button>
  );
}

export function WorkspaceChangesPanel({ workspaceId }: { workspaceId: string }) {
  const { data, isLoading, error } = useWorkspaceChanges(workspaceId, true);
  const refresh = useRefreshWorkspaceChanges(workspaceId);
  const [selectedPath, setSelectedPath] = useState<string | undefined>(undefined);
  const [listOpen, setListOpen] = useState(true);

  const selectedEntry = data?.list.find((entry) => entry.path === selectedPath);

  // diff 侧内容,列表折叠时占满、展开时放右栏,避免重复
  const diffContent = selectedEntry ? (
    <WorkspaceFileDiffView workspaceId={workspaceId} entry={selectedEntry} />
  ) : (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      选择文件查看变更
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      {/* 顶部工具条:复用与文件面板一致的 目录树开关 + 刷新 图标组 */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border/40 px-1.5">
        <PanelTreeRefreshToolbar
          treeOpen={listOpen}
          onToggleTree={() => setListOpen((v) => !v)}
          onRefresh={refresh}
          treeOpenTooltip="折叠变更列表"
          treeClosedTooltip="展开变更列表"
          refreshTooltip="刷新变更"
        />
      </div>

      <div className="min-h-0 flex-1">
        {error ? (
          // 非 local / 非 git / 其它 400:直接展示后端 message
          <div className="flex h-full items-center justify-center p-4">
            <p className="text-center text-sm text-muted-foreground">
              {error instanceof Error ? error.message : "无法加载变更列表"}
            </p>
          </div>
        ) : isLoading ? (
          <div className="space-y-1.5 p-2">
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={index} className="h-6 w-full" />
            ))}
          </div>
        ) : !data || data.list.length === 0 ? (
          <div className="flex h-full items-center justify-center p-4">
            <p className="text-sm text-muted-foreground">没有未提交的变更</p>
          </div>
        ) : !listOpen ? (
          // 变更列表折叠:diff 占满
          <div className="h-full">{diffContent}</div>
        ) : (
          <ResizablePanelGroup orientation="horizontal" className="h-full">
            <ResizablePanel defaultSize="40%" minSize="25%" maxSize="60%">
              <ScrollArea className="h-full">
                <div className="p-1">
                  {data.list.map((entry) => (
                    <ChangeListItem
                      key={entry.path}
                      entry={entry}
                      selected={entry.path === selectedPath}
                      onSelect={(e) => setSelectedPath(e.path)}
                    />
                  ))}
                  {data.truncated && (
                    <p className="px-1.5 py-1 text-[10px] text-muted-foreground">
                      变更过多,仅显示前 500 项
                    </p>
                  )}
                </div>
              </ScrollArea>
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize="60%" minSize="30%">
              {diffContent}
            </ResizablePanel>
          </ResizablePanelGroup>
        )}
      </div>
    </div>
  );
}
