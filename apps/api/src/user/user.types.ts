/**
 * User 领域后端跨边界契约类型。
 * UserSession 由 auth 的 @CurrentUser 装饰器与 UserService 共享，
 * 作为已认证请求挂载在 request.user 上的会话身份。
 */
export type UserSession = {
  userId: string;
  username: string;
  role: string;
  status: string;
  mustChangePassword: boolean;
  sessionVersion: number;
};
