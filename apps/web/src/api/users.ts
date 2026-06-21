import { apiGet, apiPost } from '@/lib/http';
import type {
  PasswordIssueResponse,
  UserResponse,
  UserListResponse,
  CreateUserRequest,
  UserIdRequest,
} from '@agework/shared/api';

export type { UserResponse as User };
export type { PasswordIssueResponse };

export const usersApi = {
  list: (params?: { pageNo?: number; pageSize?: number }) => {
    const query = new URLSearchParams();
    if (params?.pageNo) query.set('pageNo', String(params.pageNo));
    if (params?.pageSize) query.set('pageSize', String(params.pageSize));
    const qs = query.toString();
    return apiGet<UserListResponse>(`/api/v1/admin/users/list${qs ? `?${qs}` : ''}`);
  },

  create: (body: CreateUserRequest) =>
    apiPost<PasswordIssueResponse>('/api/v1/admin/users/create', body),

  approve: (body: UserIdRequest) =>
    apiPost<UserResponse>('/api/v1/admin/users/approve', body),

  update: (id: string, data: { role?: string; status?: 'active' | 'disabled' }) =>
    apiPost<UserResponse>('/api/v1/admin/users/update', { id, ...data }),

  resetPassword: (body: UserIdRequest) =>
    apiPost<PasswordIssueResponse>('/api/v1/admin/users/update-password', body),

  delete: (body: UserIdRequest) =>
    apiPost('/api/v1/admin/users/remove', body),
};
