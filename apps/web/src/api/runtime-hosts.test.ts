import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockApiGet = vi.fn();
const mockApiPost = vi.fn();

vi.mock('@/lib/http', () => ({
  apiGet: (...args: unknown[]) => mockApiGet(...args),
  apiPost: (...args: unknown[]) => mockApiPost(...args),
}));

import { runtimesApi } from './runtimes';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runtimesApi', () => {
  describe('list', () => {
    it('调用 list 端点', async () => {
      mockApiGet.mockResolvedValue({ list: [] });
      await runtimesApi.list();

      expect(mockApiGet).toHaveBeenCalledWith('/api/v1/runtimes/list');
    });
  });

  describe('create', () => {
    it('发送 create 请求', async () => {
      const body = { name: 'mac-studio' };
      mockApiPost.mockResolvedValue({
        runtime: { id: 'rt-1' },
        token: 'secret',
      });

      await runtimesApi.create(body);

      expect(mockApiPost).toHaveBeenCalledWith('/api/v1/admin/runtimes/create', body);
    });
  });

  describe('delete', () => {
    it('发送 delete 请求', async () => {
      await runtimesApi.delete('rt-1');

      expect(mockApiPost).toHaveBeenCalledWith('/api/v1/admin/runtimes/delete', { id: 'rt-1' });
    });
  });
});
