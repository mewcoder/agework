import { memo, useCallback, useState } from "react";
import {
  ChevronRight,
  Folder as FolderIcon,
  FolderOpen,
  Link2,
  Loader2,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { FileTypeIcon } from "@/components/icons/file-icon";
import { useWorkspaceFiles } from "@/hooks/use-workspace";
import type { FileEntry } from "@agework/shared/filesystem/types";
import { cn } from "@/lib/utils";
import { useAui } from "@assistant-ui/react";

export type FileTreeProps = {
  workspaceId: string;
  path: string;
  level: number;
  selectedPath: string | undefined;
  onSelect: (path: string) => void;
  /** 根节点显示名称（path === "" 时使用） */
  rootLabel?: string;
  /** 默认展开（根节点传 true） */
  defaultOpen?: boolean;
};

/** 懒加载树节点:每展开一层拉一次 list。 */
export const FileTreeNode = memo(function FileTreeNode({
  workspaceId,
  path,
  level,
  selectedPath,
  onSelect,
  rootLabel,
  defaultOpen = false,
}: FileTreeProps) {
  const [open, setOpen] = useState(defaultOpen);
  const { data, isLoading, error } = useWorkspaceFiles(
    workspaceId,
    path,
    open,
  );

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-0.5 rounded px-1 py-0.5 text-xs hover:bg-accent/50",
          "text-foreground/80",
        )}
        style={{ paddingLeft: `${level * 12 + 4}px` }}
      >
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 transition-transform",
            open && "rotate-90",
          )}
        />
        {open ? (
          <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate">
          {path === "" ? (rootLabel ?? "根目录") : path.split("/").pop()}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {isLoading && (
          <div className="flex items-center gap-1 py-0.5 text-xs text-muted-foreground" style={{ paddingLeft: `${(level + 1) * 12 + 20}px` }}>
            <Loader2 className="size-3 animate-spin" />
            加载中...
          </div>
        )}
        {error && (
          <div className="py-0.5 text-xs text-destructive" style={{ paddingLeft: `${(level + 1) * 12 + 20}px` }}>
            加载失败
          </div>
        )}
        {data && (
          <>
            {data.truncated && (
              <div className="py-0.5 text-[10px] text-muted-foreground" style={{ paddingLeft: `${(level + 1) * 12 + 20}px` }}>
                (目录过大,仅显示前 1000 项)
              </div>
            )}
            {data.list.map((entry) => (
              <FileEntryNode
                key={entry.name}
                workspaceId={workspaceId}
                parentPath={path}
                entry={entry}
                level={level + 1}
                selectedPath={selectedPath}
                onSelect={onSelect}
              />
            ))}
          </>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
});

function FileEntryNode({
  workspaceId,
  parentPath,
  entry,
  level,
  selectedPath,
  onSelect,
}: {
  workspaceId: string;
  parentPath: string;
  entry: FileEntry;
  level: number;
  selectedPath: string | undefined;
  onSelect: (path: string) => void;
}) {
  const fullPath = parentPath === "" ? entry.name : `${parentPath}/${entry.name}`;

  // Hooks must be called unconditionally — before any early return.
  const aui = useAui();

  const handleAddToConversation = useCallback(() => {
    const current = aui.composer().getState().text;
    const prefix = current.length > 0 && !current.endsWith(" ") ? " " : "";
    aui.composer().setText(current + prefix + "@" + fullPath);
  }, [aui, fullPath]);

  const handleCopyPath = useCallback(() => {
    navigator.clipboard.writeText(fullPath).catch(() => {});
  }, [fullPath]);

  if (entry.type === "directory") {
    return (
      <FileTreeNode
        workspaceId={workspaceId}
        path={fullPath}
        level={level}
        selectedPath={selectedPath}
        onSelect={onSelect}
      />
    );
  }

  if (entry.type === "symlink") {
    // symlink 不允许原地展开,点击时跳转到 target 解析出的实际路径
    return (
      <button
        className={cn(
          "flex w-full items-center gap-0.5 rounded px-1 py-0.5 text-xs hover:bg-accent/50",
          selectedPath === fullPath && "bg-accent",
        )}
        style={{ paddingLeft: `${level * 12 + 20}px` }}
        onClick={() => onSelect(fullPath)}
        title={entry.target ? `→ ${entry.target}` : "symlink"}
      >
        <Link2 className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-foreground/60">{entry.name}</span>
      </button>
    );
  }

  // file
  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <button
          className={cn(
            "flex w-full items-center gap-0.5 rounded px-1 py-0.5 text-xs hover:bg-accent/50",
            selectedPath === fullPath && "bg-accent",
          )}
          style={{ paddingLeft: `${level * 12 + 20}px` }}
          onClick={() => onSelect(fullPath)}
        >
          <FileTypeIcon
            name={entry.name}
            className="size-3.5 shrink-0 text-muted-foreground"
          />
          <span className="truncate">{entry.name}</span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={handleCopyPath}>
          复制文件路径
        </ContextMenuItem>
        <ContextMenuItem onClick={handleAddToConversation}>
          添加到对话
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
