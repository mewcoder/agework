import { UnauthorizedException } from "@nestjs/common";

/**
 * 登录失败的内部原因。对外一律收敛为同一句话，避免泄露
 * 用户是否存在、是否待审批 / 停用 / 临时密码过期等账号状态，堵住枚举。
 * reason 仅用于内部审计 / 日志，不进入 HTTP 响应体。
 */
export type LoginFailureReason =
  | "user_not_found"
  | "locked"
  | "bad_password"
  | "pending"
  | "disabled"
  | "status_invalid"
  | "temp_password_expired";

export const LOGIN_FAILED_MESSAGE = "用户名或密码错误";

export class LoginFailedException extends UnauthorizedException {
  constructor(readonly reason: LoginFailureReason) {
    super(LOGIN_FAILED_MESSAGE);
    // errorName 进结构化日志（filter 的 errorLogFields），保留具体原因供审计，
    // 客户端只看到 getResponse() 里的通用 message。
    this.name = `LoginFailedException(${reason})`;
  }
}
