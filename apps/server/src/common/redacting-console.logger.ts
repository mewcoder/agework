import { ConsoleLogger } from "@nestjs/common";
import { redactLogValue, safeLogJson } from "./logging";

/**
 * 内置 ConsoleLogger 的脱敏包装：任何经过日志的 message / 参数都统一过
 * redactLogValue，集中屏蔽 apiKey / token / cookie 等敏感字段，
 * 调用点不必再手写 safeLogJson。通过 main.ts 的 app.useLogger 全局接入后，
 * 所有 `new Logger(ctx)` 实例都会路由到这里。
 *
 * 对象参数额外经 safeLogJson 序列化为单行 JSON 字符串，避免 NestJS 文本模式
 * 下对象被 util.inspect 展开成多行 `Object(n) { ... }`，保证一条日志一行。
 */
export class RedactingConsoleLogger extends ConsoleLogger {
  log(message: unknown, ...optionalParams: unknown[]): void {
    super.log(toLogString(message), ...optionalParams.map(toLogString));
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    super.error(toLogString(message), ...optionalParams.map(toLogString));
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    super.warn(toLogString(message), ...optionalParams.map(toLogString));
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    super.debug(toLogString(message), ...optionalParams.map(toLogString));
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    super.verbose(toLogString(message), ...optionalParams.map(toLogString));
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    super.fatal(toLogString(message), ...optionalParams.map(toLogString));
  }
}

/**
 * 统一日志序列化：字符串走脱敏正则保持原文，对象/其他类型序列化为单行
 * JSON 字符串（先脱敏再 stringify）。这样 NestJS 文本模式下对象不会被
 * util.inspect 展开成多行，保证一条日志占一行。
 */
function toLogString(value: unknown): unknown {
  if (typeof value === "string") return redactLogValue(value);
  if (value === undefined || value === null) return value;
  return safeLogJson(value);
}
