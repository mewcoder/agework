import { ListTree, RefreshCw } from "lucide-react";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { cn } from "@/lib/utils";

/**
 * 文件/变更 面板共用的工具条图标组:目录树折叠开关 + 刷新。
 * 两个图标尺寸、圆角、激活态与文件面板保持一致,供两侧复用。
 */
export function PanelTreeRefreshToolbar({
  treeOpen,
  onToggleTree,
  onRefresh,
  treeOpenTooltip = "折叠文件树",
  treeClosedTooltip = "展开文件树",
  refreshTooltip = "刷新文件列表",
}: {
  treeOpen: boolean;
  onToggleTree: () => void;
  onRefresh: () => void;
  treeOpenTooltip?: string;
  treeClosedTooltip?: string;
  refreshTooltip?: string;
}) {
  return (
    <>
      <TooltipIconButton
        tooltip={treeOpen ? treeOpenTooltip : treeClosedTooltip}
        side="bottom"
        className={cn(
          "size-6 self-center !rounded-[6px] transition-colors",
          treeOpen
            ? "bg-accent text-muted-foreground ring-1 ring-inset ring-border"
            : "text-muted-foreground hover:bg-accent/50",
        )}
        onClick={onToggleTree}
      >
        <ListTree className="size-4" />
      </TooltipIconButton>

      <TooltipIconButton
        tooltip={refreshTooltip}
        side="bottom"
        className="size-6 self-center !rounded-[6px] text-muted-foreground"
        onClick={onRefresh}
      >
        <RefreshCw className="size-3.5" />
      </TooltipIconButton>
    </>
  );
}
