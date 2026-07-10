import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface ChatSidePanelStore {
  /** 当前功能，默认 'files' */
  activeFeature: string;
  /** 面板开关 */
  panelOpen: boolean;
  /** 文件树折叠状态 */
  treeOpen: boolean;
  /** 当前选中文件路径 */
  selectedFilePath: string | undefined;
  /** 打开的文件标签页列表 */
  openFileTabs: string[];

  setActiveFeature: (feature: string) => void;
  setPanelOpen: (open: boolean) => void;
  togglePanel: () => void;
  setTreeOpen: (open: boolean) => void;
  toggleTree: () => void;
  setSelectedFilePath: (path: string | undefined) => void;
  addFileTab: (filepath: string) => void;
  removeFileTab: (filepath: string) => void;
}

export const useChatSidePanelStore = create<ChatSidePanelStore>()(
  persist(
    (set) => ({
      // ── 持久化字段 ──
      activeFeature: 'files',
      panelOpen: false,
      treeOpen: true,

      // ── 非持久化字段 ──
      selectedFilePath: undefined,
      openFileTabs: [],

      // ── Actions ──
      setActiveFeature: (feature) => set({ activeFeature: feature }),
      setPanelOpen: (open) => set({ panelOpen: open }),
      togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
      setTreeOpen: (open) => set({ treeOpen: open }),
      toggleTree: () => set((s) => ({ treeOpen: !s.treeOpen })),
      setSelectedFilePath: (path) => set({ selectedFilePath: path }),
      addFileTab: (filepath) =>
        set((s) => {
          if (s.openFileTabs.includes(filepath)) return s;
          return { openFileTabs: [...s.openFileTabs, filepath] };
        }),
      removeFileTab: (filepath) =>
        set((s) => {
          const next = s.openFileTabs.filter((t) => t !== filepath);
          const selectedFilePath =
            s.selectedFilePath === filepath
              ? next[next.length - 1] ?? undefined
              : s.selectedFilePath;
          return { openFileTabs: next, selectedFilePath };
        }),
    }),
    {
      name: 'agework-chat-side-panel',
      partialize: (state) => ({
        activeFeature: state.activeFeature,
        treeOpen: state.treeOpen,
      }),
      // panelOpen 不持久化（每次会话默认关闭），但旧版本写入的
      // panelOpen 仍残留在 localStorage，默认浅合并会把它 hydrate 回来，
      // 导致进对话时面板自动展开。这里只取白名单字段，丢弃 panelOpen。
      merge: (persisted, currentState) => {
        const p = (persisted ?? {}) as Partial<ChatSidePanelStore>;
        return {
          ...currentState,
          activeFeature: p.activeFeature ?? currentState.activeFeature,
          treeOpen: p.treeOpen ?? currentState.treeOpen,
        };
      },
    },
  ),
);
