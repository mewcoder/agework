import { describe, it, expect, beforeEach } from 'vitest';
import { useSelectionStore, loadSelectedWorkspaceId } from './selection-store';

beforeEach(() => {
  localStorage.clear();
  useSelectionStore.setState({
    selectedConversationId: undefined,
    selectedWorkspaceId: undefined,
    selectedAgentType: 'claude',
    selectedModelProviderIds: {},
    selectedModelByProviderIds: {},
    modelReasoningEffort: 'medium',
    claudeThinkingMode: 'adaptive',
    claudePermissionMode: 'acceptEdits',
    codexPermissionMode: 'auto-review',
    newConversationFocusToken: 0,
  });
});

describe('useSelectionStore', () => {
  describe('初始状态', () => {
    it('默认选中 claude agent', () => {
      expect(useSelectionStore.getState().selectedAgentType).toBe('claude');
    });

    it('默认 reasoning effort 为 medium', () => {
      expect(useSelectionStore.getState().modelReasoningEffort).toBe('medium');
    });

    it('默认 claude thinking mode 为 adaptive', () => {
      expect(useSelectionStore.getState().claudeThinkingMode).toBe('adaptive');
    });

    it('默认没有选中会话', () => {
      expect(useSelectionStore.getState().selectedConversationId).toBeUndefined();
    });
  });

  describe('startNewConversation', () => {
    it('清除 selectedConversationId 并递增 newConversationFocusToken', () => {
      useSelectionStore.getState().startNewConversation('ws-1');

      expect(useSelectionStore.getState().selectedConversationId).toBeUndefined();
      expect(useSelectionStore.getState().selectedWorkspaceId).toBe('ws-1');
      expect(useSelectionStore.getState().newConversationFocusToken).toBe(1);
    });

    it('多次调用持续递增 focus token', () => {
      useSelectionStore.getState().startNewConversation('ws-1');
      useSelectionStore.getState().startNewConversation('ws-2');

      expect(useSelectionStore.getState().newConversationFocusToken).toBe(2);
    });

    it('可指定 agent 类型', () => {
      useSelectionStore.getState().startNewConversation('ws-1', 'codex');

      expect(useSelectionStore.getState().selectedAgentType).toBe('codex');
    });

    it('不指定 agent 保持当前类型', () => {
      useSelectionStore.getState().selectAgentType('codex');
      useSelectionStore.getState().startNewConversation('ws-1');

      expect(useSelectionStore.getState().selectedAgentType).toBe('codex');
    });
  });

  describe('selectConversation', () => {
    it('设置 selectedConversationId', () => {
      useSelectionStore.getState().selectConversation('conv-1');

      expect(useSelectionStore.getState().selectedConversationId).toBe('conv-1');
    });

    it('同时设置 agentType 和 workspaceId', () => {
      useSelectionStore.getState().selectConversation('conv-1', 'codex', 'ws-1');

      expect(useSelectionStore.getState().selectedConversationId).toBe('conv-1');
      expect(useSelectionStore.getState().selectedAgentType).toBe('codex');
      expect(useSelectionStore.getState().selectedWorkspaceId).toBe('ws-1');
    });
  });

  describe('selectWorkspace', () => {
    it('设置 workspaceId 并清除 conversationId', () => {
      useSelectionStore.getState().selectConversation('conv-1');
      useSelectionStore.getState().selectWorkspace('ws-1');

      expect(useSelectionStore.getState().selectedWorkspaceId).toBe('ws-1');
      expect(useSelectionStore.getState().selectedConversationId).toBeUndefined();
    });
  });

  describe('clearSelectedWorkspace', () => {
    it('清除 workspaceId', () => {
      useSelectionStore.getState().selectWorkspace('ws-1');
      useSelectionStore.getState().clearSelectedWorkspace();

      expect(useSelectionStore.getState().selectedWorkspaceId).toBeUndefined();
    });
  });

  describe('selectAgentType', () => {
    it('切换 agent 类型', () => {
      useSelectionStore.getState().selectAgentType('codex');
      expect(useSelectionStore.getState().selectedAgentType).toBe('codex');

      useSelectionStore.getState().selectAgentType('claude');
      expect(useSelectionStore.getState().selectedAgentType).toBe('claude');
    });
  });

  describe('selectModelProvider', () => {
    it('为 agent 设置 model provider', () => {
      useSelectionStore.getState().selectModelProvider('claude', 'mp-1');

      expect(useSelectionStore.getState().selectedModelProviderIds.claude).toBe('mp-1');
    });

    it('空字符串视为清除', () => {
      useSelectionStore.getState().selectModelProvider('claude', 'mp-1');
      useSelectionStore.getState().selectModelProvider('claude', '');

      expect(useSelectionStore.getState().selectedModelProviderIds.claude).toBeUndefined();
    });
  });

  describe('selectModelForProvider', () => {
    it('为模型配置设置具体模型', () => {
      useSelectionStore.getState().selectModelForProvider('mp-1', 'gpt-5');

      expect(useSelectionStore.getState().selectedModelByProviderIds['mp-1']).toBe('gpt-5');
    });

    it('空字符串视为清除模型选择', () => {
      useSelectionStore.getState().selectModelForProvider('mp-1', 'gpt-5');
      useSelectionStore.getState().selectModelForProvider('mp-1', '');

      expect(useSelectionStore.getState().selectedModelByProviderIds['mp-1']).toBeUndefined();
    });
  });

  describe('setModelReasoningEffort', () => {
    it('设置 reasoning effort', () => {
      useSelectionStore.getState().setModelReasoningEffort('high');
      expect(useSelectionStore.getState().modelReasoningEffort).toBe('high');
    });
  });

  describe('setClaudeThinkingMode', () => {
    it('设置 claude thinking mode', () => {
      useSelectionStore.getState().setClaudeThinkingMode('disabled');
      expect(useSelectionStore.getState().claudeThinkingMode).toBe('disabled');
    });
  });

  describe('setClaudePermissionMode', () => {
    it('设置 claude permission mode', () => {
      useSelectionStore.getState().setClaudePermissionMode('bypassPermissions');
      expect(useSelectionStore.getState().claudePermissionMode).toBe('bypassPermissions');
    });
  });

  describe('setCodexPermissionMode', () => {
    it('设置 codex permission mode', () => {
      useSelectionStore.getState().setCodexPermissionMode('full-access');
      expect(useSelectionStore.getState().codexPermissionMode).toBe('full-access');
    });
  });

  describe('persist', () => {
    it('持久化 workspaceId', () => {
      useSelectionStore.getState().selectWorkspace('ws-persist');

      const stored = JSON.parse(localStorage.getItem('agework-selection')!);
      expect(stored.state.selectedWorkspaceId).toBe('ws-persist');
    });

    it('持久化 model reasoning effort', () => {
      useSelectionStore.getState().setModelReasoningEffort('xhigh');

      const stored = JSON.parse(localStorage.getItem('agework-selection')!);
      expect(stored.state.modelReasoningEffort).toBe('xhigh');
    });

    it('持久化 provider 下的模型选择', () => {
      useSelectionStore.getState().selectModelForProvider('mp-1', 'gpt-5');

      const stored = JSON.parse(localStorage.getItem('agework-selection')!);
      expect(stored.state.selectedModelByProviderIds['mp-1']).toBe('gpt-5');
    });

    it('不持久化 selectedConversationId', () => {
      useSelectionStore.getState().selectConversation('conv-1');

      const stored = JSON.parse(localStorage.getItem('agework-selection')!);
      expect(stored.state.selectedConversationId).toBeUndefined();
    });

    it('不持久化 selectedAgentType', () => {
      useSelectionStore.getState().selectAgentType('codex');

      const stored = JSON.parse(localStorage.getItem('agework-selection')!);
      expect(stored.state.selectedAgentType).toBeUndefined();
    });
  });
});

