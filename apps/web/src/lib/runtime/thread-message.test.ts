import { describe, it, expect } from 'vitest';
import { toThreadMessageItem, isThreadMessageItem } from './thread-message';
import type { StoredMessage } from '@/api/conversations';

describe('toThreadMessageItem', () => {
  it('将 user 消息转换为 ThreadMessageItem', () => {
    const msg: StoredMessage = {
      id: 'm1',
      parent_id: null,
      format: 'assistant-ui',
      content: {
        id: 'm1',
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
        createdAt: '2024-01-01T00:00:00Z',
      },
    };

    const result = toThreadMessageItem(msg);

    expect(result).not.toBeNull();
    expect(result!.parentId).toBeNull();
    expect(result!.message.role).toBe('user');
    expect(result!.message.content).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('将 assistant 消息转换为 ThreadMessageItem 并附加 metadata', () => {
    const msg: StoredMessage = {
      id: 'm2',
      parent_id: 'm1',
      format: 'assistant-ui',
      content: {
        id: 'm2',
        role: 'assistant',
        content: 'hi there',
        createdAt: '2024-01-01T00:00:01Z',
      },
    };

    const result = toThreadMessageItem(msg);

    expect(result).not.toBeNull();
    expect(result!.parentId).toBe('m1');
    expect(result!.message.role).toBe('assistant');
    expect(result!.message.status).toEqual({ type: 'complete', reason: 'unknown' });
    expect(result!.message.metadata).toHaveProperty('steps');
  });

  it('assistant 消息已有 status 时不覆盖', () => {
    const msg: StoredMessage = {
      id: 'm3',
      parent_id: null,
      format: 'assistant-ui',
      content: {
        id: 'm3',
        role: 'assistant',
        content: 'hi',
        status: { type: 'running' },
      },
    };

    const result = toThreadMessageItem(msg);

    expect(result).not.toBeNull();
    expect(result!.message.status).toEqual({ type: 'running' });
  });

  it('tool 角色的消息返回 null', () => {
    const msg: StoredMessage = {
      id: 'm4',
      parent_id: 'm2',
      format: 'assistant-ui',
      content: {
        id: 'm4',
        role: 'tool',
        content: 'result',
      },
    };

    const result = toThreadMessageItem(msg);

    expect(result).toBeNull();
  });

  it('content 不是对象时返回 null', () => {
    const msg: StoredMessage = {
      id: 'm5',
      parent_id: null,
      format: 'assistant-ui',
      content: 'plain string' as unknown as Record<string, unknown>,
    };

    const result = toThreadMessageItem(msg);

    expect(result).toBeNull();
  });

  it('字符串 content 转换为 text 结构', () => {
    const msg: StoredMessage = {
      id: 'm6',
      parent_id: null,
      format: 'assistant-ui',
      content: {
        id: 'm6',
        role: 'user',
        content: 'plain text message',
      },
    };

    const result = toThreadMessageItem(msg);

    expect(result).not.toBeNull();
    expect(result!.message.content).toEqual([{ type: 'text', text: 'plain text message' }]);
  });

  it('空 content 转换为空数组', () => {
    const msg: StoredMessage = {
      id: 'm7',
      parent_id: null,
      format: 'assistant-ui',
      content: {
        id: 'm7',
        role: 'user',
        content: null,
      },
    };

    const result = toThreadMessageItem(msg);

    expect(result).not.toBeNull();
    expect(result!.message.content).toEqual([]);
  });

  it('无效日期字符串返回 undefined createdAt', () => {
    const msg: StoredMessage = {
      id: 'm8',
      parent_id: null,
      format: 'assistant-ui',
      content: {
        id: 'm8',
        role: 'user',
        content: 'text',
        createdAt: 'not-a-date',
      },
    };

    const result = toThreadMessageItem(msg);

    expect(result).not.toBeNull();
    expect(result!.message.createdAt).toBeUndefined();
  });
});

describe('isThreadMessageItem', () => {
  it('non-null 对象返回 true', () => {
    const item = {
      parentId: null,
      message: { id: 'm1', role: 'user', content: [] },
    } as const;

    expect(isThreadMessageItem(item as unknown as ReturnType<typeof toThreadMessageItem>)).toBe(true);
  });

  it('null 返回 false', () => {
    expect(isThreadMessageItem(null)).toBe(false);
  });
});
