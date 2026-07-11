import { describe, it, expect, beforeEach } from 'vitest';
import { useRunSessionStore } from './run-session-store';

type Row = { conversationId: string; runStatus: string };

const sync = (rows: Row[], selectedId?: string) =>
  useRunSessionStore.getState().syncPolledStatuses(rows, selectedId);
const completions = () => useRunSessionStore.getState().unacknowledgedCompletions;

beforeEach(() => {
  useRunSessionStore.setState({
    previousRunningIds: new Set(),
    unacknowledgedCompletions: new Set(),
    cancelledConversations: new Set(),
    userSteeredMessageIdsByConversation: {},
    pendingRunInterruptReasonsByConversation: {},
    queuedUserInputsByConversation: {},
    pendingQuestionRepliedConversations: new Set(),
  });
});

describe('useRunSessionStore.syncPolledStatuses', () => {
  it('后台对话 running→idle 记为未确认完成', () => {
    sync([{ conversationId: 'a', runStatus: 'running' }], 'other');
    sync([{ conversationId: 'a', runStatus: 'idle' }], 'other');
    expect(completions().has('a')).toBe(true);
  });

  it('首次就看到 idle（此前未在跑）不提示', () => {
    sync([{ conversationId: 'a', runStatus: 'idle' }], 'other');
    expect(completions().has('a')).toBe(false);
  });

  it('当前选中的对话完成不提示', () => {
    sync([{ conversationId: 'a', runStatus: 'running' }], 'a');
    sync([{ conversationId: 'a', runStatus: 'idle' }], 'a');
    expect(completions().has('a')).toBe(false);
  });

  it('running→error 不记（错误由 runStatus 派生，不进 badge）', () => {
    sync([{ conversationId: 'a', runStatus: 'running' }], 'other');
    sync([{ conversationId: 'a', runStatus: 'error' }], 'other');
    expect(completions().has('a')).toBe(false);
  });

  it('重新进入 running 清掉旧的完成提示', () => {
    sync([{ conversationId: 'a', runStatus: 'running' }], 'other');
    sync([{ conversationId: 'a', runStatus: 'idle' }], 'other');
    expect(completions().has('a')).toBe(true);
    sync([{ conversationId: 'a', runStatus: 'running' }], 'other');
    expect(completions().has('a')).toBe(false);
  });

  it('状态无变化时不产生新的集合引用', () => {
    sync([{ conversationId: 'a', runStatus: 'idle' }], 'other');
    const set1 = completions();
    sync([{ conversationId: 'a', runStatus: 'idle' }], 'other');
    expect(completions()).toBe(set1);
  });
});

describe('useRunSessionStore.acknowledgeCompletion', () => {
  it('确认后清除该对话的完成提示', () => {
    sync([{ conversationId: 'a', runStatus: 'running' }], 'other');
    sync([{ conversationId: 'a', runStatus: 'idle' }], 'other');
    useRunSessionStore.getState().acknowledgeCompletion('a');
    expect(completions().has('a')).toBe(false);
  });

  it('确认不存在的完成不改变集合引用', () => {
    const set1 = completions();
    useRunSessionStore.getState().acknowledgeCompletion('nope');
    expect(completions()).toBe(set1);
  });
});

describe('useRunSessionStore 取消', () => {
  const cancelled = () => useRunSessionStore.getState().cancelledConversations;

  it('markConversationCancelled 添加已取消的会话', () => {
    useRunSessionStore.getState().markConversationCancelled('conv-1');
    expect(cancelled().has('conv-1')).toBe(true);
  });

  it('重复 mark 不改变集合引用', () => {
    useRunSessionStore.getState().markConversationCancelled('conv-1');
    const set1 = cancelled();
    useRunSessionStore.getState().markConversationCancelled('conv-1');
    expect(cancelled()).toBe(set1);
  });

  it('clearConversationCancelled 移除', () => {
    useRunSessionStore.getState().markConversationCancelled('conv-1');
    useRunSessionStore.getState().clearConversationCancelled('conv-1');
    expect(cancelled().has('conv-1')).toBe(false);
  });

  it('clear 不存在的会话不改变集合引用', () => {
    useRunSessionStore.getState().markConversationCancelled('conv-1');
    const set1 = cancelled();
    useRunSessionStore.getState().clearConversationCancelled('nope');
    expect(cancelled()).toBe(set1);
  });
});

describe('useRunSessionStore 用户引导（steer）', () => {
  it('mark 标记 messageId 并设置下一次 run 的中断原因', () => {
    useRunSessionStore.getState().markConversationUserSteered('conv-1', 'msg-1');
    expect(
      useRunSessionStore.getState().userSteeredMessageIdsByConversation['conv-1']?.has('msg-1'),
    ).toBe(true);
    expect(useRunSessionStore.getState().consumePendingRunInterruptReason('conv-1')).toBe('user_steered');
    expect(useRunSessionStore.getState().consumePendingRunInterruptReason('conv-1')).toBeUndefined();
  });

  it('clearConversationUserSteered 同时清掉 messageId 和中断原因', () => {
    useRunSessionStore.getState().markConversationUserSteered('conv-1', 'msg-1');
    useRunSessionStore.getState().clearConversationUserSteered('conv-1');
    expect(useRunSessionStore.getState().userSteeredMessageIdsByConversation['conv-1']).toBeUndefined();
    expect(useRunSessionStore.getState().consumePendingRunInterruptReason('conv-1')).toBeUndefined();
  });
});

describe('useRunSessionStore 排队输入', () => {
  const queue = (id: string) => useRunSessionStore.getState().queuedUserInputsByConversation[id] ?? [];

  it('enqueue 追加、空白忽略', () => {
    useRunSessionStore.getState().enqueueUserInput('c', 'hello');
    useRunSessionStore.getState().enqueueUserInput('c', '   ');
    expect(queue('c').map((q) => q.text)).toEqual(['hello']);
  });

  it('prioritize 把目标移到队首', () => {
    useRunSessionStore.getState().enqueueUserInput('c', 'a');
    useRunSessionStore.getState().enqueueUserInput('c', 'b');
    const second = queue('c')[1];
    useRunSessionStore.getState().prioritizeUserInput('c', second.id);
    expect(queue('c').map((q) => q.text)).toEqual(['b', 'a']);
  });

  it('shift 取出队首并移除', () => {
    useRunSessionStore.getState().enqueueUserInput('c', 'a');
    useRunSessionStore.getState().enqueueUserInput('c', 'b');
    const shifted = useRunSessionStore.getState().shiftUserInput('c');
    expect(shifted?.text).toBe('a');
    expect(queue('c').map((q) => q.text)).toEqual(['b']);
  });

  it('remove 删除指定项', () => {
    useRunSessionStore.getState().enqueueUserInput('c', 'a');
    const only = queue('c')[0];
    useRunSessionStore.getState().removeUserInput('c', only.id);
    expect(queue('c')).toHaveLength(0);
  });
});

describe('useRunSessionStore pending question 回答标记', () => {
  it('mark 后 consume 返回 true 并清除', () => {
    useRunSessionStore.getState().markPendingQuestionReplied('conv-1');
    expect(useRunSessionStore.getState().consumePendingQuestionReplied('conv-1')).toBe(true);
    expect(useRunSessionStore.getState().consumePendingQuestionReplied('conv-1')).toBe(false);
  });
});
