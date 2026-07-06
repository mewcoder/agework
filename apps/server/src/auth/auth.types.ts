import type { UserSession } from "../user/user.types";
/** 已认证用户的会话身份，挂载在 request.user 上。跨模块公开契约类型。 */
export type JwtUser = UserSession;
