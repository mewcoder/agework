import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockApiGet = vi.fn();
const mockApiPost = vi.fn();

vi.mock('@/lib/http', () => ({
  apiGet: (...args: unknown[]) => mockApiGet(...args),
  apiPost: (...args: unknown[]) => mockApiPost(...args),
}));

import { authApi } from './auth';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('authApi', () => {
  describe('login', () => {
    it('调用 login 端点', async () => {
      const body = { username: 'admin', password: 'secret' };
      await authApi.login(body);

      expect(mockApiPost).toHaveBeenCalledWith('/api/v1/auth/login', body);
    });
  });

  describe('register', () => {
    it('调用 register 端点', async () => {
      const body = { username: 'newuser', password: 'secret' };
      await authApi.register(body);

      expect(mockApiPost).toHaveBeenCalledWith('/api/v1/auth/register', body);
    });
  });

  describe('setup', () => {
    it('调用 setup 端点', async () => {
      const body = { newPassword: 'admin123' };
      await authApi.setup(body);

      expect(mockApiPost).toHaveBeenCalledWith('/api/v1/auth/setup', body);
    });
  });

  describe('me', () => {
    it('调用 query 端点', async () => {
      await authApi.me();

      expect(mockApiGet).toHaveBeenCalledWith('/api/v1/auth/query');
    });
  });

  describe('changePassword', () => {
    it('调用 update-password 端点', async () => {
      const body = { oldPassword: 'old', newPassword: 'new' };
      await authApi.changePassword(body);

      expect(mockApiPost).toHaveBeenCalledWith('/api/v1/auth/update-password', body);
    });
  });

  describe('refresh', () => {
    it('调用 refresh 端点', async () => {
      await authApi.refresh();

      expect(mockApiPost).toHaveBeenCalledWith('/api/v1/auth/refresh');
    });
  });

  describe('logout', () => {
    it('调用 logout 端点', async () => {
      await authApi.logout();

      expect(mockApiPost).toHaveBeenCalledWith('/api/v1/auth/logout');
    });
  });

  describe('config', () => {
    it('调用 config 端点', async () => {
      await authApi.config();

      expect(mockApiGet).toHaveBeenCalledWith('/api/v1/auth/config');
    });
  });
});
