export const USER_DELETED_EVENT = "user.deleted";
export const USER_DISABLED_EVENT = "user.disabled";
export const USER_PASSWORD_RESET_EVENT = "user.password-reset";

/** User 已被删除（软删）。下游据此清理该用户名下的资源。 */
export class UserDeletedEvent {
  /** 状态写入后返回的 User.sessionVersion,用于 Runtime generation fencing。 */
  constructor(readonly userId: string, readonly sessionVersion: number) {}
}

/** User 已被禁用。下游据此清理该用户名下的资源。 */
export class UserDisabledEvent {
  /** 状态写入后返回的 User.sessionVersion,用于 Runtime generation fencing。 */
  constructor(readonly userId: string, readonly sessionVersion: number) {}
}

/** 管理员已重置该 User 的密码。下游据此撤销其登录会话。 */
export class UserPasswordResetEvent {
  constructor(readonly userId: string) {}
}
