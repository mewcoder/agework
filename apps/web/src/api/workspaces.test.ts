import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockApiGet = vi.fn();
const mockApiPost = vi.fn();

vi.mock('@/lib/http', () => ({
  apiGet: (...args: unknown[]) => mockApiGet(...args),
  apiPost: (...args: unknown[]) => mockApiPost(...args),
}));

import { workspacesApi } from './workspaces';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('workspacesApi', () => {
  describe('list', () => {
    it('调用 list 端点', async () => {
      mockApiGet.mockResolvedValue({ list: [] });
      await workspacesApi.list();

      expect(mockApiGet).toHaveBeenCalledWith('/api/v1/workspaces/list');
    });
  });

  describe('capabilities', () => {
    it('调用 capabilities 端点', async () => {
      mockApiGet.mockResolvedValue({ canSelectLocalDirectory: true });
      await workspacesApi.capabilities();

      expect(mockApiGet).toHaveBeenCalledWith('/api/v1/workspaces/capabilities');
    });
  });

  describe('all', () => {
    it('无参数时调用 base URL', async () => {
      mockApiGet.mockResolvedValue({ list: [] });
      await workspacesApi.all();

      expect(mockApiGet).toHaveBeenCalledWith('/api/v1/admin/workspaces/all');
    });

    it('带分页参数', async () => {
      mockApiGet.mockResolvedValue({ list: [] });
      await workspacesApi.all({ pageNo: 1, pageSize: 20 });

      expect(mockApiGet).toHaveBeenCalledWith('/api/v1/admin/workspaces/all?pageNo=1&pageSize=20');
    });
  });

  describe('create', () => {
    it('发送 create 请求', async () => {
      const body = { name: 'test-workspace', runtimeType: 'local' as const };
      mockApiPost.mockResolvedValue({ id: 'ws-1' });

      await workspacesApi.create(body);

      expect(mockApiPost).toHaveBeenCalledWith('/api/v1/workspaces/create', body);
    });
  });

  describe('rename', () => {
    it('发送 update 请求', async () => {
      const data = { name: 'renamed' };
      await workspacesApi.rename('ws-1', data);

      expect(mockApiPost).toHaveBeenCalledWith('/api/v1/workspaces/update', { id: 'ws-1', name: 'renamed' });
    });
  });

  describe('delete', () => {
    it('发送 remove 请求', async () => {
      await workspacesApi.delete('ws-1');

      expect(mockApiPost).toHaveBeenCalledWith('/api/v1/workspaces/remove', { id: 'ws-1' });
    });
  });
});
