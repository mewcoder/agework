import { describe, it, expect, beforeEach } from 'vitest';
import { useAuthStore } from './auth-store';
import type { AuthUser } from '@agework/shared/api';

const adminUser: AuthUser = { id: 'u1', username: 'admin', role: 'admin', status: 'active', mustChangePassword: false };
const memberUser: AuthUser = { id: 'u2', username: 'member', role: 'user', status: 'active', mustChangePassword: false };

beforeEach(() => {
  localStorage.clear();
  useAuthStore.setState({
    token: null,
    user: null,
    authRequired: true,
    setupRequired: false,
    appName: 'AgeWork',
  });
});

describe('useAuthStore', () => {
  it('初始状态为未登录', () => {
    expect(useAuthStore.getState().token).toBeNull();
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().authRequired).toBe(true);
    expect(useAuthStore.getState().setupRequired).toBe(false);
    expect(useAuthStore.getState().appName).toBe('AgeWork');
  });

  it('setAuth 同时设置 token 和 user', () => {
    useAuthStore.getState().setAuth('token-123', adminUser);

    expect(useAuthStore.getState().token).toBe('token-123');
    expect(useAuthStore.getState().user).toEqual(adminUser);
  });

  it('setAuth 接受 null token', () => {
    useAuthStore.getState().setAuth(null, adminUser);

    expect(useAuthStore.getState().token).toBeNull();
    expect(useAuthStore.getState().user).toEqual(adminUser);
  });

  it('setUser 只更新 user', () => {
    useAuthStore.getState().setUser(memberUser);

    expect(useAuthStore.getState().user).toEqual(memberUser);
    expect(useAuthStore.getState().token).toBeNull();
  });

  it('logout 清除 token 和 user', () => {
    useAuthStore.getState().setAuth('token-123', adminUser);
    useAuthStore.getState().logout();

    expect(useAuthStore.getState().token).toBeNull();
    expect(useAuthStore.getState().user).toBeNull();
  });

  it('setAuthRequired 更新 authRequired', () => {
    expect(useAuthStore.getState().authRequired).toBe(true);
    useAuthStore.getState().setAuthRequired(false);
    expect(useAuthStore.getState().authRequired).toBe(false);
    useAuthStore.getState().setAuthRequired(true);
    expect(useAuthStore.getState().authRequired).toBe(true);
  });

  it('setSetupRequired 更新 setupRequired', () => {
    expect(useAuthStore.getState().setupRequired).toBe(false);
    useAuthStore.getState().setSetupRequired(true);
    expect(useAuthStore.getState().setupRequired).toBe(true);
  });

  it('setAppName 更新 appName', () => {
    useAuthStore.getState().setAppName('MyApp');
    expect(useAuthStore.getState().appName).toBe('MyApp');
  });

  it('不把 token/user 持久化到 localStorage（access token 仅存内存）', () => {
    useAuthStore.getState().setAuth('token-123', adminUser);
    useAuthStore.getState().setAuthRequired(false);

    expect(localStorage.getItem('agework-auth')).toBeNull();
  });
});
