import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Loader2, Search, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { IconActionButton } from "@/components/icon-action-button";
import { useConversationSearch } from "@/hooks/use-conversation";
import { useWorkspaces } from "@/hooks/use-workspace";

interface ConversationSearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeConversationId?: string;
}

/** 把 snippet 中所有匹配 query 的子串包成 <mark> */
function renderSnippet(snippet: string, query: string) {
  if (!query) return snippet;
  const lower = snippet.toLowerCase();
  const q = query.toLowerCase();
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let idx = lower.indexOf(q, cursor);
  let key = 0;
  while (idx >= 0) {
    if (idx > cursor) parts.push(snippet.slice(cursor, idx));
    parts.push(
      <mark
        key={`m-${key++}`}
        className="rounded-sm bg-yellow-100 px-0.5 text-foreground dark:bg-yellow-900/50"
      >
        {snippet.slice(idx, idx + query.length)}
      </mark>,
    );
    cursor = idx + query.length;
    idx = lower.indexOf(q, cursor);
  }
  if (cursor < snippet.length) parts.push(snippet.slice(cursor));
  return parts;
}

export function ConversationSearchDialog({
  open,
  onOpenChange,
  activeConversationId,
}: ConversationSearchDialogProps) {
  const [searchInput, setSearchInput] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const trimmed = searchInput.trim();
    if (trimmed === debouncedSearch) return;
    const timer = window.setTimeout(() => setDebouncedSearch(trimmed), 300);
    return () => window.clearTimeout(timer);
  }, [searchInput, debouncedSearch]);

  // 弹窗关闭时重置输入
  useEffect(() => {
    if (!open) {
      queueMicrotask(() => {
        setSearchInput("");
        setDebouncedSearch("");
      });
    }
  }, [open]);

  const { data: hits = [], isFetching } = useConversationSearch(debouncedSearch);
  const { data: workspaces = [] } = useWorkspaces();
  const isSearching = debouncedSearch.length > 0;

  // workspaceId → name 映射，用于结果右侧显示工作空间名称
  const workspaceNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const ws of workspaces) map.set(ws.id, ws.name);
    return map;
  }, [workspaces]);

  const hitItems = useMemo(() => {
    if (!isSearching) return [];
    return hits.map((hit) => ({
      ...hit,
      isActive: hit.conversation.conversationId === activeConversationId,
      workspaceName: workspaceNameMap.get(hit.conversation.workspaceId) ?? "—",
    }));
  }, [hits, isSearching, activeConversationId, workspaceNameMap]);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
    >
      <DialogContent
        className="flex h-[460px] w-[520px] max-w-[calc(100%-1rem)] flex-col gap-0 p-0 sm:max-w-[560px]"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">搜索对话</DialogTitle>
        {/* 搜索输入栏 */}
        <div className="flex items-center gap-2 border-b px-4 py-2">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <Input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="搜索对话标题或消息内容..."
            autoFocus
            className="h-8 border-0 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 text-sm"
          />
          {searchInput && (
            <IconActionButton
              tooltip="清除搜索"
              onClick={() => {
                setSearchInput("");
                setDebouncedSearch("");
              }}
            >
              <X className="size-4" />
            </IconActionButton>
          )}
        </div>

        {/* 结果列表 */}
        <div className="overflow-y-auto flex-1 min-h-0">
          {!isSearching ? (
            <p className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
              输入关键词搜索对话
            </p>
          ) : isFetching && hits.length === 0 ? (
            <p className="flex h-full items-center justify-center gap-2 px-4 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              搜索中…
            </p>
          ) : hits.length === 0 ? (
            <p className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
              未找到匹配的对话
            </p>
          ) : (
            <ul className="divide-y" role="listbox">
              {hitItems.map((item) => (
                <li key={item.conversation.conversationId}>
                  <Link
                    to="/c/$conversationId"
                    params={{ conversationId: item.conversation.conversationId }}
                    onClick={() => onOpenChange(false)}
                    className={`block px-4 py-3 hover:bg-muted/60 transition-colors ${item.isActive ? 'bg-muted/40' : ''}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate leading-tight mb-0.5">
                          {item.conversation.title ?? "New Chat"}
                        </p>
                        <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
                          {renderSnippet(item.matchedSnippet, debouncedSearch)}
                        </p>
                      </div>
                      <span className="shrink-0 mt-0.5 max-w-[30%] truncate text-xs text-muted-foreground" title={item.workspaceName}>
                        {item.workspaceName}
                      </span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* 底部提示 */}
        {isSearching && hits.length > 0 && (
          <div className="border-t px-4 py-2 text-xs text-muted-foreground/70">
            共 {hits.length} 条结果
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
