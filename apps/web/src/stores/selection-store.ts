import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AgentType } from '@agework/shared';
import type {
  ClaudePermissionMode,
  CodexPermissionMode,
} from '@agework/shared/api';

export type { AgentType };
export type {
  ClaudePermissionMode,
  CodexPermissionMode,
} from '@agework/shared/api';
export type ConversationId = string;
export type ModelReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
export type ClaudeThinkingMode = 'adaptive' | 'disabled';

// ── 向后兼容：从旧 localStorage 键读取初始值 ────────────────────────────
// persist middleware 统一使用 'agework-selection' 键，
// 首次加载时从旧键读取以兼容已登录用户。
const VALID_EFFORTS: ModelReasoningEffort[] = ['low', 'medium', 'high', 'xhigh'];
const VALID_CLAUDE_THINKING_MODES: ClaudeThinkingMode[] = ['adaptive', 'disabled'];
const VALID_CLAUDE_PERMISSION_MODES: ClaudePermissionMode[] = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'auto'];
const VALID_CODEX_PERMISSION_MODES: CodexPermissionMode[] = ['default', 'auto-review', 'full-access'];

function loadInitial<T>(key: string, validate: (v: string) => T | null, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    if (v) {
      const result = validate(v);
      if (result !== null) return result;
    }
  } catch { /* ignore */ }
  return fallback;
}

/**
 * 同步读取已持久化的 workspaceId。
 * 供初始化阶段（store hydrate 前）使用，如 conversation-list 判断默认展开。
 */
export function loadSelectedWorkspaceId(): string | undefined {
  try {
    // 优先从 persist middleware 的 storage 读取
    const raw = localStorage.getItem('agework-selection');
    if (raw) {
      const parsed = JSON.parse(raw);
      const id = parsed?.state?.selectedWorkspaceId;
      if (typeof id === 'string' && id.trim()) return id;
    }
    // 回退到旧键
    const v = localStorage.getItem('selected-workspace-id');
    return v?.trim() ? v : undefined;
  } catch { /* ignore */ }
  return undefined;
}

// ── Store 定义 ──────────────────────────────────────────────────────────

interface SelectionStore {
  selectedConversationId: ConversationId | undefined;
  selectedWorkspaceId: string | undefined;
  selectedAgentType: AgentType;
  selectedModelProviderIds: Partial<Record<AgentType, string>>;
  selectedModelByProviderIds: Partial<Record<string, string>>;
  modelReasoningEffort: ModelReasoningEffort;
  claudeThinkingMode: ClaudeThinkingMode;
  claudePermissionMode: ClaudePermissionMode;
  codexPermissionMode: CodexPermissionMode;
  newConversationFocusToken: number;
  startNewConversation: (workspaceId?: string, agent?: AgentType) => void;
  selectConversation: (conversationId: ConversationId, agentType?: AgentType, workspaceId?: string) => void;
  selectWorkspace: (workspaceId: string) => void;
  clearSelectedWorkspace: () => void;
  selectAgentType: (agentType: AgentType) => void;
  selectModelProvider: (agentType: AgentType, modelProviderId?: string) => void;
  selectModelForProvider: (modelProviderId: string, model?: string) => void;
  setModelReasoningEffort: (effort: ModelReasoningEffort) => void;
  setClaudeThinkingMode: (mode: ClaudeThinkingMode) => void;
  setClaudePermissionMode: (mode: ClaudePermissionMode) => void;
  setCodexPermissionMode: (mode: CodexPermissionMode) => void;
}

// 从旧键读取的初始值（仅首次 hydrate 前生效）
const initialWorkspaceId = loadInitial(
  'selected-workspace-id',
  (v) => v.trim() || null,
  undefined as string | undefined,
);
const initialReasoningEffort = loadInitial(
  'codex-reasoning-effort',
  (v) => VALID_EFFORTS.includes(v as ModelReasoningEffort) ? v as ModelReasoningEffort : null,
  'medium' as ModelReasoningEffort,
);
const initialThinkingMode = loadInitial(
  'claude-thinking-mode',
  (v) => VALID_CLAUDE_THINKING_MODES.includes(v as ClaudeThinkingMode) ? v as ClaudeThinkingMode : null,
  'adaptive' as ClaudeThinkingMode,
);
const initialClaudePermissionMode = loadInitial(
  'claude-permission-mode',
  (v) => VALID_CLAUDE_PERMISSION_MODES.includes(v as ClaudePermissionMode) ? v as ClaudePermissionMode : null,
  'acceptEdits' as ClaudePermissionMode,
);
const initialCodexPermissionMode = loadInitial(
  'codex-permission-mode',
  (v) => VALID_CODEX_PERMISSION_MODES.includes(v as CodexPermissionMode) ? v as CodexPermissionMode : null,
  'auto-review' as CodexPermissionMode,
);
const initialModelProviders: Partial<Record<AgentType, string>> = {};
for (const agent of ['claude', 'codex'] as AgentType[]) {
  try {
    const v = localStorage.getItem(`selected-model-provider-id:${agent}`);
    if (v?.trim()) initialModelProviders[agent] = v.trim();
  } catch { /* ignore */ }
}

