import { useRef, useState, useEffect, useLayoutEffect } from "react";
import {
  Folder,
  FileDiff,
  Globe,
  Terminal,
  Settings,
  X,
  MoreHorizontal,
} from "lucide-react";
import { PanelTreeRefreshToolbar } from "@/components/workspace-file-panel/panel-tree-refresh-toolbar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { WorkspaceChangesPanel } from "@/components/workspace-file-panel/workspace-changes-panel";
import { cn } from "@/lib/utils";
import { useChatSidePanelStore } from "@/stores/chat-side-panel-store";
import { useRefreshWorkspaceFiles } from "@/hooks/use-workspace";
import { FilePanelContent } from "./file-panel-content";

export type ChatSidePanelProps = {
  workspaceId: string;
};

// 功能图标列表：只有文件可点击，其他灰显占位
const FEATURES = [
  { id: "files", label: "文件", icon: Folder, enabled: true },
  { id: "changes", label: "变更", icon: FileDiff, enabled: true },
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
  const refreshFiles = useRefreshWorkspaceFiles(workspaceId);

  const tabRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const tabsScrollRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [tabsOverflow, setTabsOverflow] = useState(false);

  // active tab 变化时自动滚动到可见区域
  useEffect(() => {
    if (!selectedFilePath) return;
    const el = tabRefs.current.get(selectedFilePath);
    el?.scrollIntoView({ behavior: "smooth", inline: "nearest", block: "nearest" });
  }, [selectedFilePath]);

  // 标签溢出（scrollWidth > clientWidth）时才显示「⋯」菜单
  useLayoutEffect(() => {
    const el = tabsScrollRef.current;
    if (!el) return;
    const measure = () => setTabsOverflow(el.scrollWidth > el.clientWidth + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [openFileTabs.length]);

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
          "group/tab relative flex h-[24px] shrink-0 self-center items-center rounded-[6px] text-[11px] transition-colors",
          isActive
            ? "bg-accent text-foreground"
            : "bg-transparent text-muted-foreground hover:bg-accent/70 hover:text-foreground",
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
          className={cn(
            "absolute right-0.5 top-1/2 -translate-y-1/2 flex items-center rounded bg-accent p-0.5 text-foreground opacity-0 transition-opacity group-hover/tab:opacity-100",
          )}
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

      {/* 文件视图 */}
      {activeFeature === "files" && (
        <div className="flex min-h-0 flex-1 flex-col">
            {/* 折叠树图标 + 标签页 + 快捷菜单 */}
            <div className="flex h-[32px] shrink-0 items-stretch gap-1 border-b border-border/50 px-1.5">
              <PanelTreeRefreshToolbar
                treeOpen={treeOpen}
                onToggleTree={toggleTree}
                onRefresh={refreshFiles}
              />

              {/* 标签页列表 — 水平滚动，隐藏滚动条 */}
              <div
                ref={tabsScrollRef}
                className="flex min-w-0 flex-1 items-stretch gap-1 overflow-x-auto scrollbar-hidden"
              >
                {openFileTabs.map((filepath) => renderTab(filepath))}
              </div>

              {/* 快捷跳转菜单 — 仅标签溢出时显示 */}
              {tabsOverflow && (
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

            <div className="min-h-0 flex-1">
              <FilePanelContent workspaceId={workspaceId} />
            </div>
          </div>
        )}

      {/* 变更视图 */}
      {activeFeature === "changes" && (
        <div className="flex min-h-0 flex-1 flex-col">
          <WorkspaceChangesPanel workspaceId={workspaceId} />
        </div>
      )}
    </div>
  );
}
