import type { PasswordKind, UserRole, UserStatus } from "./users";

/** 登录态用户（auth/query、login 返回），比 UserResponse 精简。 */
export type AuthUser = {
  id: string;
  username: string;
  /** 展示名（昵称），可空，UI 回退到 username。 */
  nickname?: string | null;
  role: UserRole;
  status: UserStatus;
  mustChangePassword: boolean;
  passwordKind?: PasswordKind;
  passwordExpiresAt?: string | null;
  sessionVersion?: number;
};

export type AuthSessionResponse = {
  token: string;
  user: AuthUser;
};

export type AuthConfigResponse = {
  authRequired: boolean;
  appName: string;
  registrationMode: "approval";
  setupRequired: boolean;
};

export type LoginRequest = { username: string; password: string };
export type RegisterRequest = { username: string; password: string };
export type SetupRequest = { newPassword: string };
export type ChangePasswordRequest = {
  currentPassword?: string;
  newPassword: string;
};
