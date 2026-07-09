import { ConsoleLogger } from "@nestjs/common";
import { redactLogValue } from "./logging";

/**
 * 内置 ConsoleLogger 的脱敏包装：任何经过日志的 message / 参数都统一过
 * redactLogValue，集中屏蔽 apiKey / token / cookie 等敏感字段，
 * 调用点不必再手写 safeLogJson。通过 main.ts 的 app.useLogger 全局接入后，
 * 所有 `new Logger(ctx)` 实例都会路由到这里。
 */
export class RedactingConsoleLogger extends ConsoleLogger {
  log(message: unknown, ...optionalParams: unknown[]): void {
    super.log(
      redactLogValue(message),
      ...optionalParams.map((p) => redactLogValue(p))
    );
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    super.error(
      redactLogValue(message),
      ...optionalParams.map((p) => redactLogValue(p))
    );
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    super.warn(
      redactLogValue(message),
      ...optionalParams.map((p) => redactLogValue(p))
    );
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    super.debug(
      redactLogValue(message),
      ...optionalParams.map((p) => redactLogValue(p))
    );
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    super.verbose(
      redactLogValue(message),
      ...optionalParams.map((p) => redactLogValue(p))
    );
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    super.fatal(
      redactLogValue(message),
      ...optionalParams.map((p) => redactLogValue(p))
    );
  }
}
