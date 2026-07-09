import { Fragment, useEffect, useState } from "react";
import { Folder, FolderDot, FolderOpen, Plus } from "lucide-react";
import { useWorkspaces } from "@/hooks/use-workspace";
import { useAgentChatContext } from "@/components/agent-chat-context";
import { useSelectionStore } from "@/stores/selection-store";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxSeparator,
  ComboboxTrigger,
  ComboboxValue,
} from "@/components/ui/combobox";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { WorkspaceDialog } from "@/components/workspace-dialog";
import { PickDirectoryDialog } from "@/components/pick-directory-dialog";
import { cn } from "@/lib/utils";

const NEW_PROJECT_VALUE = "__new__";
const PICK_DIRECTORY_VALUE = "__pick_dir__";

interface WorkspaceSelectorProps {
  attentionToken?: number;
}

type WorkspaceItem = {
  value: string;
  label: string;
  runtimeType?: "native" | "docker" | "opensandbox";
};

export function WorkspaceSelector({ attentionToken = 0 }: WorkspaceSelectorProps) {
  const { onSelectWorkspace } = useAgentChatContext();
  const selectedConversationId = useSelectionStore((s) => s.selectedConversationId);
  const selectedWorkspaceId = useSelectionStore((s) => s.selectedWorkspaceId);
  const { data: workspaces = [], isSuccess } = useWorkspaces();
  const [showWorkspaceDialog, setShowWorkspaceDialog] = useState(false);
  const [showPickDialog, setShowPickDialog] = useState(false);
  const [showAttention, setShowAttention] = useState(false);
  const selectedWorkspace = workspaces.find((workspace) => workspace.id === selectedWorkspaceId);
  const selectedWorkspaceExists =
    !!selectedWorkspaceId &&
    !!selectedWorkspace;

  const workspaceItems: WorkspaceItem[] = workspaces.map((w) => ({
    value: w.id,
    label: w.name,
    runtimeType: w.runtimeType,
  }));
  const selected: WorkspaceItem | null = selectedWorkspaceExists
    ? workspaceItems.find((item) => item.value === selectedWorkspaceId) ?? null
    : null;
  const items: WorkspaceItem[] = [
    ...workspaceItems,
    { value: NEW_PROJECT_VALUE, label: "添加工作空间" },
    { value: PICK_DIRECTORY_VALUE, label: "选择本地文件夹" },
  ];

  useEffect(() => {
    if (attentionToken === 0 || selectedWorkspaceId) return undefined;
    queueMicrotask(() => setShowAttention(false));
    const showId = window.setTimeout(() => setShowAttention(true), 0);
    const hideId = window.setTimeout(() => setShowAttention(false), 2600);

    return () => {
      window.clearTimeout(showId);
      window.clearTimeout(hideId);
    };
  }, [attentionToken, selectedWorkspaceId]);

  // 清理已删除的工作空间选中状态（store 中的 ID 在列表中已不存在时）。
  // 不再自动选中第一个工作空间，让用户主动选择；未选中时显示 placeholder 提示。
  useEffect(() => {
    if (selectedConversationId !== undefined || !isSuccess) return;
    if (selectedWorkspaceExists || !selectedWorkspaceId) return;

    useSelectionStore.getState().clearSelectedWorkspace();
  }, [
    isSuccess,
    selectedWorkspaceExists,
    selectedWorkspaceId,
    selectedConversationId,
  ]);

  if (selectedConversationId !== undefined) return null;

  const handleSelect = (item: WorkspaceItem | null) => {
    if (!item) return;
    if (item.value === NEW_PROJECT_VALUE) {
      setShowWorkspaceDialog(true);
    } else if (item.value === PICK_DIRECTORY_VALUE) {
      setShowPickDialog(true);
    } else {
      onSelectWorkspace(item.value);
    }
  };

  return (
    <>
      <Combobox
        items={items}
        value={selected}
        onValueChange={handleSelect}
        itemToStringValue={(item) => item.label}
      >
        <Tooltip open={showAttention}>
          <TooltipTrigger render={
            <ComboboxTrigger
              className={cn(
                "inline-flex h-6 w-auto max-w-[min(18rem,72vw)] items-center gap-1.5 rounded-md border-0 bg-transparent px-1.5 text-xs leading-none text-muted-foreground shadow-none hover:bg-transparent focus-visible:ring-1 focus-visible:ring-ring/30 dark:bg-transparent dark:hover:bg-transparent [&_[data-slot=combobox-value]]:flex [&_[data-slot=combobox-value]]:min-w-0 [&_[data-slot=combobox-value]]:items-center [&_[data-slot=combobox-value]]:leading-none",
                showAttention &&
                  "workspace-selector-attention text-foreground ring-1 ring-ring/30",
              )}
              render={
                <button
                  className="select-none"
                  aria-label="选择工作空间"
                />
              }
            >
              <WorkspaceItemIcon
                runtimeType={selected?.runtimeType}
                className="size-3.5 shrink-0 text-muted-foreground"
              />
              <ComboboxValue placeholder="选择工作空间" />
            </ComboboxTrigger>
          } />
          <TooltipContent side="top" align="start" sideOffset={6}>
            请选择工作空间
          </TooltipContent>
        </Tooltip>
        <ComboboxContent side="bottom" align="start" className="min-w-56">
          <ComboboxInput showTrigger={false} placeholder="搜索项目" />
          <ComboboxEmpty>未找到项目</ComboboxEmpty>
          <ComboboxList>
            {(item: WorkspaceItem) => {
              if (item.value === NEW_PROJECT_VALUE) {
                return (
                  <Fragment key={item.value}>
                    <ComboboxSeparator />
                    <ComboboxItem
                      value={item}
                      className="text-muted-foreground"
                    >
                      <Plus className="size-4" />
                      {item.label}
                    </ComboboxItem>
                  </Fragment>
                );
              }
              if (item.value === PICK_DIRECTORY_VALUE) {
                return (
                  <ComboboxItem
                    key={item.value}
                    value={item}
                    className="text-muted-foreground"
                  >
                    <FolderOpen className="size-4" />
                    {item.label}
                  </ComboboxItem>
                );
              }
              return (
                <ComboboxItem key={item.value} value={item} title={item.label}>
                  <WorkspaceItemIcon
                    runtimeType={item.runtimeType}
                    className="size-4"
                  />
                  <span className="truncate">{item.label}</span>
                </ComboboxItem>
              );
            }}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>

      <WorkspaceDialog
        open={showWorkspaceDialog}
        onOpenChange={setShowWorkspaceDialog}
        onCreated={(workspace) => onSelectWorkspace(workspace.id)}
      />

      <PickDirectoryDialog
        open={showPickDialog}
        onOpenChange={setShowPickDialog}
        onCreated={onSelectWorkspace}
      />
    </>
  );
}

function WorkspaceItemIcon({
  runtimeType,
  className,
}: {
  runtimeType?: WorkspaceItem["runtimeType"];
  className?: string;
}) {
  if (runtimeType && runtimeType !== "native") {
    return <FolderDot className={className} />;
  }

  return <Folder className={className} />;
}
