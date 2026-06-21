import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AuthUser } from '@agework/shared/api';

export type { AuthUser };

interface AuthStore {
  token: string | null;
  user: AuthUser | null;
  authRequired: boolean;        // 从服务端读取，不持久化
  setupRequired: boolean;       // 从服务端读取，不持久化
  appName: string;              // 从服务端读取，不持久化
  setAuth: (token: string | null, user: AuthUser) => void;
  setUser: (user: AuthUser) => void;
  setAuthRequired: (v: boolean) => void;
  setSetupRequired: (v: boolean) => void;
  setAppName: (v: string) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthStore>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      authRequired: true,
      setupRequired: false,
      appName: "AgeWork",
      setAuth: (token, user) => set({ token, user }),
      setUser: (user) => set({ user }),
      setAuthRequired: (authRequired) => set({ authRequired }),
      setSetupRequired: (setupRequired) => set({ setupRequired }),
      setAppName: (appName) => set({ appName }),
      logout: () => set({ token: null, user: null }),
    }),
    {
      name: 'agework-auth',
      partialize: (state) => ({ token: state.token, user: state.user }),
    },
  ),
);
