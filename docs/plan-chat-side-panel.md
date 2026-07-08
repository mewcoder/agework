# 聊天区域右侧侧边栏重新设计 — 实现计划

## 背景

当前聊天区域右侧只有一个固定宽度 320px 的文件面板（WorkspaceFilePanel），上下各占一半展示文件树和文件预览。无法切换其他面板、布局不可调整、文件树不可折叠。

## 确认的布局方案

```
┌───────────────────────────────────┬──────────────────────────────┐
│ ChatHeader (不贯通)               │ 📁文件 🌐浏览器 🖥️终端 ⚙️配置 │
│ [对话标题] [工作空间] [Agent]     │──────────────────────────────│
│                    [侧边栏开关]   │ [折叠树] [tab1] [tab2] ...   │
├───────────────────────────────────┤──────────────────────────────│
│                                   │ ┌──────┬─────────────────────┐│
│           Thread                  │ │ 文件 │   文件预览           ││
│        (聊天主区域)               │ │ 树   │   (可拖拽比例)       ││
│                                   │ │(可折叠│                     ││
│                                   │ │ 隐藏)│                     ││
│                                   │ └──────┴─────────────────────┘│
└───────────────────────────────────┴──────────────────────────────┘
```

### 关键设计决策

1. **ChatHeader 不贯通** — 只覆盖聊天区，面板有自己的完整纵向空间（含头部）
2. **分割线从上到下贯通** — 聊天区和面板之间只有一条垂直 ResizableHandle，没有横向分割
3. **面板头部两行**：
   - 第一行：图标+功能名按钮（📁文件、🌐浏览器、🖥️终端、⚙️配置），只有文件可点击，其他灰显占位
   - 第二行：左侧折叠/展开文件树图标 + 标签页（文件名，hover 显示完整路径）
4. **面板宽度可拖拽** — 使用 ResizablePanelGroup，宽度持久化
5. **文件树可折叠隐藏** — 折叠后预览区占满面板宽度
6. **文件树和预览左右分栏** — 使用 ResizablePanelGroup direction="horizontal"，比例可拖拽
7. **首批只实现文件面板** — 其他功能图标灰显占位，后期拓展

---

## 实现步骤

### Step 1: 安装依赖

```bash
pnpm add react-resizable-panels --filter web
```

然后手动创建 `apps/web/src/components/ui/resizable.tsx`，基于 `react-resizable-panels` 封装，参考 shadcn resizable 组件的标准实现。导出 `ResizablePanelGroup`, `ResizablePanel`, `ResizableHandle`。

### Step 2: 创建状态管理

**新建文件**: `apps/web/src/stores/chat-side-panel-store.ts`

使用 zustand + persist 管理：

```ts
interface ChatSidePanelStore {
  activeFeature: string;          // 当前功能，默认 'files'
  panelOpen: boolean;             // 面板开关
  treeOpen: boolean;              // 文件树折叠状态
  selectedFilePath: string | undefined;  // 当前选中文件路径
  openFileTabs: string[];         // 打开的文件标签页列表

  setActiveFeature: (feature: string) => void;
  setPanelOpen: (open: boolean) => void;
  togglePanel: () => void;
  setTreeOpen: (open: boolean) => void;
  toggleTree: () => void;
  setSelectedFilePath: (path: string | undefined) => void;
  addFileTab: (filename: string) => void;
  removeFileTab: (filename: string) => void;
}
```

持久化字段：`activeFeature`, `panelOpen`, `treeOpen`。`selectedFilePath` 和 `openFileTabs` 不持久化（跟随对话切换）。

### Step 3: 创建 ChatSidePanel 容器组件

**新建文件**: `apps/web/src/components/chat-side-panel/chat-side-panel.tsx`

