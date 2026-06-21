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

  config: () => apiGet<AuthConfigResponse>('/api/v1/auth/config'),
};
