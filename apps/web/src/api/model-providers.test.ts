import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockApiGet = vi.fn();
const mockApiPost = vi.fn();

vi.mock('@/lib/http', () => ({
  apiGet: (...args: unknown[]) => mockApiGet(...args),
  apiPost: (...args: unknown[]) => mockApiPost(...args),
}));

import { modelProvidersApi } from './model-providers';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('modelProvidersApi', () => {
  describe('list', () => {
    it('传递 agentType 参数', async () => {
      mockApiGet.mockResolvedValue({ list: [] });
      await modelProvidersApi.list('claude');

      expect(mockApiGet).toHaveBeenCalledWith('/api/v1/model-providers/list?agentType=claude');
    });
  });

  describe('adminList', () => {
    it('使用 admin 端点', async () => {
      mockApiGet.mockResolvedValue({ list: [] });
      await modelProvidersApi.adminList();

      expect(mockApiGet).toHaveBeenCalledWith('/api/v1/admin/model-providers/list');
    });
  });

  describe('create', () => {
    it('调用 admin create 端点', async () => {
      const body = {
        apiFormat: 'anthropic' as const,
        name: 'test-provider',
        providerConfig: { baseUrl: 'https://example.com', apiKey: 'sk-test', models: ['m'], extraConfig: {} },
      };
      await modelProvidersApi.create(body);

      expect(mockApiPost).toHaveBeenCalledWith('/api/v1/admin/model-providers/create', body);
    });
  });

  describe('update', () => {
    it('调用 admin update 端点', async () => {
      const body = {
        id: 'mp-1',
        name: 'updated',
        providerConfig: { baseUrl: 'https://example.com', apiKey: 'sk-test', models: ['m'], extraConfig: {} },
      };
      await modelProvidersApi.update(body);

      expect(mockApiPost).toHaveBeenCalledWith('/api/v1/admin/model-providers/update', body);
    });
  });

  describe('setEnabled', () => {
    it('调用 admin set-enabled 端点', async () => {
      const body = { id: 'mp-1', isEnabled: true };
      await modelProvidersApi.setEnabled(body);

      expect(mockApiPost).toHaveBeenCalledWith('/api/v1/admin/model-providers/set-enabled', body);
    });
  });

  describe('test', () => {
    it('调用 ping 端点', async () => {
      const body = { id: 'mp-1' };
      await modelProvidersApi.test(body);

      expect(mockApiPost).toHaveBeenCalledWith('/api/v1/model-providers/ping', body);
    });
  });

  describe('adminTest', () => {
    it('调用 admin ping 端点', async () => {
      const body = { id: 'mp-1' };
      await modelProvidersApi.adminTest(body);

      expect(mockApiPost).toHaveBeenCalledWith('/api/v1/admin/model-providers/ping', body);
    });
  });

  describe('delete', () => {
    it('调用 admin remove 端点', async () => {
      const body = { id: 'mp-1' };
      await modelProvidersApi.delete(body);

      expect(mockApiPost).toHaveBeenCalledWith('/api/v1/admin/model-providers/remove', body);
    });
  });
});