describe('loadSelectedWorkspaceId', () => {
  it('优先从 agework-selection 读取', () => {
    localStorage.setItem('agework-selection', JSON.stringify({ state: { selectedWorkspaceId: 'ws-new' } }));

    expect(loadSelectedWorkspaceId()).toBe('ws-new');
  });

  it('回退到旧 selected-workspace-id 键', () => {
    localStorage.setItem('selected-workspace-id', 'ws-old');

    expect(loadSelectedWorkspaceId()).toBe('ws-old');
  });

  it('agework-selection 优先级高于旧键', () => {
    localStorage.setItem('agework-selection', JSON.stringify({ state: { selectedWorkspaceId: 'ws-new' } }));
    localStorage.setItem('selected-workspace-id', 'ws-old');

    expect(loadSelectedWorkspaceId()).toBe('ws-new');
  });

  it('两者都不存在返回 undefined', () => {
    expect(loadSelectedWorkspaceId()).toBeUndefined();
  });

  it('agework-selection 格式损坏时返回 undefined', () => {
    localStorage.setItem('agework-selection', 'not-json');
    localStorage.setItem('selected-workspace-id', 'ws-old');

    expect(loadSelectedWorkspaceId()).toBeUndefined();
  });

  it('agework-selection 中 workspaceId 为空字符串时回退', () => {
    localStorage.setItem('agework-selection', JSON.stringify({ state: { selectedWorkspaceId: '' } }));
    localStorage.setItem('selected-workspace-id', 'ws-old');

    expect(loadSelectedWorkspaceId()).toBe('ws-old');
  });
});
