import { create } from 'zustand';
import type { AuthUser } from '@agework/shared/api';

export type { AuthUser };

interface AuthStore {
  token: string | null;
  user: AuthUser | null;
  authRequired: boolean;        // 从服务端读取，不持久化
  setupRequired: boolean;       // 从服务端读取，不持久化
  appName: string;              // 从服务端读取，不持久化
  configLoaded: boolean;        // auth config 是否已从服务端成功加载
  setAuth: (token: string | null, user: AuthUser) => void;
  setUser: (user: AuthUser) => void;
  setAuthRequired: (v: boolean) => void;
  setSetupRequired: (v: boolean) => void;
  setAppName: (v: string) => void;
  setConfigLoaded: (v: boolean) => void;
  logout: () => void;
}

// access token 只存内存、不持久化：localStorage 会被 XSS 读取，而 access token 短时效（15m）。
// 刷新页面后由 /auth/refresh（HttpOnly cookie 里的 refresh token）静默换取新的 access token。
export const useAuthStore = create<AuthStore>()((set) => ({
  token: null,
  user: null,
  authRequired: true,
  setupRequired: false,
  appName: "AgeWork",
  configLoaded: false,
  setAuth: (token, user) => set({ token, user }),
  setUser: (user) => set({ user }),
  setAuthRequired: (authRequired) => set({ authRequired }),
  setSetupRequired: (setupRequired) => set({ setupRequired }),
  setAppName: (appName) => set({ appName }),
  setConfigLoaded: (configLoaded) => set({ configLoaded }),
  logout: () => set({ token: null, user: null }),
}));
