import { useState } from "react";
import type { ConversationSortKey } from "@/hooks/use-conversations";

export type ConversationListViewMode = "grouped" | "flat";
export type GroupedSort = "default" | "active";
export type FlatSort = ConversationSortKey;

const CONVERSATION_LIST_VIEW_STORAGE_KEY = "sidebar-conversation-list-view";
const GROUPED_SORT_STORAGE_KEY = "sidebar-grouped-sort";
const FLAT_SORT_STORAGE_KEY = "sidebar-flat-sort";
const VIEW_MODES: ConversationListViewMode[] = ["grouped", "flat"];

function loadConversationListViewMode(): ConversationListViewMode {
  try {
    const value = localStorage.getItem(CONVERSATION_LIST_VIEW_STORAGE_KEY);
    if (VIEW_MODES.includes(value as ConversationListViewMode)) {
      return value as ConversationListViewMode;
    }
  } catch { /* ignore */ }
  return "grouped";
}

function loadGroupedSort(): GroupedSort {
  try {
    const value = localStorage.getItem(GROUPED_SORT_STORAGE_KEY);
    if (value === "default" || value === "active") return value;
  } catch { /* ignore */ }
  return "default";
}

function loadFlatSort(): FlatSort {
  try {
    const value = localStorage.getItem(FLAT_SORT_STORAGE_KEY);
    if (value === "updatedAt" || value === "createdAt") return value;
  } catch { /* ignore */ }
  return "updatedAt";
}

// 侧边栏对话列表的显示方式（分组/全部）与排序方式，持久化到 localStorage
export function useConversationListView() {
  const [viewMode, setViewModeState] = useState<ConversationListViewMode>(loadConversationListViewMode);
  const [groupedSort, setGroupedSortState] = useState<GroupedSort>(loadGroupedSort);
  const [flatSort, setFlatSortState] = useState<FlatSort>(loadFlatSort);

  function setViewMode(next: ConversationListViewMode) {
    setViewModeState(next);
    try {
      localStorage.setItem(CONVERSATION_LIST_VIEW_STORAGE_KEY, next);
    } catch { /* ignore */ }
  }

  function setGroupedSort(next: GroupedSort) {
    setGroupedSortState(next);
    try {
      localStorage.setItem(GROUPED_SORT_STORAGE_KEY, next);
    } catch { /* ignore */ }
  }

  function setFlatSort(next: FlatSort) {
    setFlatSortState(next);
    try {
      localStorage.setItem(FLAT_SORT_STORAGE_KEY, next);
    } catch { /* ignore */ }
  }

  return {
    viewMode,
    setViewMode,
    groupedSort,
    setGroupedSort,
    flatSort,
    setFlatSort,
  };
}
