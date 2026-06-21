import type { PaginatedListResponse } from "../common";

export type UserRole = "super_admin" | "admin" | "user";
export type UserStatus = "pending" | "active" | "disabled";
export type PasswordKind = "user_set" | "initial" | "temporary";

/** /api/v1/admin/users/list 的条目（管理视角的完整形状）。 */
export type UserResponse = {
  id: string;
  username: string;
  role: UserRole;
  status: UserStatus;
  mustChangePassword: boolean;
  passwordKind: PasswordKind;
  passwordExpiresAt: string | null;
  approvedAt: string | null;
  approvedById: string | null;
  lastLoginAt: string | null;
  /** ISO 8601 */
  createdAt: string;
};

export type PasswordIssueResponse = {
  user: UserResponse;
  temporaryPassword: string;
  passwordExpiresAt: string;
};

export type CreateUserRequest = {
  username: string;
  /** DTO 现状为宽松 string，收紧为 UserRole 属行为变更，见"后续工作"。 */
  role?: string;
};

export type UpdateUserRequest = {
  id: string;
  role?: string;
  status?: string;
};

export type UserIdRequest = { id: string };

export type UserListResponse = PaginatedListResponse<UserResponse>;
