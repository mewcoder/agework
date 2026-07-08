import { useRef, useState, useEffect, useCallback } from "react";
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

const featureButtonClassName =
  "relative inline-flex h-[36px] items-center gap-1 px-2.5 text-xs select-none transition-colors";

// 单个 tab 最小宽度（用于计算可见数量）
const TAB_MIN_WIDTH = 80;
const OVERFLOW_BTN_WIDTH = 32;

export function ChatSidePanel({ workspaceId }: ChatSidePanelProps) {
  const activeFeature = useChatSidePanelStore((s) => s.activeFeature);
  const setActiveFeature = useChatSidePanelStore((s) => s.setActiveFeature);
  const treeOpen = useChatSidePanelStore((s) => s.treeOpen);
  const toggleTree = useChatSidePanelStore((s) => s.toggleTree);
  const openFileTabs = useChatSidePanelStore((s) => s.openFileTabs);
  const selectedFilePath = useChatSidePanelStore((s) => s.selectedFilePath);
  const setSelectedFilePath = useChatSidePanelStore((s) => s.setSelectedFilePath);
  const removeFileTab = useChatSidePanelStore((s) => s.removeFileTab);

  const containerRef = useRef<HTMLDivElement>(null);
  const [maxVisible, setMaxVisible] = useState(0);

  // 计算容器能容纳多少个 tab（预留溢出按钮宽度）
  const recalc = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const width = el.clientWidth;
    const usable = width - OVERFLOW_BTN_WIDTH;
    const count = Math.floor(usable / TAB_MIN_WIDTH);
    setMaxVisible(Math.max(1, count));
  }, []);

  useEffect(() => {
    recalc();
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(recalc);
    ro.observe(el);
    return () => ro.disconnect();
  }, [recalc]);

  // 选中的 tab 必须在可见列表中
  const selectedIndex = selectedFilePath
    ? openFileTabs.indexOf(selectedFilePath)
    : -1;
  const needsOverflow = openFileTabs.length > maxVisible;
  const visibleCount = needsOverflow ? maxVisible : openFileTabs.length;

  // 确保 selected tab 在可见范围内
  let visibleStart = 0;
  if (needsOverflow && selectedIndex >= 0 && selectedIndex >= visibleCount) {
    visibleStart = selectedIndex - visibleCount + 1;
  }
  const visibleTabs = needsOverflow
    ? openFileTabs.slice(visibleStart, visibleStart + visibleCount)
    : openFileTabs;
  const overflowTabs = needsOverflow
    ? openFileTabs.filter((t) => !visibleTabs.includes(t))
    : [];

  function renderTab(filepath: string) {
    const isActive = selectedFilePath === filepath;
    const filename = filepath.split("/").pop() ?? filepath;
    return (
      <div
        key={filepath}
        className={cn(
          "group/tab flex h-full shrink-0 items-stretch border-r border-border/40 text-[11px] transition-colors first:border-l",
          isActive
            ? "bg-accent text-foreground"
            : "bg-transparent text-muted-foreground hover:bg-muted/40 hover:text-foreground",
        )}
        title={filepath}
      >
        <button
          type="button"
          className="flex items-center px-2 truncate"
          onClick={() => setSelectedFilePath(filepath)}
        >
          {filename}
        </button>
        <button
          type="button"
          className="flex items-center pr-1 opacity-0 transition-opacity hover:bg-destructive/10 group-hover/tab:opacity-100"
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
      {/* 第一行：图标+功能名 */}
      <div className="flex h-[36px] shrink-0 items-center gap-0 border-b border-border/50 px-1">
        <div className="flex items-center">
          {FEATURES.map((feature) => {
            const Icon = feature.icon;
            const isActive = activeFeature === feature.id;
            if (!feature.enabled) {
              return (
                <span
                  key={feature.id}
                  className={cn(
                    featureButtonClassName,
                    "cursor-default text-muted-foreground/35",
                  )}
                >
                  <Icon className="size-3.5" />
                  <span>{feature.label}</span>
                </span>
              );
            }
            return (
              <button
                key={feature.id}
                type="button"
                className={cn(
                  featureButtonClassName,
                  isActive
                    ? "text-foreground after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-primary"
                    : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => setActiveFeature(feature.id)}
              >
                <Icon className="size-3.5" />
                <span>{feature.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 第二行：折叠树图标 + 标签页 */}
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

        {/* 标签页列表 */}
        <div ref={containerRef} className="flex min-w-0 flex-1 items-stretch">
          {visibleTabs.map((filepath) => renderTab(filepath))}
        </div>

        {/* 溢出菜单 - 固定在最右侧 */}
        {needsOverflow && (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  className="flex h-full shrink-0 items-center justify-center px-1.5 text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
                  title="更多标签"
                >
                  <MoreHorizontal className="size-3.5" />
                </button>
              }
            />
            <DropdownMenuContent side="bottom" align="end" className="min-w-40">
              {overflowTabs.map((filepath) => {
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
                    onClick={() => setSelectedFilePath(filepath)}
                  >
                    <span className="min-w-0 flex-1 truncate">{filename}</span>
                    <button
                      type="button"
                      className="inline-flex size-3.5 shrink-0 items-center justify-center rounded hover:bg-destructive/10"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeFileTab(filepath);
                      }}
                      title="关闭标签"
                    >
                      <X className="size-2.5" />
                    </button>
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
