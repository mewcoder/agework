import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockApiGet = vi.fn();
const mockApiPost = vi.fn();

vi.mock('@/lib/http', () => ({
  apiGet: (...args: unknown[]) => mockApiGet(...args),
  apiPost: (...args: unknown[]) => mockApiPost(...args),
}));

import { conversationsApi } from './conversations';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('conversationsApi', () => {
  describe('list', () => {
    it('无参数时调用基础 URL', async () => {
      mockApiGet.mockResolvedValue({ list: [] });
      await conversationsApi.list();

      expect(mockApiGet).toHaveBeenCalledWith('/api/v1/conversations/list');
    });

    it('传递 after 参数', async () => {
      mockApiGet.mockResolvedValue({ list: [] });
      await conversationsApi.list('cursor-123');

      expect(mockApiGet).toHaveBeenCalledWith('/api/v1/conversations/list?after=cursor-123');
    });

    it('传递 status 参数', async () => {
      mockApiGet.mockResolvedValue({ list: [] });
      await conversationsApi.list(undefined, 'archived');

      expect(mockApiGet).toHaveBeenCalledWith('/api/v1/conversations/list?status=archived');
    });

    it('传递 sort 参数', async () => {
      mockApiGet.mockResolvedValue({ list: [] });
      await conversationsApi.list(undefined, undefined, 'createdAt');

      expect(mockApiGet).toHaveBeenCalledWith('/api/v1/conversations/list?sort=createdAt');
    });

    it('组合多个参数', async () => {
      mockApiGet.mockResolvedValue({ list: [] });
      await conversationsApi.list('cursor-1', 'archived', 'updatedAt');

      expect(mockApiGet).toHaveBeenCalledWith('/api/v1/conversations/list?after=cursor-1&status=archived&sort=updatedAt');
    });

    it('提取 list 字段返回', async () => {
      const conversations = [{ conversationId: 'c1', workspaceId: 'w1' } as const];
      mockApiGet.mockResolvedValue({ list: conversations });

      const result = await conversationsApi.list();
      expect(result).toEqual({ conversations });
    });
  });

  describe('create', () => {
    it('调用正确的 URL 和 body', async () => {
      mockApiPost.mockResolvedValue({ conversationId: 'new-conv' });
      const body = { workspaceId: 'ws-1', agentType: 'claude' as const };

      await conversationsApi.create(body);

      expect(mockApiPost).toHaveBeenCalledWith('/api/v1/agent/create-conversation', body);
    });
  });

  describe('get', () => {
    it('用 query 参数获取单个会话', async () => {
      mockApiGet.mockResolvedValue({ conversationId: 'conv-1' });
      await conversationsApi.get('conv-1');

      expect(mockApiGet).toHaveBeenCalledWith('/api/v1/conversations/query?id=conv-1');
    });
  });

  describe('statuses', () => {
    it('批量查询会话运行状态', async () => {
      mockApiPost.mockResolvedValue({ list: [] });
      await conversationsApi.statuses(['conv-1', 'conv-2']);

      expect(mockApiPost).toHaveBeenCalledWith('/api/v1/conversations/statuses/query', {
        ids: ['conv-1', 'conv-2'],
      });
    });
  });

  describe('rename', () => {
    it('发送 update 请求', async () => {
      await conversationsApi.rename('conv-1', '新标题');

      expect(mockApiPost).toHaveBeenCalledWith('/api/v1/conversations/update', { id: 'conv-1', title: '新标题' });
    });
  });

  describe('archive', () => {
    it('发送 archive 请求', async () => {
      await conversationsApi.archive('conv-1');

      expect(mockApiPost).toHaveBeenCalledWith('/api/v1/conversations/archive', { id: 'conv-1' });
    });
  });

  describe('unarchive', () => {
    it('发送 unarchive 请求', async () => {
      await conversationsApi.unarchive('conv-1');

      expect(mockApiPost).toHaveBeenCalledWith('/api/v1/conversations/unarchive', { id: 'conv-1' });
    });
  });

  describe('delete', () => {
    it('发送 remove 请求', async () => {
      await conversationsApi.delete('conv-1');

      expect(mockApiPost).toHaveBeenCalledWith('/api/v1/conversations/remove', { id: 'conv-1' });
    });
  });

  describe('clearArchived', () => {
    it('发送 clear-archived 请求', async () => {
      await conversationsApi.clearArchived();

      expect(mockApiPost).toHaveBeenCalledWith('/api/v1/conversations/clear-archived');
    });
  });

  describe('stopRun', () => {
    it('发送 stop 请求', async () => {
      await conversationsApi.stopRun('conv-1');

      expect(mockApiPost).toHaveBeenCalledWith(
        '/api/v1/agent/stop',
        { id: 'conv-1' },
      );
    });
  });


  describe('listMessages', () => {
    it('用 query 参数获取消息列表', async () => {
      mockApiGet.mockResolvedValue({ list: [{ id: 'm1' }] });
      const result = await conversationsApi.listMessages('conv-1');

      expect(mockApiGet).toHaveBeenCalledWith('/api/v1/conversations/messages/list?id=conv-1');
      expect(result).toEqual([{ id: 'm1' }]);
    });
  });

  describe('search', () => {
    it('用 q 参数搜索会话', async () => {
      mockApiGet.mockResolvedValue({ list: [] });
      await conversationsApi.search('keyword');

      expect(mockApiGet).toHaveBeenCalledWith('/api/v1/conversations/search?q=keyword&limit=20');
    });

    it('支持自定义 limit', async () => {
      mockApiGet.mockResolvedValue({ list: [] });
      await conversationsApi.search('kw', 5);

      expect(mockApiGet).toHaveBeenCalledWith('/api/v1/conversations/search?q=kw&limit=5');
    });

    it('提取 list 字段并以 hits 返回', async () => {
      const hits = [{ conversation: { conversationId: 'c1' }, matchedField: 'title', matchedSnippet: 'foo' } as const];
      mockApiGet.mockResolvedValue({ list: hits });

      const result = await conversationsApi.search('foo');
      expect(result).toEqual({ hits });
    });
  });
});