// 清理旧 localStorage 键（迁移到 persist 后不再需要）
function cleanupOldKeys() {
  try {
    localStorage.removeItem('codex-reasoning-effort');
    localStorage.removeItem('claude-thinking-mode');
    localStorage.removeItem('agent-permission-mode');
    localStorage.removeItem('claude-permission-mode');
    localStorage.removeItem('codex-approval-policy');
    localStorage.removeItem('codex-sandbox-mode');
    localStorage.removeItem('codex-permission-mode');
    localStorage.removeItem('selected-workspace-id');
    localStorage.removeItem('selected-model-provider-id:claude');
    localStorage.removeItem('selected-model-provider-id:codex');
  } catch { /* ignore */ }
}

export const useSelectionStore = create<SelectionStore>()(
  persist(
    (set) => ({
      // ── 非持久化字段 ──
      selectedConversationId: undefined,
      selectedAgentType: 'claude' as AgentType,
      newConversationFocusToken: 0,

      // ── 持久化字段（初始值从旧键读取以兼容迁移）──
      selectedWorkspaceId: initialWorkspaceId,
      selectedModelProviderIds: initialModelProviders,
      selectedModelByProviderIds: {},
      modelReasoningEffort: initialReasoningEffort,
      claudeThinkingMode: initialThinkingMode,
      claudePermissionMode: initialClaudePermissionMode,
      codexPermissionMode: initialCodexPermissionMode,

      // ── Actions ──
      startNewConversation: (workspaceId, agentType) =>
        set((state) => ({
          selectedConversationId: undefined,
          selectedWorkspaceId: workspaceId,
          selectedAgentType: agentType ?? state.selectedAgentType,
          newConversationFocusToken: state.newConversationFocusToken + 1,
        })),
      selectConversation: (conversationId, agentType, workspaceId) =>
        set((state) => ({
          selectedConversationId: conversationId,
          selectedWorkspaceId: workspaceId,
          selectedAgentType: agentType ?? state.selectedAgentType,
        })),
      selectWorkspace: (workspaceId) =>
        set({
          selectedConversationId: undefined,
          selectedWorkspaceId: workspaceId,
        }),
      clearSelectedWorkspace: () =>
        set({ selectedWorkspaceId: undefined }),
      selectAgentType: (agentType) => set({ selectedAgentType: agentType }),
      selectModelProvider: (agentType, modelProviderId) =>
        set((state) => {
          const selectedModelProviderIds = { ...state.selectedModelProviderIds };
          if (modelProviderId?.trim()) selectedModelProviderIds[agentType] = modelProviderId;
          else delete selectedModelProviderIds[agentType];
          return { selectedModelProviderIds };
        }),
      selectModelForProvider: (modelProviderId, model) =>
        set((state) => {
          const selectedModelByProviderIds = { ...state.selectedModelByProviderIds };
          if (model?.trim()) selectedModelByProviderIds[modelProviderId] = model.trim();
          else delete selectedModelByProviderIds[modelProviderId];
          return { selectedModelByProviderIds };
        }),
      setModelReasoningEffort: (effort) => set({ modelReasoningEffort: effort }),
      setClaudeThinkingMode: (mode) => set({ claudeThinkingMode: mode }),
      setClaudePermissionMode: (mode) => set({ claudePermissionMode: mode }),
      setCodexPermissionMode: (mode) => set({ codexPermissionMode: mode }),
    }),
    {
      name: 'agework-selection',
      partialize: (state) => ({
        selectedWorkspaceId: state.selectedWorkspaceId,
        selectedModelProviderIds: state.selectedModelProviderIds,
        selectedModelByProviderIds: state.selectedModelByProviderIds,
        modelReasoningEffort: state.modelReasoningEffort,
        claudeThinkingMode: state.claudeThinkingMode,
        claudePermissionMode: state.claudePermissionMode,
        codexPermissionMode: state.codexPermissionMode,
      }),
      onRehydrateStorage: () => () => {
        // hydrate 完成后清理旧键
        cleanupOldKeys();
      },
    },
  ),
);
