export const USER_DELETED_EVENT = "user.deleted";
export const USER_DISABLED_EVENT = "user.disabled";

/** User 已被删除（软删）。下游据此清理该用户名下的资源。 */
export class UserDeletedEvent {
  constructor(readonly userId: string) {}
}

/** User 已被禁用。下游据此清理该用户名下的资源。 */
export class UserDisabledEvent {
  constructor(readonly userId: string) {}
}
