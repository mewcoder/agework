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

      expect(mockApiGet).toHaveBeenCalledWith('/api/v1/admin/workspaces/list');
    });

    it('带分页参数', async () => {
      mockApiGet.mockResolvedValue({ list: [] });
      await workspacesApi.all({ pageNo: 1, pageSize: 20 });

      expect(mockApiGet).toHaveBeenCalledWith('/api/v1/admin/workspaces/list?pageNo=1&pageSize=20');
    });
  });

  describe('create', () => {
    it('发送 create 请求', async () => {
      const body = { name: 'test-workspace', runtimeType: 'native' as const };
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

  describe('listFiles', () => {
    it('调用 files/list 端点带 id 和 path', async () => {
      mockApiGet.mockResolvedValue({ path: 'src', list: [], truncated: false });
      await workspacesApi.listFiles('ws-1', 'src');

      expect(mockApiGet).toHaveBeenCalledWith('/api/v1/workspaces/files/list?id=ws-1&path=src');
    });

    it('根目录时不带 path 参数', async () => {
      mockApiGet.mockResolvedValue({ path: '', list: [], truncated: false });
      await workspacesApi.listFiles('ws-1', '');

      expect(mockApiGet).toHaveBeenCalledWith('/api/v1/workspaces/files/list?id=ws-1');
    });
  });

  describe('readFile', () => {
    it('调用 files/read 端点带 id 和 path', async () => {
      mockApiGet.mockResolvedValue({
        path: 'src/app.ts',
        encoding: 'utf8',
        content: 'console.log(1)',
        size: 14,
        truncated: false,
      });
      await workspacesApi.readFile('ws-1', 'src/app.ts');

      expect(mockApiGet).toHaveBeenCalledWith('/api/v1/workspaces/files/read?id=ws-1&path=src%2Fapp.ts');
    });
  });
});
