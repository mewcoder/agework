import { describe, it, expect, beforeEach } from 'vitest';
import { useRuntimeUiStore } from './runtime-ui-store';

beforeEach(() => {
  useRuntimeUiStore.setState({
    isAssistantInGap: false,
    cancelledConversations: new Set(),
    userSteeredMessageIdsByConversation: {},
    pendingRunInterruptReasonsByConversation: {},
    runResultByConversation: {},
  });
});

describe('useRuntimeUiStore', () => {
  it('初始状态为空集合', () => {
    expect(useRuntimeUiStore.getState().isAssistantInGap).toBe(false);
    expect(useRuntimeUiStore.getState().cancelledConversations.size).toBe(0);
    expect(Object.keys(useRuntimeUiStore.getState().userSteeredMessageIdsByConversation)).toHaveLength(0);
    expect(Object.keys(useRuntimeUiStore.getState().runResultByConversation)).toHaveLength(0);
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

  describe('runResultByConversation - complete', () => {
    it('markConversationRunComplete 标记完成', () => {
      useRuntimeUiStore.getState().markConversationRunComplete('conv-1');
      expect(useRuntimeUiStore.getState().runResultByConversation['conv-1']).toBe('complete');
    });

    it('已完成的会话重复标记不改变状态引用', () => {
      useRuntimeUiStore.getState().markConversationRunComplete('conv-1');
      const map1 = useRuntimeUiStore.getState().runResultByConversation;
      useRuntimeUiStore.getState().markConversationRunComplete('conv-1');
      const map2 = useRuntimeUiStore.getState().runResultByConversation;

      expect(map2).toBe(map1);
    });
  });

  describe('runResultByConversation - failed', () => {
    it('markConversationRunFailed 标记失败', () => {
      useRuntimeUiStore.getState().markConversationRunFailed('conv-1');
      expect(useRuntimeUiStore.getState().runResultByConversation['conv-1']).toBe('failed');
    });

    it('已失败的会话重复标记不改变状态引用', () => {
      useRuntimeUiStore.getState().markConversationRunFailed('conv-1');
      const map1 = useRuntimeUiStore.getState().runResultByConversation;
      useRuntimeUiStore.getState().markConversationRunFailed('conv-1');
      const map2 = useRuntimeUiStore.getState().runResultByConversation;

      expect(map2).toBe(map1);
    });
  });

  describe('completed / failed 互斥', () => {
    it('标记完成后标记失败，结果覆盖为 failed', () => {
      useRuntimeUiStore.getState().markConversationRunComplete('conv-1');
      useRuntimeUiStore.getState().markConversationRunFailed('conv-1');

      expect(useRuntimeUiStore.getState().runResultByConversation['conv-1']).toBe('failed');
    });

    it('标记失败后标记完成，结果覆盖为 complete', () => {
      useRuntimeUiStore.getState().markConversationRunFailed('conv-1');
      useRuntimeUiStore.getState().markConversationRunComplete('conv-1');

      expect(useRuntimeUiStore.getState().runResultByConversation['conv-1']).toBe('complete');
    });
  });

  describe('clearConversationRunFinished', () => {
    it('清除完成状态的会话', () => {
      useRuntimeUiStore.getState().markConversationRunComplete('conv-1');
      useRuntimeUiStore.getState().clearConversationRunFinished('conv-1');

      expect(useRuntimeUiStore.getState().runResultByConversation['conv-1']).toBeUndefined();
    });

    it('清除失败状态的会话', () => {
      useRuntimeUiStore.getState().markConversationRunFailed('conv-1');
      useRuntimeUiStore.getState().clearConversationRunFinished('conv-1');

      expect(useRuntimeUiStore.getState().runResultByConversation['conv-1']).toBeUndefined();
    });

    it('已清除的会话再清理不改变状态引用', () => {
      useRuntimeUiStore.getState().markConversationRunComplete('conv-1');
      useRuntimeUiStore.getState().clearConversationRunFinished('conv-1');
      const map1 = useRuntimeUiStore.getState().runResultByConversation;
      useRuntimeUiStore.getState().clearConversationRunFinished('conv-1');
      const map2 = useRuntimeUiStore.getState().runResultByConversation;

      expect(map2).toBe(map1);
    });
  });

  describe('clearRunStatusForConversation', () => {
    it('无条件清除指定会话的运行结果，不影响其他会话', () => {
      useRuntimeUiStore.getState().markConversationRunComplete('conv-1');
      useRuntimeUiStore.getState().markConversationRunFailed('conv-2');
      useRuntimeUiStore.getState().clearRunStatusForConversation('conv-1');

      expect(useRuntimeUiStore.getState().runResultByConversation['conv-1']).toBeUndefined();
      expect(useRuntimeUiStore.getState().runResultByConversation['conv-2']).toBe('failed');
    });
  });
});