```tsx
// Props
type ChatSidePanelProps = {
  workspaceId: string;
  onClose: () => void;
};

// 结构
<div className="flex h-full flex-col border-l border-border/50 bg-background">
  {/* 第一行：图标+功能名 */}
  <div className="flex items-center h-[36px] shrink-0 px-3 gap-2 border-b border-border/50">
    {/* 功能按钮列表 */}
    {/* 📁文件(可点击) / 🌐浏览器(灰显) / 🖥️终端(灰显) / ⚙️配置(灰显) */}
  </div>

  {/* 第二行：折叠树图标 + 标签页 */}
  <div className="flex items-center h-[30px] shrink-0 border-b border-border/50 bg-muted overflow-x-auto">
    {/* 左侧：折叠/展开文件树图标按钮 */}
    {/* 右侧：标签页按钮（文件名，hover显示完整路径） */}
  </div>

  {/* 内容区 */}
  <div className="min-h-0 flex-1">
    {activeFeature === 'files' && <FilePanelContent workspaceId={workspaceId} />}
  </div>
</div>
```

功能按钮样式参考现有 `agent-settings-menu.tsx` 的 `triggerClassName`（`rounded-md h-[26px] px-2 text-xs`）。
标签页样式参考现有 `tabs.tsx` 的 `TabsTrigger`（选中白底，未选中灰底）。
折叠树按钮使用 `TooltipIconButton`（来自 `assistant-ui/tooltip-icon-button.tsx`）。

### Step 4: 创建 FilePanelContent 组件

**新建文件**: `apps/web/src/components/chat-side-panel/file-panel-content.tsx`

基于现有 WorkspaceFilePanel 重构为左右分栏：

```tsx
<div className="flex min-h-0 flex-1">
  {/* 文件树（可折叠） */}
  {treeOpen && (
    <ResizablePanelGroup direction="horizontal">
      <ResizablePanel defaultSize={35} minSize={20} maxSize={60}>
        <ScrollArea className="h-full">
          <div className="p-2">
            {/* 文件搜索框 */}
            <FileTreeNode workspaceId={workspaceId} path="" ... />
          </div>
        </ScrollArea>
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={65} minSize={30}>
        <WorkspaceFilePreview workspaceId={workspaceId} path={selectedFilePath} />
      </ResizablePanel>
    </ResizablePanelGroup>
  )}

  {/* 文件树折叠时：预览占满 */}
  {!treeOpen && (
    <div className="min-h-0 flex-1">
      <WorkspaceFilePreview workspaceId={workspaceId} path={selectedFilePath} />
    </div>
  )}
</div>
```

复用现有组件：
- `FileTreeNode` from `apps/web/src/components/workspace-file-panel/workspace-file-tree.tsx`
- `WorkspaceFilePreview` from `apps/web/src/components/workspace-file-panel/workspace-file-preview.tsx`
- `useWorkspaceFiles`, `useRefreshWorkspaceFiles`, `useWorkspaceFileContent` from `apps/web/src/hooks/use-workspace.ts`

### Step 5: 重构 WorkbenchPage 布局

**修改文件**: `apps/web/src/pages/workbench.tsx`

核心改动：

1. **ChatHeader 移到聊天 ResizablePanel 内部**（不贯通到面板）
2. **聊天区和面板用 ResizablePanelGroup 包裹**
3. **移除 `filePanelOpen` 状态**（迁移到 `chatSidePanelStore`）

```tsx
// 之前：
<SidebarInset>
  <ChatHeader rightSlot={...} />     ← 贯通整个宽度
  <div className="flex min-h-0 flex-1">
    <Thread />
    {filePanelOpen && <WorkspaceFilePanel />}
  </div>
</SidebarInset>

// 之后：
<SidebarInset className="relative min-h-0 overflow-hidden ...">
  <ResizablePanelGroup direction="horizontal" className="flex min-h-0 flex-1">
    {/* 聊天区（ChatHeader 在这里，不贯通） */}
    <ResizablePanel defaultSize={70} minSize={40}>
      <div className="flex h-full flex-col">
        <ChatHeader rightSlot={canShowPanel ? sidebarToggleButton : undefined} />
        <AssistantRuntimeProvider runtime={runtime}>
          <Thread />
        </AssistantRuntimeProvider>
      </div>
    </ResizablePanel>

    {/* 面板区 */}
    {panelOpen && canShowPanel && workspaceId ? (
      <>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize={30} minSize={20} maxSize={50}>
          <ChatSidePanel workspaceId={workspaceId} onClose={closePanel} />
        </ResizablePanel>
      </>
    ) : null}
  </ResizablePanelGroup>
</SidebarInset>
```

