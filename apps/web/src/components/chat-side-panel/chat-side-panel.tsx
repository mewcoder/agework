import { useRef, useState, useEffect } from "react";
import {
  Folder,
  FolderTree,
  Globe,
  Terminal,
  Settings,
  X,
  MoreHorizontal,
} from "lucide-react";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useChatSidePanelStore } from "@/stores/chat-side-panel-store";
import { FilePanelContent } from "./file-panel-content";

export type ChatSidePanelProps = {
  workspaceId: string;
};

// 功能图标列表：只有文件可点击，其他灰显占位
const FEATURES = [
  { id: "files", label: "文件", icon: Folder, enabled: true },
  { id: "browser", label: "浏览器", icon: Globe, enabled: false },
  { id: "terminal", label: "终端", icon: Terminal, enabled: false },
  { id: "config", label: "配置", icon: Settings, enabled: false },
] as const;

/** 单个 tab 最大宽度，防止超长文件名占满整个 tab 栏 */
const TAB_MAX_WIDTH = 160;

export function ChatSidePanel({ workspaceId }: ChatSidePanelProps) {
  const activeFeature = useChatSidePanelStore((s) => s.activeFeature);
  const setActiveFeature = useChatSidePanelStore((s) => s.setActiveFeature);
  const treeOpen = useChatSidePanelStore((s) => s.treeOpen);
  const toggleTree = useChatSidePanelStore((s) => s.toggleTree);
  const openFileTabs = useChatSidePanelStore((s) => s.openFileTabs);
  const selectedFilePath = useChatSidePanelStore((s) => s.selectedFilePath);
  const setSelectedFilePath = useChatSidePanelStore((s) => s.setSelectedFilePath);
  const removeFileTab = useChatSidePanelStore((s) => s.removeFileTab);

  const tabRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [menuOpen, setMenuOpen] = useState(false);

  // active tab 变化时自动滚动到可见区域
  useEffect(() => {
    if (!selectedFilePath) return;
    const el = tabRefs.current.get(selectedFilePath);
    el?.scrollIntoView({ behavior: "smooth", inline: "nearest", block: "nearest" });
  }, [selectedFilePath]);

  function handleSelectFromMenu(filepath: string) {
    setSelectedFilePath(filepath);
    setMenuOpen(false);
  }

  function renderTab(filepath: string) {
    const isActive = selectedFilePath === filepath;
    const filename = filepath.split("/").pop() ?? filepath;
    return (
      <div
        key={filepath}
        ref={(el) => {
          if (el) tabRefs.current.set(filepath, el);
          else tabRefs.current.delete(filepath);
        }}
        className={cn(
          "group/tab flex h-full shrink-0 items-stretch border-r border-border/40 text-[11px] transition-colors first:border-l",
          isActive
            ? "bg-accent text-foreground"
            : "bg-transparent text-muted-foreground hover:bg-muted/40 hover:text-foreground",
        )}
        style={{ maxWidth: TAB_MAX_WIDTH }}
        title={filepath}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center px-2 truncate"
          onClick={() => setSelectedFilePath(filepath)}
        >
          {filename}
        </button>
        <button
          type="button"
          className="mr-0.5 flex shrink-0 items-center p-0.5 opacity-0 transition-opacity group-hover/tab:opacity-100"
          onClick={() => removeFileTab(filepath)}
          title="关闭标签"
        >
          <X className="size-3" />
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-background">
      {/* 第一行：功能图标按钮，容器 52px */}
      <div className="flex h-[52px] shrink-0 items-center gap-1 border-b border-border/50 px-2">
        {FEATURES.map((feature) => {
          const Icon = feature.icon;
          const isActive = activeFeature === feature.id;
          if (!feature.enabled) {
            return (
              <span
                key={feature.id}
                className="inline-flex items-center gap-1.5 px-2 text-xs text-muted-foreground/35 select-none"
              >
                <Icon className="size-4" />
                {feature.label}
              </span>
            );
          }
          return (
            <button
              key={feature.id}
              type="button"
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors select-none",
                isActive
                  ? "text-foreground bg-accent"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
              )}
              onClick={() => setActiveFeature(feature.id)}
            >
              <Icon className="size-4" />
              {feature.label}
            </button>
          );
        })}
      </div>

      {/* 第二行：折叠树图标 + 标签页 + 快捷菜单 */}
      <div className="flex h-[28px] shrink-0 items-stretch gap-1 border-b border-border/50 px-1.5">
        <TooltipIconButton
          tooltip={treeOpen ? "折叠文件树" : "展开文件树"}
          side="bottom"
          className="size-5"
          onClick={toggleTree}
        >
          <FolderTree
            className={cn(
              "size-3.5",
              treeOpen ? "text-foreground" : "text-muted-foreground",
            )}
          />
        </TooltipIconButton>

        {/* 标签页列表 — 水平滚动，隐藏滚动条 */}
        <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto scrollbar-hidden">
          {openFileTabs.map((filepath) => renderTab(filepath))}
        </div>

        {/* 快捷跳转菜单 — 始终显示所有已打开标签 */}
        {openFileTabs.length > 0 && (
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  className="flex h-full shrink-0 items-center justify-center px-1.5 text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
                  title="所有标签"
                >
                  <MoreHorizontal className="size-3.5" />
                </button>
              }
            />
            <DropdownMenuContent side="bottom" align="end" className="min-w-48 max-w-64">
              {openFileTabs.map((filepath) => {
                const filename = filepath.split("/").pop() ?? filepath;
                const isActive = selectedFilePath === filepath;
                return (
                  <DropdownMenuItem
                    key={filepath}
                    className={cn(
                      "gap-2 text-xs",
                      isActive && "bg-accent",
                    )}
                    title={filepath}
                    onClick={() => handleSelectFromMenu(filepath)}
                  >
                    <span className="min-w-0 flex-1 truncate">{filename}</span>
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* 内容区 */}
      <div className="min-h-0 flex-1">
        {activeFeature === "files" && (
          <FilePanelContent workspaceId={workspaceId} />
        )}
      </div>
    </div>
  );
}
