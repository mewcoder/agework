import { describe, it, expect, beforeEach } from 'vitest';
import { useRuntimeUiStore } from './runtime-ui-store';

beforeEach(() => {
  useRuntimeUiStore.setState({
    isAssistantInGap: false,
    cancelledConversations: new Set(),
    userSteeredMessageIdsByConversation: {},
    pendingRunInterruptReasonsByConversation: {},
    completedRunConversationIds: new Set(),
    failedRunConversationIds: new Set(),
  });
});

describe('useRuntimeUiStore', () => {
  it('初始状态为空集合', () => {
    expect(useRuntimeUiStore.getState().isAssistantInGap).toBe(false);
    expect(useRuntimeUiStore.getState().cancelledConversations.size).toBe(0);
    expect(Object.keys(useRuntimeUiStore.getState().userSteeredMessageIdsByConversation)).toHaveLength(0);
    expect(useRuntimeUiStore.getState().completedRunConversationIds.size).toBe(0);
    expect(useRuntimeUiStore.getState().failedRunConversationIds.size).toBe(0);
  });

  it('setIsAssistantInGap 切换状态', () => {
    useRuntimeUiStore.getState().setIsAssistantInGap(true);
    expect(useRuntimeUiStore.getState().isAssistantInGap).toBe(true);

    useRuntimeUiStore.getState().setIsAssistantInGap(false);
    expect(useRuntimeUiStore.getState().isAssistantInGap).toBe(false);
  });

  describe('cancelledConversations', () => {
    it('markConversationCancelled 添加已取消的会话', () => {
      useRuntimeUiStore.getState().markConversationCancelled('conv-1');
      expect(useRuntimeUiStore.getState().cancelledConversations.has('conv-1')).toBe(true);
    });

    it('重复 mark 同一个会话不改变状态引用', () => {
      useRuntimeUiStore.getState().markConversationCancelled('conv-1');
      const set1 = useRuntimeUiStore.getState().cancelledConversations;
      useRuntimeUiStore.getState().markConversationCancelled('conv-1');
      const set2 = useRuntimeUiStore.getState().cancelledConversations;

      expect(set2).toBe(set1);
    });

    it('clearConversationCancelled 移除已取消的会话', () => {
      useRuntimeUiStore.getState().markConversationCancelled('conv-1');
      useRuntimeUiStore.getState().clearConversationCancelled('conv-1');
      expect(useRuntimeUiStore.getState().cancelledConversations.has('conv-1')).toBe(false);
    });

    it('clear 不存在的会话不改变状态引用', () => {
      useRuntimeUiStore.getState().markConversationCancelled('conv-1');
      const set1 = useRuntimeUiStore.getState().cancelledConversations;
      useRuntimeUiStore.getState().clearConversationCancelled('conv-nonexistent');
      const set2 = useRuntimeUiStore.getState().cancelledConversations;

      expect(set2).toBe(set1);
      expect(useRuntimeUiStore.getState().cancelledConversations.has('conv-1')).toBe(true);
    });
  });

  describe('userSteeredMessageIdsByConversation', () => {
    it('markConversationUserSteered 标记被用户引导的消息并设置下一次 run 的中断原因', () => {
      useRuntimeUiStore.getState().markConversationUserSteered('conv-1', 'msg-1');
      expect(useRuntimeUiStore.getState().userSteeredMessageIdsByConversation['conv-1']?.has('msg-1')).toBe(true);
      expect(useRuntimeUiStore.getState().consumePendingRunInterruptReason('conv-1')).toBe('user_steered');
      expect(useRuntimeUiStore.getState().consumePendingRunInterruptReason('conv-1')).toBeUndefined();
    });

    it('clearConversationUserSteered 移除用户引导标记', () => {
      useRuntimeUiStore.getState().markConversationUserSteered('conv-1', 'msg-1');
      useRuntimeUiStore.getState().clearConversationUserSteered('conv-1');
      expect(useRuntimeUiStore.getState().userSteeredMessageIdsByConversation['conv-1']).toBeUndefined();
      expect(useRuntimeUiStore.getState().consumePendingRunInterruptReason('conv-1')).toBeUndefined();
    });
  });

  describe('completedRunConversationIds', () => {
    it('markConversationRunComplete 标记完成', () => {
      useRuntimeUiStore.getState().markConversationRunComplete('conv-1');
      expect(useRuntimeUiStore.getState().completedRunConversationIds.has('conv-1')).toBe(true);
    });

    it('已完成的会话重复标记不改变状态引用', () => {
      useRuntimeUiStore.getState().markConversationRunComplete('conv-1');
      const set1 = useRuntimeUiStore.getState().completedRunConversationIds;
      useRuntimeUiStore.getState().markConversationRunComplete('conv-1');
      const set2 = useRuntimeUiStore.getState().completedRunConversationIds;

      expect(set2).toBe(set1);
    });
  });

  describe('failedRunConversationIds', () => {
    it('markConversationRunFailed 标记失败', () => {
      useRuntimeUiStore.getState().markConversationRunFailed('conv-1');
      expect(useRuntimeUiStore.getState().failedRunConversationIds.has('conv-1')).toBe(true);
    });

    it('已失败的会话重复标记不改变状态引用', () => {
      useRuntimeUiStore.getState().markConversationRunFailed('conv-1');
      const set1 = useRuntimeUiStore.getState().failedRunConversationIds;
      useRuntimeUiStore.getState().markConversationRunFailed('conv-1');
      const set2 = useRuntimeUiStore.getState().failedRunConversationIds;

      expect(set2).toBe(set1);
    });
  });

  describe('completed / failed 互斥', () => {
    it('标记完成后标记失败，completed 清除 failed 添加', () => {
      useRuntimeUiStore.getState().markConversationRunComplete('conv-1');
      useRuntimeUiStore.getState().markConversationRunFailed('conv-1');

      expect(useRuntimeUiStore.getState().completedRunConversationIds.has('conv-1')).toBe(false);
      expect(useRuntimeUiStore.getState().failedRunConversationIds.has('conv-1')).toBe(true);
    });

    it('标记失败后标记完成，failed 清除 completed 添加', () => {
      useRuntimeUiStore.getState().markConversationRunFailed('conv-1');
      useRuntimeUiStore.getState().markConversationRunComplete('conv-1');

      expect(useRuntimeUiStore.getState().failedRunConversationIds.has('conv-1')).toBe(false);
      expect(useRuntimeUiStore.getState().completedRunConversationIds.has('conv-1')).toBe(true);
    });
  });

  describe('clearConversationRunFinished', () => {
    it('清除完成状态的会话', () => {
      useRuntimeUiStore.getState().markConversationRunComplete('conv-1');
      useRuntimeUiStore.getState().clearConversationRunFinished('conv-1');

      expect(useRuntimeUiStore.getState().completedRunConversationIds.has('conv-1')).toBe(false);
    });

    it('清除失败状态的会话', () => {
      useRuntimeUiStore.getState().markConversationRunFailed('conv-1');
      useRuntimeUiStore.getState().clearConversationRunFinished('conv-1');

      expect(useRuntimeUiStore.getState().failedRunConversationIds.has('conv-1')).toBe(false);
    });

    it('已清除的会话再清理不改变状态引用', () => {
      useRuntimeUiStore.getState().markConversationRunComplete('conv-1');
      useRuntimeUiStore.getState().clearConversationRunFinished('conv-1');
      const completed1 = useRuntimeUiStore.getState().completedRunConversationIds;
      useRuntimeUiStore.getState().clearConversationRunFinished('conv-1');
      const completed2 = useRuntimeUiStore.getState().completedRunConversationIds;

      expect(completed2).toBe(completed1);
    });
  });

  describe('clearRunStatusForConversation', () => {
    it('无条件清除 completed 和 failed', () => {
      useRuntimeUiStore.getState().markConversationRunComplete('conv-1');
      useRuntimeUiStore.getState().markConversationRunFailed('conv-2');
      useRuntimeUiStore.getState().clearRunStatusForConversation('conv-1');

      expect(useRuntimeUiStore.getState().completedRunConversationIds.has('conv-1')).toBe(false);
      expect(useRuntimeUiStore.getState().completedRunConversationIds.has('conv-2')).toBe(false);
      expect(useRuntimeUiStore.getState().failedRunConversationIds.has('conv-1')).toBe(false);
      expect(useRuntimeUiStore.getState().failedRunConversationIds.has('conv-2')).toBe(true);
    });
  });
});