注意：ChatHeader 需要从 SidebarInset 顶层移到聊天 ResizablePanel 内部。需要调整 ChatHeader 的 `pl-4` 等样式，因为它不再直接在 SidebarInset 里。

### Step 6: 更新 ChatHeader

**修改文件**: `apps/web/src/components/assistant-ui/chat-header.tsx`

- `rightSlot` 改为侧边栏开关按钮（从 `chatSidePanelStore.togglePanel`）
- 移除文件面板开关逻辑（已迁移到 store）
- ChatHeader 的 padding 需要适配新的容器位置

### Step 7: 清理旧组件

- **删除**: `apps/web/src/components/workspace-file-panel/workspace-file-panel.tsx`（逻辑已迁移到 ChatSidePanel + FilePanelContent）
- **保留**: `workspace-file-tree.tsx` 和 `workspace-file-preview.tsx`（内容组件不变）
- **删除 demo**: `demo-sidebar-layout.html`

---

## 文件清单

| 操作 | 文件路径 |
|---|---|
| 安装依赖 | `react-resizable-panels` (pnpm add --filter web) |
| 新建 | `apps/web/src/components/ui/resizable.tsx` |
| 新建 | `apps/web/src/components/chat-side-panel/chat-side-panel.tsx` |
| 新建 | `apps/web/src/components/chat-side-panel/file-panel-content.tsx` |
| 新建 | `apps/web/src/stores/chat-side-panel-store.ts` |
| 修改 | `apps/web/src/pages/workbench.tsx` |
| 修改 | `apps/web/src/components/assistant-ui/chat-header.tsx` |
| 保留 | `apps/web/src/components/workspace-file-panel/workspace-file-tree.tsx` |
| 保留 | `apps/web/src/components/workspace-file-panel/workspace-file-preview.tsx` |
| 删除 | `apps/web/src/components/workspace-file-panel/workspace-file-panel.tsx` |
| 删除 | `demo-sidebar-layout.html` |

---

## 可复用的现有组件和 hooks

| 组件/hook | 文件 | 用途 |
|---|---|---|
| `FileTreeNode` | `workspace-file-panel/workspace-file-tree.tsx` | 文件树节点 |
| `WorkspaceFilePreview` | `workspace-file-panel/workspace-file-preview.tsx` | 文件预览 |
| `useWorkspaceFiles` | `hooks/use-workspace.ts` | 文件列表数据 |
| `useRefreshWorkspaceFiles` | `hooks/use-workspace.ts` | 刷新文件列表 |
| `useWorkspaceFileContent` | `hooks/use-workspace.ts` | 文件内容数据 |
| `TooltipIconButton` | `assistant-ui/tooltip-icon-button.tsx` | 带 tooltip 的图标按钮 |
| `ScrollArea` | `ui/scroll-area.tsx` | 滚动容器 |
| `Button` | `ui/button.tsx` | 按钮 |
| `useSelectionStore` | `stores/selection-store.ts` | 获取 selectedConversationId / selectedWorkspaceId |
| `useConversations` | `hooks/use-conversation.ts` | 获取对话列表 |
| `useWorkspaces` | `hooks/use-workspace.ts` | 获取工作空间列表 |

---

## 验证方式

1. **类型检查**: `pnpm --filter web typecheck` 通过
2. **浏览器验证**:
   - ChatHeader 不贯通，面板有自己的头部
   - 面板头部两行：图标+功能名 / 折叠树+标签页
   - 文件树可折叠隐藏，折叠后预览占满面板宽度
   - 树和预览左右分栏，可拖拽调整比例
   - 面板总宽度可拖拽，有拖拽手柄
   - 关闭面板后聊天区恢复全宽，ChatHeader 也恢复全宽
   - 侧边栏开关按钮在 ChatHeader 右侧正常工作
   - 点击文件树中的文件，标签页自动添加，hover 显示完整路径
3. **移动端**: 不显示侧边栏（canShowPanel 逻辑保留）
4. **持久化**: 刷新页面后面板开关状态、折叠状态保持
