import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockApiGet = vi.fn();
const mockApiPost = vi.fn();

vi.mock('@/lib/http', () => ({
  apiGet: (...args: unknown[]) => mockApiGet(...args),
  apiPost: (...args: unknown[]) => mockApiPost(...args),
}));

import { runtimeHostsApi } from './runtime-hosts';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runtimeHostsApi', () => {
  describe('list', () => {
    it('调用 list 端点', async () => {
      mockApiGet.mockResolvedValue({ list: [] });
      await runtimeHostsApi.list();

      expect(mockApiGet).toHaveBeenCalledWith('/api/v1/runtime-hosts/list');
    });
  });

  describe('create', () => {
    it('发送 create 请求', async () => {
      const body = { name: 'mac-studio' };
      mockApiPost.mockResolvedValue({
        runtime: { id: 'rt-1' },
        token: 'secret',
      });

      await runtimeHostsApi.create(body);

      expect(mockApiPost).toHaveBeenCalledWith('/api/v1/admin/runtime-hosts/create', body);
    });
  });

  describe('delete', () => {
    it('发送 delete 请求', async () => {
      await runtimeHostsApi.delete('rt-1');

      expect(mockApiPost).toHaveBeenCalledWith('/api/v1/admin/runtime-hosts/delete', { id: 'rt-1' });
    });
  });
});
