import { apiGet, apiPost } from '@/lib/http';
import type {
  AuthConfigResponse,
  AuthSessionResponse,
  AuthUser,
  LoginRequest,
  RegisterRequest,
  SetupRequest,
  ChangePasswordRequest,
} from '@agework/shared/api';

export const authApi = {
  login: (body: LoginRequest) =>
    apiPost<AuthSessionResponse>('/api/v1/auth/login', body),

  register: (body: RegisterRequest) =>
    apiPost<AuthUser>('/api/v1/auth/register', body),

  setup: (body: SetupRequest) =>
    apiPost<AuthSessionResponse>('/api/v1/auth/setup', body),

  me: () => apiGet<AuthUser>('/api/v1/auth/query'),

  changePassword: (body: ChangePasswordRequest) =>
    apiPost<AuthSessionResponse>('/api/v1/auth/update-password', body),

  // 用 HttpOnly cookie 里的 refresh token 轮换出新的 access token
  refresh: () => apiPost<AuthSessionResponse>('/api/v1/auth/refresh'),

  // 撤销服务端会话并清除 refresh cookie
  logout: () => apiPost<void>('/api/v1/auth/logout'),

  config: () => apiGet<AuthConfigResponse>('/api/v1/auth/config'),
};
